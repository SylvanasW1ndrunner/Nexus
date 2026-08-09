import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStoreError,
  ProjectArtifactStore,
  type ArtifactJournalContext,
} from '../src/artifacts/project-artifact-store.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';

const temporaryDirectories: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('ProjectArtifactStore', () => {
  it('streams, verifies, commits and reopens a content-addressed project artifact', async () => {
    const fixture = await createFixture();
    const content = Buffer.from('hello 世界'.repeat(32_768));
    const staged = await fixture.store.stage({
      mediaType: 'text/plain; charset=utf-8',
      source: chunks(content, 1_031),
      expectedChecksum: sha256(content),
    });

    expect(staged).toMatchObject({
      projectId: 'project-a',
      checksum: sha256(content),
      byteSize: content.byteLength,
      mediaType: 'text/plain; charset=utf-8',
      availability: 'staged',
    });
    expect(staged.artifactId).not.toContain('..');
    expect(JSON.stringify(staged)).not.toContain(fixture.directory);

    const committed = await fixture.store.commit({
      staged,
      journal: fixture.context('artifact-commit-a'),
      summary: 'A bounded streamed fixture',
    });
    expect(committed.availability).toBe('available');
    expect(Buffer.from(await new Response(await fixture.store.open(committed)).arrayBuffer()))
      .toEqual(content);

    const reopened = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: new SqliteAgentJournal({ filePath: fixture.journalPath }),
    });
    expect(Buffer.from(await new Response(await reopened.open(committed)).arrayBuffer()))
      .toEqual(content);
    const facts = await fixture.journal.readProject('project-a', 0, 100);
    expect(facts.filter(({ type }) => type === 'artifact.created')).toMatchObject([
      {
        projectId: 'project-a',
        runId: fixture.runId,
        schemaVersion: 2,
        payload: {
          artifactId: committed.artifactId,
          handle: committed.handle,
          checksum: committed.checksum,
          byteSize: committed.byteSize,
          mediaType: committed.mediaType,
          availability: 'available',
        },
      },
    ]);
  });

  it('is idempotent under concurrent commit and recovers Journal-before-promotion crashes', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'application/octet-stream',
      source: chunks(Buffer.from('same-content')),
    });
    const crashing = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
      crashAt: 'after-journal-before-promotion',
    });
    const input = {
      staged,
      journal: fixture.context('artifact-crash-commit'),
      summary: 'recoverable',
    } as const;

    await expect(crashing.commit(input)).rejects.toMatchObject({
      code: 'INJECTED_CRASH',
    });
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(1);

    const first = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
    });
    const second = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
    });
    const [left, right] = await Promise.all([first.commit(input), second.commit(input)]);
    expect(left).toEqual(right);
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(1);
    expect(await readStream(await first.open(left))).toEqual(Buffer.from('same-content'));
  });

  it('upcasts v1 artifact facts to explicit unavailable handles without fabricated bytes', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('legacy-content')),
    });
    await fixture.store.commit({
      staged,
      journal: fixture.context('legacy-artifact-commit'),
      summary: 'legacy summary',
    });

    const database = new DatabaseSync(fixture.journalPath);
    try {
      database.prepare(`
        UPDATE agent_events
        SET schema_version = 1, payload_json = ?
        WHERE project_id = ? AND event_type = 'artifact.created'
      `).run(JSON.stringify({
        artifactId: staged.artifactId,
        mediaType: staged.mediaType,
        summary: 'legacy summary',
      }), 'project-a');
    } finally {
      database.close();
    }

    const fact = (await fixture.journal.readProject('project-a', 0, 100))
      .find(({ type }) => type === 'artifact.created');
    expect(fact).toMatchObject({
      schemaVersion: 2,
      payload: {
        artifactId: staged.artifactId,
        handle: `legacy-agent-artifact:${staged.artifactId}`,
        checksum: null,
        byteSize: null,
        availability: 'legacy-unavailable',
      },
    });
    if (fact?.type !== 'artifact.created' || fact.payload.availability !== 'legacy-unavailable') {
      throw new Error('Expected a legacy-unavailable artifact fact.');
    }
    await expect(fixture.store.open({
      schemaVersion: 1,
      artifactId: fact.payload.artifactId,
      handle: fact.payload.handle,
      projectId: fact.projectId,
      checksum: null,
      byteSize: null,
      mediaType: fact.payload.mediaType,
      availability: 'legacy-unavailable',
    })).rejects.toMatchObject({ code: 'LEGACY_UNAVAILABLE' });
  });

  it('rejects cross-project, conflicting, corrupt, expired and deleted handles with typed errors', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('integrity-sensitive')),
    });
    const committed = await fixture.store.commit({
      staged,
      journal: fixture.context('artifact-integrity-commit'),
      summary: 'integrity fixture',
    });

    const otherProject = new ProjectArtifactStore({
      projectId: 'project-b',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
    });
    await expect(otherProject.open(committed)).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    await expect(
      fixture.store.commit({
        staged: { ...staged, mediaType: 'application/json' },
        journal: fixture.context('artifact-conflict-commit'),
        summary: 'conflict',
      }),
    ).rejects.toMatchObject({ code: 'METADATA_CONFLICT' });

    const objectPath = await findFileContaining(fixture.artifactRoot, 'integrity-sensitive');
    await writeFile(objectPath, 'corrupted');
    await expect(fixture.store.open(committed)).rejects.toMatchObject({ code: 'CORRUPT' });

    const expiring = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('expires')),
      expiresAt: '2026-08-09T00:00:00.000Z',
    });
    const expired = await fixture.store.commit({
      staged: expiring,
      journal: fixture.context('artifact-expiring-commit'),
      summary: 'expires',
    });
    await fixture.store.expire(expired, fixture.context('artifact-expire'));
    await expect(fixture.store.open(expired)).rejects.toMatchObject({ code: 'EXPIRED' });

    const deleting = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('deletes')),
    });
    const deleted = await fixture.store.commit({
      staged: deleting,
      journal: fixture.context('artifact-deleting-commit'),
      summary: 'deletes',
    });
    await fixture.store.delete(deleted, fixture.context('artifact-delete'));
    await expect(fixture.store.open(deleted)).rejects.toMatchObject({ code: 'DELETED' });
  });

  it('rejects traversal IDs and checksum/size mismatch, and removes failed partial stages', async () => {
    const fixture = await createFixture();
    await expect(fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('wrong checksum')),
      expectedChecksum: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('wrong size')),
      expectedByteSize: 1,
    })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });

    const traversal = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
      createId: () => '..\\..\\outside',
    });
    await expect(traversal.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('blocked')),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    async function* failingSource(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(Buffer.from('partial'));
      throw new Error('source failed');
    }
    await expect(fixture.store.stage({
      mediaType: 'application/octet-stream',
      source: failingSource(),
    })).rejects.toMatchObject({ code: 'STAGE_FAILED' });
    expect((await readdir(join(fixture.artifactRoot, 'staged')))
      .filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('collects only expired unreferenced staged bytes and never a committed referenced object', async () => {
    const fixture = await createFixture();
    const orphan = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('orphan')),
      expiresAt: '2026-08-09T00:00:00.000Z',
    });
    const retainedStage = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('retained')),
      expiresAt: '2026-08-09T00:00:00.000Z',
    });
    const retained = await fixture.store.commit({
      staged: retainedStage,
      journal: fixture.context('artifact-retained-commit'),
      summary: 'retained',
    });

    const report = await fixture.store.collectGarbage(new Date('2026-08-10T00:00:00.000Z'));
    expect(report).toMatchObject({ stagedObjectsDeleted: 1, committedObjectsDeleted: 0 });
    await expect(fixture.store.open({
      ...orphan,
      availability: 'available',
      createdAt: orphan.stagedAt,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readStream(await fixture.store.open(retained))).toEqual(Buffer.from('retained'));
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-artifact-store-'));
  temporaryDirectories.push(directory);
  const journalPath = join(directory, 'state.db');
  const artifactRoot = join(directory, 'artifacts');
  const journal = new SqliteAgentJournal({
    filePath: journalPath,
    now: () => '2026-08-09T12:00:00.000Z',
  });
  const created = await journal.createRun({
    projectId: 'project-a',
    sessionId: 'session-a',
    clientRequestId: 'artifact-fixture',
    input: { text: 'create an artifact' },
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a',
    runId: created.runId,
    ownerId: 'artifact-worker',
    ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a',
    sessionId: 'session-a',
    runId: created.runId,
    commandId: 'artifact-start-run',
    lease: leaseRef,
    expectedRunRevision: 1,
  });
  const store = new ProjectArtifactStore({ projectId: 'project-a', rootDir: artifactRoot, journal });
  const context = (commandId: string): ArtifactJournalContext => ({
    sessionId: 'session-a',
    runId: created.runId,
    commandId,
    lease: leaseRef,
    expectedRunRevision: 2,
  });
  return {
    directory,
    artifactRoot,
    journalPath,
    journal,
    runId: created.runId,
    store,
    context,
  };
}

async function* chunks(content: Buffer, size = content.byteLength || 1): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < content.byteLength; offset += size) {
    yield await Promise.resolve(content.subarray(offset, Math.min(offset + size, content.byteLength)));
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function findFileContaining(root: string, needle: string): Promise<string> {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const candidate = join(entry.parentPath, entry.name);
    if ((await readFile(candidate)).includes(needle)) return candidate;
  }
  throw new ArtifactStoreError('NOT_FOUND', 'Fixture object was not found.');
}
