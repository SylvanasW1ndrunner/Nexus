import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
import type { AgentJournal, JournalCommand } from '../src/events/agent-journal.js';
import type { AgentEvent } from '../src/events/agent-event.js';
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
        schemaVersion: 3,
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

  it('creates independent references for equal content across Runs and isolates lifecycle', async () => {
    const fixture = await createFixture();
    const other = await createRunContext(fixture.journal, 'artifact-second-run');
    const content = Buffer.from('shared-content');
    const firstStage = await fixture.store.stage({ mediaType: 'text/plain', source: chunks(content) });
    const secondStage = await fixture.store.stage({ mediaType: 'text/plain', source: chunks(content) });

    expect(secondStage.checksum).toBe(firstStage.checksum);
    expect(secondStage.artifactId).not.toBe(firstStage.artifactId);
    expect(secondStage.handle).not.toBe(firstStage.handle);

    const first = await fixture.store.commit({
      staged: firstStage,
      journal: fixture.context('shared-first-commit'),
      summary: 'first reference',
    });
    const second = await fixture.store.commit({
      staged: secondStage,
      journal: other.context('shared-second-commit'),
      summary: 'second reference',
    });
    await fixture.store.expire(first, fixture.context('shared-first-expire'));

    await expect(fixture.store.open(first)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(await readStream(await fixture.store.open(second))).toEqual(content);
  });

  it('serializes distinct-command concurrent commits of one reference into one created fact', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'application/octet-stream',
      source: chunks(Buffer.from('one-reference')),
    });
    const left = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
    });
    const right = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
    });
    const [first, second] = await Promise.all([
      left.commit({
        staged,
        journal: fixture.context('distinct-command-left'),
        summary: 'same reference',
      }),
      right.commit({
        staged,
        journal: fixture.context('distinct-command-right'),
        summary: 'same reference',
      }),
    ]);

    expect(second).toEqual(first);
    const created = (await fixture.journal.readProject('project-a', 0, 100))
      .filter(({ type, payload }) => type === 'artifact.created' &&
        payload.artifactId === staged.artifactId);
    expect(created).toHaveLength(1);
  });

  it('includes summary in artifact fact idempotency and conflict comparison', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'text/plain', source: chunks(Buffer.from('summary-sensitive')),
    });
    const first = await fixture.store.commit({
      staged, journal: fixture.context('summary-first'), summary: 'exact summary',
    });
    await expect(fixture.store.commit({
      staged, journal: fixture.context('summary-replay'), summary: 'exact summary',
    })).resolves.toEqual(first);
    await expect(fixture.store.commit({
      staged, journal: fixture.context('summary-conflict'), summary: 'different summary',
    })).rejects.toMatchObject({ code: 'JOURNAL_REFERENCE_CONFLICT' });
  });

  it('verifies and streams one file descriptor across deterministic pathname replacement', async () => {
    const fixture = await createFixture();
    const original = Buffer.from('descriptor-stable-original');
    const replacement = Buffer.from('descriptor-stable-replaced');
    const staged = await fixture.store.stage({ mediaType: 'text/plain', source: chunks(original) });
    const committed = await fixture.store.commit({
      staged, journal: fixture.context('descriptor-commit'), summary: 'descriptor stable',
    });
    const objectPath = await findFileContaining(fixture.artifactRoot, original.toString('utf8'));
    let replaced = false;
    const replacingStore = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
      afterOpenVerified: async (verifiedPath) => {
        expect(verifiedPath).toBe(objectPath);
        if (replaced) return;
        replaced = true;
        await rename(objectPath, `${objectPath}.verified`);
        await writeFile(objectPath, replacement);
      },
    });
    expect(await readStream(await replacingStore.open(committed))).toEqual(original);
    expect(replaced).toBe(true);
    await expect(fixture.store.open(committed)).rejects.toMatchObject({ code: 'CORRUPT' });

    await rm(objectPath, { force: true });
    await mkdir(objectPath);
    await expect(fixture.store.open(committed)).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('holds a cross-process-safe mutation gate from verified commit bytes through promotion against GC', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'text/plain',
      source: chunks(Buffer.from('commit-gc-race')),
      expiresAt: '2026-08-09T11:00:00.000Z',
    });
    let signalVerified = (): void => undefined;
    const verified = new Promise<void>((resolve) => { signalVerified = resolve; });
    let releaseCommit = (): void => undefined;
    const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const committingStore = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
      afterCommitBytesVerified: async () => {
        signalVerified();
        await release;
      },
    });
    const commit = committingStore.commit({
      staged, journal: fixture.context('commit-gc-race'), summary: 'commit vs gc',
    });
    const reachedBarrier = await Promise.race([
      verified.then(() => true),
      delay(500).then(() => false),
    ]);
    expect(reachedBarrier).toBe(true);

    const impatientGc = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
      mutationGateTimeoutMs: 100,
    });
    await expect(impatientGc.collectGarbage(new Date('2026-08-09T13:00:00.000Z')))
      .rejects.toMatchObject({ code: 'STORE_BUSY' });

    let gcSettled = false;
    const gcStore = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
    });
    const gc = gcStore.collectGarbage(new Date('2026-08-09T13:00:00.000Z'))
      .finally(() => { gcSettled = true; });
    await delay(100);
    expect(gcSettled).toBe(false);
    releaseCommit();
    await expect(commit).resolves.toMatchObject({ artifactId: staged.artifactId });
    await expect(gc).resolves.toMatchObject({ committedObjectsDeleted: 1 });
    expect((await fixture.journal.readProject('project-a', 0, 100))
      .filter(({ type, payload }) => type === 'artifact.created' &&
        payload.artifactId === staged.artifactId)).toHaveLength(1);
  });

  it('stops legacy duplicate artifact facts with a typed migration conflict', async () => {
    const fixture = await createFixture();
    const staged = await fixture.store.stage({
      mediaType: 'text/plain', source: chunks(Buffer.from('legacy-duplicate')),
    });
    await fixture.store.commit({
      staged, journal: fixture.context('legacy-duplicate-seed'), summary: 'seed',
    });
    const database = new DatabaseSync(fixture.journalPath);
    try {
      database.exec('DROP INDEX idx_agent_events_artifact_reference');
      database.exec(`
        INSERT INTO agent_events (
          project_id, sequence, event_id, schema_version, session_id, run_id,
          turn_id, parent_event_id, invocation_id, attempt_id, event_type,
          occurred_at, payload_json, audience_json, persistence
        )
        SELECT project_id, sequence + 1000, event_id || '-duplicate', schema_version,
          session_id, run_id, turn_id, parent_event_id, invocation_id, attempt_id,
          event_type, occurred_at, payload_json, audience_json, persistence
        FROM agent_events WHERE event_type = 'artifact.created'
      `);
    } finally {
      database.close();
    }

    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    await expect(reopened.readProject('project-a', 0, 100))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
  });

  it('expires committed TTL references independently and retains shared blobs until unreferenced', async () => {
    const fixture = await createFixture();
    const other = await createRunContext(fixture.journal, 'artifact-ttl-run');
    const content = Buffer.from('ttl-shared-content');
    const firstStage = await fixture.store.stage({
      mediaType: 'text/plain', source: chunks(content), expiresAt: '2026-08-09T13:00:00.000Z',
    });
    const secondStage = await fixture.store.stage({
      mediaType: 'text/plain', source: chunks(content), expiresAt: '2026-08-09T15:00:00.000Z',
    });
    const first = await fixture.store.commit({
      staged: firstStage, journal: fixture.context('ttl-first'), summary: 'short TTL',
    });
    const second = await fixture.store.commit({
      staged: secondStage, journal: other.context('ttl-second'), summary: 'long TTL',
    });
    const atFourteen = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
      now: () => '2026-08-09T14:00:00.000Z',
    });

    await expect(atFourteen.open(first)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(await readStream(await atFourteen.open(second))).toEqual(content);
    expect(await atFourteen.collectGarbage(new Date('2026-08-09T14:00:00.000Z')))
      .toMatchObject({ committedObjectsDeleted: 1, bytesDeleted: 0 });
    expect(await readStream(await atFourteen.open(second))).toEqual(content);

    const atSixteen = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: fixture.artifactRoot, journal: fixture.journal,
      now: () => '2026-08-09T16:00:00.000Z',
    });
    expect(await atSixteen.collectGarbage(new Date('2026-08-09T16:00:00.000Z')))
      .toMatchObject({ committedObjectsDeleted: 1, bytesDeleted: content.byteLength });
    await expect(atSixteen.open(second)).rejects.toMatchObject({ code: 'EXPIRED' });

    const facts = (await fixture.journal.readProject('project-a', 0, 100))
      .filter((event): event is Extract<AgentEvent, { type: 'artifact.created' }> =>
        event.type === 'artifact.created');
    const firstFact = facts.find(({ payload }) => payload.artifactId === first.artifactId);
    const secondFact = facts.find(({ payload }) => payload.artifactId === second.artifactId);
    expect(firstFact?.payload.expiresAt).toBe('2026-08-09T13:00:00.000Z');
    expect(secondFact?.payload.expiresAt).toBe('2026-08-09T15:00:00.000Z');
  });

  it('loops partial file writes, rejects staged-byte tamper before Journal, and rejects forged paths', async () => {
    const fixture = await createFixture();
    let writes = 0;
    const partialWriter = new ProjectArtifactStore({
      projectId: 'project-a',
      rootDir: fixture.artifactRoot,
      journal: fixture.journal,
      writeChunk: async (file: FileHandle, chunk: Uint8Array, offset: number) => {
        writes += 1;
        return (await file.write(chunk, offset, Math.min(3, chunk.byteLength - offset), null))
          .bytesWritten;
      },
    });
    const content = Buffer.from('partial-write-content');
    const partial = await partialWriter.stage({
      mediaType: 'application/octet-stream', source: chunks(content),
    });
    expect(writes).toBeGreaterThan(1);
    const partialRef = await partialWriter.commit({
      staged: partial, journal: fixture.context('partial-write-commit'), summary: 'partial writes',
    });
    expect(await readStream(await partialWriter.open(partialRef))).toEqual(content);

    const tampered = await fixture.store.stage({
      mediaType: 'text/plain', source: chunks(Buffer.from('before-journal')),
    });
    const stagedPath = await findFileContaining(fixture.artifactRoot, 'before-journal');
    await writeFile(stagedPath, 'same-size-data');
    await expect(fixture.store.commit({
      staged: tampered, journal: fixture.context('tampered-before-journal'), summary: 'tampered',
    })).rejects.toMatchObject({ code: 'CORRUPT' });
    expect((await fixture.journal.readProject('project-a', 0, 100))
      .filter(({ type, payload }) => type === 'artifact.created' &&
        payload.artifactId === tampered.artifactId)).toHaveLength(0);

    await expect(fixture.store.open({
      ...partialRef,
      artifactId: '../outside',
      handle: 'agent-artifact:../outside',
      checksum: '../outside',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
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
    if (fact?.type !== 'artifact.created' || fact.payload.availability !== 'legacy-unavailable') {
      throw new Error('Expected a legacy-unavailable artifact fact.');
    }
    expect(fact.schemaVersion).toBe(3);
    expect(fact.payload.artifactId).toMatch(/^artifact_[a-f0-9]{64}$/u);
    expect(fact.payload.handle).toMatch(/^legacy-agent-artifact:[a-f0-9]{64}$/u);
    expect(fact.payload.checksum).toBeNull();
    expect(fact.payload.byteSize).toBeNull();
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
  const store = new ProjectArtifactStore({
    projectId: 'project-a', rootDir: artifactRoot, journal,
    now: () => '2026-08-09T12:00:00.000Z',
  });
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

function withArtifactCommitBarrier(delegate: AgentJournal): AgentJournal {
  let arrivals = 0;
  let release = (): void => undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {
    createRun: async (command) => await delegate.createRun(command),
    startRun: async (command) => await delegate.startRun(command),
    startTurn: async (command) => await delegate.startTurn(command),
    async commit(command: JournalCommand) {
      if (command.events.some(({ type }) => type === 'artifact.created')) {
        arrivals += 1;
        if (arrivals === 2) release();
        else await barrier;
      }
      return await delegate.commit(command);
    },
    readProject: async (projectId, afterSequence, limit) =>
      await delegate.readProject(projectId, afterSequence, limit),
    acquireRunLease: async (input) => await delegate.acquireRunLease(input),
    renewRunLease: async (input) => await delegate.renewRunLease(input),
    getRunProjection: async (runId) => await delegate.getRunProjection(runId),
    countEvents: async (type, projectId) => await delegate.countEvents(type, projectId),
    rebuildProjectProjections: async (projectId) =>
      await delegate.rebuildProjectProjections(projectId),
  };
}

async function createRunContext(journal: SqliteAgentJournal, suffix: string) {
  const created = await journal.createRun({
    projectId: 'project-a',
    sessionId: `session-${suffix}`,
    clientRequestId: suffix,
    input: { text: suffix },
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: `worker-${suffix}`, ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: `session-${suffix}`, runId: created.runId,
    commandId: `start-${suffix}`, lease: leaseRef, expectedRunRevision: 1,
  });
  return {
    runId: created.runId,
    context: (commandId: string): ArtifactJournalContext => ({
      sessionId: `session-${suffix}`,
      runId: created.runId,
      commandId,
      lease: leaseRef,
      expectedRunRevision: 2,
    }),
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
