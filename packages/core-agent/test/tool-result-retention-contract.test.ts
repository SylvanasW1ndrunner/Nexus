import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PermissionManager,
  ProjectArtifactStore,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolInvocationRuntime,
  ToolRegistry,
  type ToolResultRetentionHandler,
} from '../src/index.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('ToolInvocationHandlerRuntime.retainResult', () => {
  it('issues owner-scoped content and evidence references with delivery completion evidence', async () => {
    const fixture = await runRetention(() => Promise.resolve(retained('result body', 'result-42')));
    try {
      expect(fixture.observation).toMatchObject({ outcome: 'succeeded', completionEvidence: {
        deliveryReady: true, outcome: 'succeeded', executionId: 'result-42', metrics: { totalBytes: 11 },
      } });
      expect(fixture.observation.evidenceRefs).toHaveLength(1);
      expect(fixture.observation.evidenceRefs[0]).toMatch(/^schemanaut-evidence:v1:artifact_/u);
      const contentRef = contentReference(fixture.observation.modelProjection);
      expect(contentRef).toMatch(/^schemanaut-content:v1:artifact_/u);
      const evidence = await fixture.artifactStore.resolveEvidenceReference(
        fixture.observation.evidenceRefs[0]!,
        { hostId: 'host-retain', projectId: 'project-retain', sessionId: 'session-retain', runId: fixture.runId },
      );
      expect(evidence).toMatchObject({
        status: 'valid',
        record: {
          contentRef,
          owner: {
            hostId: 'host-retain', projectId: 'project-retain', sessionId: 'session-retain',
            runId: fixture.runId, invocationId: fixture.invocationId,
          },
        },
      });
      await expect(fixture.artifactStore.resolveEvidenceReference(
        fixture.observation.evidenceRefs[0]!,
        { hostId: 'other-host', projectId: 'project-retain', sessionId: 'session-retain', runId: fixture.runId },
      )).resolves.toEqual({ status: 'forbidden' });
    } finally { await fixture.dispose(); }
  });

  it('rejects retained bytes above maxArtifactBytes before publishing evidence', async () => {
    const fixture = await runRetention(() => Promise.resolve(retained('too large', 'large')), 4);
    try {
      // The Handler did run, so Runtime correctly preserves an unknown external outcome
      // while rejecting its non-durable retained result.
      expect(fixture.observation).toMatchObject({ outcome: 'unknown', errorCode: 'INVALID_TOOL_RESULT', evidenceRefs: [] });
      await expect(fixture.journal.countEvents('artifact.created', 'project-retain')).resolves.toBe(0);
    } finally { await fixture.dispose(); }
  });

  it.each([
    ['extra field', () => Promise.resolve({ ...retained('ok', 'extra'), forged: true })],
    ['invalid checksum', () => Promise.resolve({ ...retained('ok', 'checksum'), expectedChecksum: 'sha256:not-hex' })],
  ])('rejects a Handler-retained result with %s', async (_label, retainResult) => {
    const fixture = await runRetention(retainResult);
    try {
      expect(fixture.observation).toMatchObject({ outcome: 'unknown', errorCode: 'INVALID_TOOL_RESULT', evidenceRefs: [] });
    } finally { await fixture.dispose(); }
  });
});

async function runRetention(retainResult: ToolResultRetentionHandler, maxArtifactBytes = 1_024) {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-retain-result-'));
  directories.push(directory);
  const journal = new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
  const created = await journal.createRun({ projectId: 'project-retain', sessionId: 'session-retain', clientRequestId: 'retain-request', input: 'retain' });
  const lease = await journal.acquireRunLease({ projectId: 'project-retain', runId: created.runId, ownerId: 'retain-worker', ttlMs: 60_000 });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({ projectId: 'project-retain', sessionId: 'session-retain', runId: created.runId, commandId: 'start', lease: leaseRef, expectedRunRevision: 1 });
  await journal.startTurn({ projectId: 'project-retain', sessionId: 'session-retain', runId: created.runId, turnId: 'turn-retain', commandId: 'turn', lease: leaseRef, expectedRunRevision: 2 });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-retain', sessionId: 'session-retain', runId: created.runId, turnId: 'turn-retain', commandId: 'attempt', lease: leaseRef,
    expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await validatedAttemptFixture('retain'),
  });
  const contribution = invocationContribution('query_database', { ok: true });
  const registry = new ToolRegistry();
  registry.registerInvocation({
    ...contribution.definition,
    inputSchema: {
      type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
      additionalProperties: false,
    },
    limits: { ...contribution.definition.limits, maxArtifactBytes },
    completion: { role: 'deliverable', group: 'retained-result' },
  }, {
    ...contribution.runtime,
    prepare: async (input, context) => ({
      ...(await contribution.runtime.prepare(input, context)),
      limits: context.limits,
    }),
    retainResult,
  });
  const snapshot = registry.captureSnapshot();
  const artifactStore = new ProjectArtifactStore({ projectId: 'project-retain', rootDir: join(directory, 'artifacts'), journal });
  const runtime = new ToolInvocationRuntime({
    journal, registry: snapshot, artifactStore, permissionManager: new PermissionManager(), hostId: 'host-retain', revalidateTarget: () => undefined,
    allowedTools: [{ name: 'query_database', revision: snapshot.invocationRevision('query_database')! }],
    binding: { projectId: 'project-retain', sessionId: 'session-retain', runId: created.runId, turnId: 'turn-retain', lease, mode: 'full-access' },
  });
  const observation = (await runtime.executeEligible())[0];
  if (observation === undefined) throw new Error('Expected retained Tool observation.');
  return { journal, artifactStore, observation, runId: created.runId, invocationId: committed.invocations[0]!.invocationId, dispose: () => { snapshot.release(); return Promise.resolve(); } };
}

function retained(body: string, identity: string) {
  const bytes = new TextEncoder().encode(body);
  return { mediaType: 'text/plain', identity, expectedByteSize: bytes.byteLength,
    source: Readable.from([bytes]) };
}

function contentReference(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime did not project retained content.');
  }
  const contentRef = (value as Record<string, unknown>).contentRef;
  if (typeof contentRef !== 'string') throw new Error('Runtime did not issue a content reference.');
  return contentRef;
}
