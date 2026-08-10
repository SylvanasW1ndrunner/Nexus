import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelRouteSnapshotInput,
  type ValidatedModelAttempt,
} from '@dbagent/core-llm';
import {
  PermissionManager,
  JournalApprovalBroker,
  ProjectArtifactStore,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';
import {
  bindToolLifecycleCommitter,
  openToolLifecycleCommitter,
} from '../src/internal/tool-lifecycle-authority.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function runtimeModule() {
  return await import('../src/tools/tool-invocation-runtime.js');
}

describe('ToolInvocationRuntime', () => {
  it('binds approval to the exact invocation scope, Tool revision, effect, digest and proposed revision', async () => {
    const fixture = await createFixture({ mode: 'read' });
    const schedule = await fixture.runtime.resolve();
    expect(schedule).toEqual({ state: 'ExecutingTools', invocationIds: [fixture.readInvocationId] });
    await fixture.runtime.execute(fixture.readInvocationId);
    expect(await fixture.runtime.resolve()).toEqual({
      state: 'AwaitingUser', reason: 'approval', invocationIds: [fixture.writeInvocationId],
    });

    const approval = await fixture.journal.getApprovalForInvocation(fixture.writeInvocationId);
    expect(approval).toMatchObject({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.writeInvocationId,
      canonicalToolId: { name: 'read_result' },
      effect: 'non_idempotent', proposedRevision: 1, status: 'pending',
    });
    expect(approval?.toolRevision).toMatch(/^[a-f0-9]{64}:read_result@1$/u);
    expect(approval?.normalizedArgumentsDigest).toMatch(/^[a-f0-9]{64}$/u);

    await expect(fixture.runtime.decideApproval({
      ...fixture.approvalDecision(approval, 'approve'),
      toolRevision: 'changed-revision',
    })).rejects.toMatchObject({ code: 'APPROVAL_BINDING_MISMATCH' });
    expect(fixture.writeCalls()).toBe(0);
  });

  it.each([
    { change: 'none', schemaChanged: false, effect: 'read' as const, handlerRevision: 'query_database@1', succeeds: true },
    { change: 'schema', schemaChanged: true, effect: 'read' as const, handlerRevision: 'query_database@1', succeeds: false },
    { change: 'effect', schemaChanged: false, effect: 'idempotent' as const, handlerRevision: 'query_database@1', succeeds: false },
    { change: 'handler revision', schemaChanged: false, effect: 'read' as const, handlerRevision: 'query_database@2', succeeds: false },
  ])('binds restart recovery to stable Tool semantics when $change changes', async ({
    schemaChanged, effect, handlerRevision, succeeds,
  }) => {
    const fixture = await createFixture({ mode: 'full' });
    await fixture.runtime.resolve();
    const registry = new ToolRegistry();
    let calls = 0;
    registry.registerInvocation({
      name: 'query_database', description: 'read fixture', dangerLevel: 'safe', readonly: true,
      effect, handlerRevision, requiredPermission: 'read', exposure: 'direct',
      inputSchema: {
        type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
        ...(schemaChanged ? { additionalProperties: false } : {}),
      },
      execution: { concurrency: effect === 'read' ? 'read' : 'write' },
    }, {
      execute: () => {
        calls += 1;
        return createAgentToolResultEnvelope({
          modelProjection: { ok: true }, durableSummary: { ok: true },
        });
      },
    });
    const { ToolInvocationRuntime } = await runtimeModule();
    const restarted = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(), registry: registry.captureSnapshot(),
    });

    if (succeeds) {
      await expect(restarted.execute(fixture.readInvocationId))
        .resolves.toMatchObject({ outcome: 'succeeded' });
      expect(calls).toBe(1);
    } else {
      await expect(restarted.execute(fixture.readInvocationId)).resolves.toMatchObject({
        outcome: 'failed', errorCode: 'TOOL_REVISION_MISMATCH',
      });
      expect(calls).toBe(0);
      expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(0);
    }
  });

  it('makes identical approval decisions idempotent and conflicting decisions typed conflicts', async () => {
    const fixture = await createFixture({ mode: 'read' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    await fixture.runtime.resolve();
    const approval = await fixture.journal.getApprovalForInvocation(fixture.writeInvocationId);
    const decision = fixture.approvalDecision(approval, 'approve');

    const first = await fixture.runtime.decideApproval(decision);
    const replay = await fixture.runtime.decideApproval(decision);
    expect(replay).toEqual(first);
    await expect(fixture.runtime.decideApproval({
      ...decision, commandId: 'approval-conflict', decision: 'deny',
    })).rejects.toMatchObject({ code: 'APPROVAL_DECISION_CONFLICT' });
    expect(await fixture.journal.countEvents('tool.authorized', 'project-a')).toBe(2);
  });

  it('lists and waits on approval truth after reopening the Journal', async () => {
    const fixture = await createFixture({ mode: 'read' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    await fixture.runtime.resolve();
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const broker = new JournalApprovalBroker({
      journal: reopened,
      runtime: fixture.runtime,
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      },
      pollIntervalMs: 5,
    });

    await expect(broker.listPending({ limit: 10 })).resolves.toEqual({
      items: [expect.objectContaining({
        invocationId: fixture.writeInvocationId, status: 'pending',
      })],
      hasMore: false,
    });
    const decisionWait = broker.waitForDecision(fixture.writeInvocationId);
    const approval = await broker.get(fixture.writeInvocationId);
    const decision = fixture.approvalDecision(approval, 'approve');
    const firstDecision = await broker.decide(decision);
    await expect(broker.decide(decision)).resolves.toEqual(firstDecision);
    await expect(broker.decide({
      ...decision, commandId: 'journal-broker-conflict', decision: 'deny',
    })).rejects.toMatchObject({ code: 'APPROVAL_DECISION_CONFLICT' });
    await expect(decisionWait).resolves.toMatchObject({ status: 'approved' });

    const wrongBinding = new JournalApprovalBroker({
      journal: reopened,
      runtime: fixture.runtime,
      binding: {
        projectId: 'project-a', sessionId: 'another-session', runId: fixture.runId,
      },
    });
    await expect(wrongBinding.get(fixture.writeInvocationId))
      .rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });

    const controller = new AbortController();
    const secondFixture = await createFixture({ mode: 'read' });
    await secondFixture.runtime.resolve();
    await secondFixture.runtime.execute(secondFixture.readInvocationId);
    await secondFixture.runtime.resolve();
    const secondBroker = new JournalApprovalBroker({
      journal: secondFixture.journal,
      runtime: secondFixture.runtime,
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: secondFixture.runId,
      },
      pollIntervalMs: 5,
    });
    const aborted = secondBroker.waitForDecision(
      secondFixture.writeInvocationId,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'APPROVAL_WAIT_ABORTED' });
    await expect(secondBroker.listPending({ limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ status: 'pending' })] });
  });

  it('loads only the bounded current-Turn Invocation page on the scheduling hot path', async () => {
    const fixture = await createFixture({ mode: 'full' });
    const legacyRunList = vi.spyOn(fixture.journal, 'listInvocations');
    const turnList = vi.spyOn(fixture.journal, 'listTurnInvocations');

    await fixture.runtime.resolve();

    expect(legacyRunList).not.toHaveBeenCalled();
    expect(turnList).toHaveBeenCalledWith({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', afterActionOrdinal: -1, limit: 256,
    });
  });

  it('pages more approval projections than the requested limit after restart', async () => {
    const fixture = await createFixture({
      mode: 'read',
      attempt: await approvalPageAttemptFixture(3),
    });
    const broker = new JournalApprovalBroker({
      journal: fixture.journal,
      runtime: fixture.runtime,
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      },
      pollIntervalMs: 5,
    });

    for (let index = 0; index < 3; index += 1) {
      await fixture.runtime.resolve();
      const [approval] = (await broker.listPending({ limit: 1 })).items;
      if (approval === undefined) throw new Error('Expected paged pending approval.');
      await broker.decide(fixture.approvalDecision(approval, 'deny'));
      await fixture.runtime.executeEligible();
    }

    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const reopenedBroker = new JournalApprovalBroker({
      journal: reopened,
      runtime: fixture.runtime,
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      },
    });
    const firstPage = await reopenedBroker.listAll({ limit: 2 });
    if (firstPage.nextCursor === undefined) throw new Error('Expected a next approval cursor.');
    const secondPage = await reopenedBroker.listAll({
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.items).toHaveLength(2);
    expect(typeof firstPage.nextCursor).toBe('string');
    expect(secondPage).toMatchObject({ hasMore: false });
    expect(secondPage.items).toHaveLength(1);
    expect(new Set(
      [...firstPage.items, ...secondPage.items].map(({ approvalId }) => approvalId),
    ).size)
      .toBe(3);

    const sqliteModuleId = ['node', 'sqlite'].join(':');
    const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
      DatabaseSync: new (filePath: string) => NodeDatabaseSync;
    };
    const database = new DatabaseSync(fixture.journalPath);
    try {
      const allPlan = database.prepare(
        `EXPLAIN QUERY PLAN SELECT approval_id FROM agent_approvals
         WHERE project_id = ? AND run_id = ?
           AND (created_at > ? OR (created_at = ? AND approval_id > ?))
         ORDER BY created_at ASC, approval_id ASC LIMIT ?`,
      ).all(
        'project-a', fixture.runId, '', '', '', 3,
      ) as unknown as Array<{ detail: string }>;
      const pendingPlan = database.prepare(
        `EXPLAIN QUERY PLAN SELECT approval_id FROM agent_approvals
         WHERE project_id = ? AND run_id = ? AND status = ?
           AND (created_at > ? OR (created_at = ? AND approval_id > ?))
         ORDER BY created_at ASC, approval_id ASC LIMIT ?`,
      ).all(
        'project-a', fixture.runId, 'pending', '', '', '', 3,
      ) as unknown as Array<{ detail: string }>;
      expect(allPlan.map(({ detail }) => detail).join('\n'))
        .toContain('idx_agent_approvals_scope_id');
      expect(pendingPlan.map(({ detail }) => detail).join('\n'))
        .toContain('idx_agent_approvals_scope_status_id');
    } finally {
      database.close();
    }
  });

  it('executes one Handler and commits exactly one terminal outcome and Observation on duplicate execution', async () => {
    const fixture = await createFixture({ mode: 'full' });
    await fixture.runtime.resolve();
    const first = await fixture.runtime.execute(fixture.readInvocationId);
    const replay = await fixture.runtime.execute(fixture.readInvocationId);

    expect(replay).toEqual(first);
    expect(fixture.readCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
    expect(await fixture.journal.listObservations(fixture.runId)).toHaveLength(1);
  });

  it('rejects direct execution that is not the first action in the current scheduler batch', async () => {
    const fixture = await createFixture({ mode: 'full' });

    await expect(fixture.runtime.execute(fixture.writeInvocationId))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(fixture.readCalls()).toBe(0);
    expect(fixture.writeCalls()).toBe(0);

    const twoReads = await createFixture({
      mode: 'full', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('direct-window', [
        { name: 'query_database', arguments: { sql: 'select 1' } },
        { name: 'query_database', arguments: { sql: 'select 2' } },
      ]),
    });
    const secondRead = twoReads.invocationIds[1] ?? '';
    await expect(twoReads.runtime.execute(secondRead))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(twoReads.readCalls()).toBe(0);
    expect(await twoReads.journal.countEvents('tool.started', 'project-a')).toBe(0);

    const threeReads = await createFixture({
      mode: 'full', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('direct-over-concurrency', [
        { name: 'query_database', arguments: { sql: 'select 1' } },
        { name: 'query_database', arguments: { sql: 'select 2' } },
        { name: 'query_database', arguments: { sql: 'select 3' } },
      ]),
    });
    await expect(threeReads.runtime.execute(threeReads.invocationIds[2] ?? ''))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(threeReads.readCalls()).toBe(0);
  });

  it('commits parallel terminals out of order but applies Observations strictly in action order', async () => {
    const completionOrder: string[] = [];
    const fixture = await createFixture({
      mode: 'full', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('ordered-observations', [
        { name: 'query_database', arguments: { sql: 'slow' } },
        { name: 'query_database', arguments: { sql: 'fast' } },
        { name: 'read_result', arguments: { resultRef: 'after-reads' } },
      ]),
      readHandler: async (context, args) => {
        const sql = String(args.sql);
        await wait(sql === 'slow' ? 40 : 5, context.signal);
        completionOrder.push(sql);
        return createAgentToolResultEnvelope({
          modelProjection: { sql }, durableSummary: { sql },
        });
      },
    });

    const observations = await fixture.runtime.executeEligible();
    const events = await fixture.journal.readProject('project-a', 0, 200);
    const terminalIds = events
      .filter(({ type }) => type === 'tool.succeeded')
      .map(({ invocationId }) => invocationId);
    const observedIds = events
      .filter(({ type }) => type === 'tool.observed')
      .map(({ invocationId }) => invocationId);

    expect(completionOrder).toEqual(['fast', 'slow']);
    expect(terminalIds.slice(0, 2)).toEqual([
      fixture.invocationIds[1], fixture.invocationIds[0],
    ]);
    expect(observedIds).toEqual(fixture.invocationIds);
    expect(observations.map(({ invocationId }) => invocationId)).toEqual(fixture.invocationIds);
    expect(fixture.readCalls()).toBe(2);
    expect(fixture.writeCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(3);
  });

  it('lets two Runtime instances race one Invocation without a duplicate Handler call', async () => {
    const fixture = await createFixture({ mode: 'full', readDelayMs: 40 });
    await fixture.runtime.resolve();
    const { ToolInvocationRuntime } = await runtimeModule();
    const competitor = new ToolInvocationRuntime(fixture.runtimeOptions());

    const settled = await Promise.allSettled([
      fixture.runtime.execute(fixture.readInvocationId),
      competitor.execute(fixture.readInvocationId),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
    expect(fixture.readCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('does not dispatch an authorized peer while another action in its read window is proposed', async () => {
    const fixture = await createFixture({
      mode: 'full', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('validation-race', [
        { name: 'query_database', arguments: { sql: 'select 1' } },
        { name: 'query_database', arguments: { sql: 'select 2' } },
      ]),
    });
    const realCommit = openToolLifecycleCommitter(fixture.journal).commit;
    let signalFirstValidated = (): void => undefined;
    let releaseFirstValidation = (): void => undefined;
    const firstValidated = new Promise<void>((resolve) => { signalFirstValidated = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseFirstValidation = resolve; });
    let held = false;
    const journalFacade = new Proxy(fixture.journal, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) as unknown : value;
      },
    });
    bindToolLifecycleCommitter(journalFacade, async (command) => {
      const result = await realCommit(command);
      if (
        !held && command.action === 'validate' &&
        command.invocationId === fixture.invocationIds[0]
      ) {
        held = true;
        signalFirstValidated();
        await validationRelease;
      }
      return result;
    });
    const { ToolInvocationRuntime } = await runtimeModule();
    const resolvingRuntime = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(), journal: journalFacade,
    });
    const resolving = resolvingRuntime.resolve();
    await firstValidated;
    expect(fixture.readCalls()).toBe(0);

    const competitor = new ToolInvocationRuntime(fixture.runtimeOptions());
    const executing = competitor.execute(fixture.invocationIds[0] ?? '');
    await fixture.waitUntilReadStarted();
    expect((await fixture.journal.getInvocation(fixture.invocationIds[1] ?? ''))?.state)
      .toBe('authorized');
    releaseFirstValidation();
    await Promise.all([resolving, executing]);
    expect(fixture.readCalls()).toBe(1);
  });

  it('rejects recovery through a Runtime bound to another Turn', async () => {
    const fixture = await createFixture({ mode: 'full' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    const { ToolInvocationRuntime } = await runtimeModule();
    const options = fixture.runtimeOptions();
    const wrongTurnRuntime = new ToolInvocationRuntime({
      ...options,
      binding: { ...options.binding, turnId: 'turn-b' },
    });

    await expect(wrongTurnRuntime.recover(fixture.readInvocationId))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('maps unknown Handler errors to a closed safe error without scanning or leaking their text', async () => {
    const secret = 'synthetic-api-key-never-persist';
    const fixture = await createFixture({
      mode: 'full',
      readHandler: () => {
        throw new Error(`ECONNRESET ${secret} C:\\Users\\private\\raw-output`);
      },
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const persisted = JSON.stringify(await fixture.journal.readProject('project-a', 0, 100));

    expect(invocation).toMatchObject({
      state: 'observed', terminal: {
        kind: 'failed', error: {
          code: 'HANDLER_FAILED', category: 'internal', retryable: false, outcome: 'not_applied',
        },
      },
    });
    expect(observation.summary).toBe('The tool could not complete.');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('C:\\Users\\private');
    expect(persisted).not.toContain('ECONNRESET');
  });

  it('stages an unbounded result in the Artifact Store and journals only bounded projections and refs', async () => {
    const fixture = await createFixture({
      mode: 'full', artifactStore: true,
      readHandler: () => createAgentToolResultEnvelope({
        modelProjection: { rows: [{ id: 1 }] },
        userProjection: { raw: 'x'.repeat(256 * 1024) },
        durableSummary: { rowCount: 1 },
      }),
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(invocation?.terminal?.resultRefs).toHaveLength(1);
    expect(observation.modelProjection).toEqual({ rows: [{ id: 1 }] });
    expect(JSON.stringify(await fixture.journal.readProject('project-a', 0, 100)).length)
      .toBeLessThan(32 * 1024);
    const handle = invocation?.terminal?.resultRefs[0];
    const artifactEvent = (await fixture.journal.readProject('project-a', 0, 100))
      .find((event) => event.type === 'artifact.created' && event.payload.handle === handle);
    expect(artifactEvent?.type).toBe('artifact.created');
    if (artifactEvent?.type !== 'artifact.created') throw new Error('Artifact fact is missing.');
    expect(artifactEvent.payload.byteSize).toBeGreaterThan(256 * 1024);
  });

  it.each([
    ['16 KiB', 16 * 1024, false],
    ['just above 16 KiB', 16 * 1024 + 1, true],
    ['just below 32 KiB', 32 * 1024 - 1, true],
    ['32 KiB', 32 * 1024, true],
    ['just above 32 KiB', 32 * 1024 + 1, true],
  ] as const)(
    'keeps a %s model projection lossless and Artifact-bound when it is replaced',
    async (_label, projectionBytes, expectsArtifact) => {
      const completeProjection = jsonStringWithByteSize(projectionBytes);
      const fixture = await createFixture({
        mode: 'full', artifactStore: true,
        readHandler: () => createAgentToolResultEnvelope({
          modelProjection: completeProjection,
          userProjection: { visible: true },
          durableSummary: { rowCount: 1 },
        }),
      });
      await fixture.runtime.resolve();
      const observation = await fixture.runtime.execute(fixture.readInvocationId);
      const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
      const handle = invocation?.terminal?.resultRefs[0];

      if (!expectsArtifact) {
        expect(invocation?.terminal?.resultRefs).toEqual([]);
        expect(observation.modelProjection).toBe(completeProjection);
        return;
      }
      expect(handle).toMatch(/^agent-artifact:/u);
      expect(observation.modelProjection).toEqual({
        type: 'schemanaut.bounded-projection.v1',
        summary: 'model projection is available in the referenced artifact.',
        byteSize: projectionBytes,
        artifactRef: handle,
      });
      const artifact = await readResultArtifact(fixture.artifactStore, fixture.journal, handle);
      expect(artifact).toMatchObject({ modelProjection: completeProjection });
    },
  );

  it.each([
    ['model', 16 * 1024 + 1],
    ['user', 16 * 1024 + 1],
    ['durable', 4 * 1024 + 1],
  ] as const)(
    'requires a committed full-envelope Artifact before replacing the %s projection',
    async (projection, projectionBytes) => {
      const completeProjection = jsonStringWithByteSize(projectionBytes);
      const fixture = await createFixture({
        mode: 'full', artifactStore: true,
        readHandler: () => createAgentToolResultEnvelope({
          modelProjection: projection === 'model' ? completeProjection : { ok: true },
          userProjection: projection === 'user' ? completeProjection : { visible: true },
          durableSummary: projection === 'durable' ? completeProjection : { rowCount: 1 },
        }),
      });
      await fixture.runtime.resolve();
      const observation = await fixture.runtime.execute(fixture.readInvocationId);
      const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
      const handle = invocation?.terminal?.resultRefs[0];
      expect(handle).toMatch(/^agent-artifact:/u);
      const projected = projection === 'model'
        ? observation.modelProjection
        : projection === 'user'
          ? invocation?.terminal?.userProjection
          : invocation?.terminal?.durableSummary;
      expect(projected).toMatchObject({
        type: 'schemanaut.bounded-projection.v1',
        byteSize: projectionBytes,
        artifactRef: handle,
      });
      const artifact = await readResultArtifact(fixture.artifactStore, fixture.journal, handle);
      expect(artifact).toMatchObject({
        [projection === 'model'
          ? 'modelProjection'
          : projection === 'user' ? 'userProjection' : 'durableSummary']: completeProjection,
      });
    },
  );

  it('never commits a referenced placeholder when the required Artifact cannot be created', async () => {
    const completeProjection = jsonStringWithByteSize(16 * 1024 + 1);
    const fixture = await createFixture({
      mode: 'full', artifactStore: false,
      readHandler: () => createAgentToolResultEnvelope({
        modelProjection: completeProjection,
        durableSummary: { rowCount: 1 },
      }),
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation.outcome).toBe('failed');
    expect(invocation?.terminal?.kind).toBe('failed');
    expect(invocation?.terminal?.resultRefs).toEqual([]);
    expect(JSON.stringify(invocation?.terminal)).not.toContain('bounded-projection');
  });

  it('records an unknown outcome when a risky Handler completed but its required Artifact failed', async () => {
    const fixture = await createFixture({
      mode: 'full', artifactStore: false, readEffect: 'non_idempotent',
      readHandler: () => createAgentToolResultEnvelope({
        modelProjection: jsonStringWithByteSize(16 * 1024 + 1),
        durableSummary: { changed: true },
      }),
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation.outcome).toBe('outcome_unknown');
    expect(invocation?.terminal).toMatchObject({
      kind: 'outcome_unknown', resultRefs: [], error: { outcome: 'unknown' },
    });
    expect(JSON.stringify(invocation?.terminal)).not.toContain('bounded-projection');
  });

  it('redacts secret-like diagnostics before terminal commit and preserves the full bounded result artifact', async () => {
    const apiKey = 'fake-api-key-result-value';
    const password = 'never-persist-password';
    const localPath = 'C:\\Users\\private\\result.json';
    const stack = 'Error: private\n    at C:\\Users\\private\\handler.js:1:1';
    const fixture = await createFixture({
      mode: 'full', artifactStore: true, readEffect: 'non_idempotent',
      readHandler: () => createAgentToolResultEnvelope({
        modelProjection: {
          apiKey, path: localPath, stack, businessPath: '/orders/42', ok: true,
        },
        userProjection: {
          password, path: localPath, stack, businessPath: '/orders/42',
          payload: 'x'.repeat(256 * 1024),
        },
        durableSummary: { password, rowCount: 1 },
      }),
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = await fixture.journal.readProject('project-a', 0, 100);
    const persisted = JSON.stringify(events);

    expect(observation).toMatchObject({
      outcome: 'succeeded',
      modelProjection: {
        apiKeyRedacted: true, path: '[REDACTED]', stack: '[REDACTED]',
        businessPath: '/orders/42', ok: true,
      },
    });
    expect(invocation?.terminal).toMatchObject({
      kind: 'succeeded',
      durableSummary: { passwordRedacted: true, rowCount: 1 },
      userProjection: { type: 'schemanaut.bounded-projection.v1' },
    });
    expect(fixture.readCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.outcome_unknown', 'project-a')).toBe(0);
    for (const secret of [apiKey, password, localPath, stack]) expect(persisted).not.toContain(secret);

    const artifactEvent = events.find(({ type }) => type === 'artifact.created');
    if (
      artifactEvent?.type !== 'artifact.created' ||
      artifactEvent.payload.availability !== 'available' ||
      fixture.artifactStore === undefined
    ) {
      throw new Error('Expected result Artifact fact.');
    }
    const stream = await fixture.artifactStore.open({
      schemaVersion: 1,
      artifactId: artifactEvent.payload.artifactId,
      handle: artifactEvent.payload.handle,
      projectId: 'project-a',
      checksum: artifactEvent.payload.checksum,
      byteSize: artifactEvent.payload.byteSize,
      mediaType: artifactEvent.payload.mediaType,
      availability: 'available',
      createdAt: artifactEvent.occurredAt,
      ...(artifactEvent.payload.expiresAt === undefined
        ? {}
        : { expiresAt: artifactEvent.payload.expiresAt }),
    });
    const artifactText = await readTextStream(stream);
    for (const secret of [apiKey, password, localPath, stack]) {
      expect(artifactText).not.toContain(secret);
    }
    expect(artifactText).toContain('/orders/42');
    expect(artifactText).toContain('[REDACTED]');
  });

  it('bounds dispatch, stops undispatched work on cancellation, and propagates AbortSignal to started Handlers', async () => {
    const fixture = await createFixture({ mode: 'full', readDelayMs: 5_000, maxConcurrency: 1 });
    await fixture.runtime.resolve();
    const controller = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: controller.signal });
    await fixture.waitUntilReadStarted();
    controller.abort('cancelled by test');
    const observations = await execution;

    expect(fixture.sawReadAbort()).toBe(true);
    expect(fixture.writeCalls()).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('uses descriptor timeout metadata and never parses an Error message to classify timeout', async () => {
    const fixture = await createFixture({ mode: 'full', readDelayMs: 100, readTimeoutMs: 10 });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_TIMEOUT' });
    expect(invocation?.terminal?.error).toMatchObject({
      code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied',
    });
  });

  it('converges invalid arguments to one typed Observation without calling a Handler', async () => {
    const fixture = await createFixture({
      mode: 'read',
      readInputSchema: {
        type: 'object', properties: { requiredValue: { type: 'string' } },
        required: ['requiredValue'], additionalProperties: false,
      },
    });

    const observations = await fixture.runtime.executeEligible();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_INPUT_INVALID' });
    expect(fixture.readCalls()).toBe(0);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('converges an unavailable Tool to one typed Observation without orphaning proposed work', async () => {
    const fixture = await createFixture({ mode: 'read', registerRead: false });

    const observations = await fixture.runtime.executeEligible();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_NOT_FOUND' });
    expect((await fixture.journal.getInvocation(fixture.readInvocationId))?.state).toBe('observed');
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('validates representative JSON Schema 2020-12 Tool arguments', async () => {
    const fixture = await createFixture({
      mode: 'full',
      readInputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { sqlText: { type: 'string', minLength: 1 } },
        properties: { sql: { $ref: '#/$defs/sqlText' } },
        required: ['sql'],
        unevaluatedProperties: false,
      },
    });

    await fixture.runtime.resolve();
    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(fixture.readCalls()).toBe(1);
  });

  it('settles a non-cooperative timeout and ignores its late resolution', async () => {
    let release = (): void => undefined;
    const blocked = new Promise<unknown>((resolve) => { release = () => resolve(
      createAgentToolResultEnvelope({
        modelProjection: { late: true }, durableSummary: { late: true },
      }),
    ); });
    const fixture = await createFixture({
      mode: 'full', readTimeoutMs: 10, readHandler: () => blocked,
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_TIMEOUT' });
    release();
    await wait(25, new AbortController().signal);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it.each([
    { effect: 'idempotent' as const, outcome: 'failed', unknownEvents: 0 },
    { effect: 'transactional' as const, outcome: 'outcome_unknown', unknownEvents: 1 },
    { effect: 'non_idempotent' as const, outcome: 'outcome_unknown', unknownEvents: 1 },
  ])('maps an opaque $effect Handler failure by its declared effect', async ({
    effect, outcome, unknownEvents,
  }) => {
    const fixture = await createFixture({
      mode: 'full', readEffect: effect,
      readHandler: () => { throw new Error('opaque native failure'); },
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation).toMatchObject({ outcome, errorCode: 'HANDLER_FAILED' });
    expect(await fixture.journal.countEvents('tool.outcome_unknown', 'project-a'))
      .toBe(unknownEvents);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a'))
      .toBe(unknownEvents === 0 ? 1 : 0);
  });

  it('does not report cancellation when an ignoring non-idempotent Handler may apply late', async () => {
    let applyEffect = (): void => undefined;
    let effects = 0;
    const blocked = new Promise<unknown>((resolve) => {
      applyEffect = () => {
        effects += 1;
        resolve(createAgentToolResultEnvelope({
          modelProjection: { effects }, durableSummary: { effects },
        }));
      };
    });
    const fixture = await createFixture({
      mode: 'full', readEffect: 'non_idempotent', readTimeoutMs: 10,
      readHandler: () => blocked,
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation.outcome).toBe('outcome_unknown');
    applyEffect();
    await wait(25, new AbortController().signal);
    expect(effects).toBe(1);
    expect(await fixture.journal.countEvents('tool.cancelled', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.outcome_unknown', 'project-a')).toBe(1);
    expect(fixture.readCalls()).toBe(1);
  });

  it.each([
    ['small', 'user-visible'],
    ['large', 'x'.repeat(256 * 1024)],
  ])('keeps the %s user projection recoverable after Journal rebuild', async (_kind, value) => {
    const fixture = await createFixture({
      mode: 'full', artifactStore: true,
      readHandler: () => createAgentToolResultEnvelope({
        modelProjection: { ok: true }, userProjection: { value }, durableSummary: { ok: true },
      }),
    });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    const before = await fixture.journal.getInvocation(fixture.readInvocationId);

    await fixture.journal.rebuildProjectProjections('project-a');
    const after = await fixture.journal.getInvocation(fixture.readInvocationId);
    expect(after?.terminal?.userProjection).toEqual(before?.terminal?.userProjection);
    if (value.length > 32 * 1024) {
      expect(after?.terminal?.userProjection).toMatchObject({
        type: 'schemanaut.bounded-projection.v1',
      });
      expect(after?.terminal?.resultRefs).toHaveLength(1);
    } else {
      expect(after?.terminal?.userProjection).toEqual({ value });
    }
  });

  it('atomically projects mixed Tool lifecycle state and rebuilds the same Run aggregate', async () => {
    const fixture = await createFixture({ mode: 'read' });

    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('ResolvingActions');
    await fixture.runtime.resolve();
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('ExecutingTools');
    await fixture.runtime.execute(fixture.readInvocationId);
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('AwaitingUser');
    const approval = await fixture.journal.getApprovalForInvocation(fixture.writeInvocationId);
    await fixture.runtime.decideApproval(fixture.approvalDecision(approval, 'approve'));
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('ExecutingTools');
    await fixture.runtime.execute(fixture.writeInvocationId);
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state)
      .toBe('ApplyingObservations');

    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    expect((await reopened.getRunProjection(fixture.runId))?.state).toBe('ApplyingObservations');
    await reopened.rebuildProjectProjections('project-a');
    expect((await reopened.getRunProjection(fixture.runId))?.state).toBe('ApplyingObservations');
  });
});

type FixtureOptions = {
  mode: 'read' | 'edit' | 'full';
  maxConcurrency?: number;
  readDelayMs?: number;
  readTimeoutMs?: number;
  artifactStore?: boolean;
  readHandler?: (
    context: { signal: AbortSignal },
    args: Readonly<Record<string, unknown>>,
  ) => unknown;
  readEffect?: 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
  readInputSchema?: Record<string, unknown>;
  registerRead?: boolean;
  attempt?: ValidatedModelAttempt;
};

async function createFixture(options: FixtureOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-tool-runtime-'));
  temporaryDirectories.push(directory);
  const journalPath = join(directory, 'state.db');
  const journal = new SqliteAgentJournal({
    filePath: journalPath, now: () => new Date().toISOString(),
  });
  const created = await journal.createRun({
    projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'go',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'start-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'start-turn', lease: leaseRef, expectedRunRevision: 2,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'commit-attempt', lease: leaseRef, expectedRunRevision: 3,
    expectedTurnRevision: 1,
    attempt: options.attempt ?? await validatedAttemptFixture('task-5-attempt'),
  });
  const registry = new ToolRegistry();
  let readCallCount = 0;
  let writeCallCount = 0;
  let readStarted = false;
  let readAborted = false;
  let signalReadStarted = (): void => undefined;
  const readStartedPromise = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  if (options.registerRead !== false) registry.registerInvocation({
    name: 'query_database', description: 'read fixture', dangerLevel: 'safe', readonly: true,
    effect: options.readEffect ?? 'read', handlerRevision: 'query_database@1',
    requiredPermission: 'read', exposure: 'direct',
    inputSchema: options.readInputSchema ?? {
      type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
    },
    execution: {
      concurrency: options.readEffect === undefined || options.readEffect === 'read' ? 'read' : 'write',
      ...(options.readTimeoutMs === undefined ? {} : { timeoutMs: options.readTimeoutMs }),
    },
  }, {
    execute: async (argumentsRecord, context) => {
      readCallCount += 1;
      readStarted = true;
      signalReadStarted();
      if (options.readDelayMs !== undefined) {
        try {
          await wait(options.readDelayMs, context.signal);
        } catch (error) {
          readAborted = context.signal.aborted;
          throw error;
        }
      }
      return options.readHandler?.(context, argumentsRecord) ?? createAgentToolResultEnvelope({
        modelProjection: { rows: [{ value: 1 }] },
        userProjection: { rows: [{ value: 1 }] },
        durableSummary: { rowCount: 1 },
      });
    },
  });
  registry.registerInvocation({
    name: 'read_result', description: 'write fixture', dangerLevel: 'medium', readonly: false,
    effect: 'non_idempotent', handlerRevision: 'read_result@1',
    requiredPermission: 'edit', exposure: 'direct',
    inputSchema: {
      type: 'object', properties: { resultRef: { type: 'string' } }, required: ['resultRef'],
    },
    execution: { concurrency: 'write' },
  }, {
    execute: () => {
      writeCallCount += 1;
      return createAgentToolResultEnvelope({
        modelProjection: { written: true }, durableSummary: { written: true },
      });
    },
  });
  const snapshot = registry.captureSnapshot();
  const artifactStore = options.artifactStore
    ? new ProjectArtifactStore({
        projectId: 'project-a', rootDir: join(directory, 'artifacts'), journal,
      })
    : undefined;
  const { ToolInvocationRuntime } = await runtimeModule();
  const runtimeOptions = () => ({
    journal, registry: snapshot, permissionManager: new PermissionManager(), artifactStore,
    binding: {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
      lease, mode: options.mode,
    },
    maxConcurrency: options.maxConcurrency ?? 2,
  });
  const runtime = new ToolInvocationRuntime(runtimeOptions());
  const readInvocationId = committed.invocations[0]?.invocationId ?? '';
  const writeInvocationId = committed.invocations[1]?.invocationId ?? '';
  return {
    directory, journalPath, journal, runId: created.runId, lease, runtime, runtimeOptions, snapshot,
    artifactStore, readInvocationId, writeInvocationId,
    invocationIds: committed.invocations.map(({ invocationId }) => invocationId),
    readCalls: () => readCallCount, writeCalls: () => writeCallCount,
    sawReadAbort: () => readAborted,
    waitUntilReadStarted: async () => {
      if (readStarted) return;
      await readStartedPromise;
    },
    approvalDecision: (approval: Awaited<ReturnType<typeof journal.getApprovalForInvocation>>, decision: 'approve' | 'deny') => {
      if (approval === null) throw new Error('Expected pending approval');
      return {
        commandId: `approval-${approval.approvalId}-${decision}`, approvalId: approval.approvalId,
        projectId: approval.projectId, sessionId: approval.sessionId, runId: approval.runId,
        turnId: approval.turnId, invocationId: approval.invocationId,
        canonicalToolId: approval.canonicalToolId, toolRevision: approval.toolRevision,
        effect: approval.effect, normalizedArgumentsDigest: approval.normalizedArgumentsDigest,
        proposedRevision: approval.proposedRevision, decision,
      } as const;
    },
  };
}

async function approvalPageAttemptFixture(count: number): Promise<ValidatedModelAttempt> {
  return await toolCallAttemptFixture(
    'approval-page',
    Array.from({ length: count }, (_, index) => ({
      name: 'read_result', arguments: { resultRef: `result-${index}` },
    })),
  );
}

async function toolCallAttemptFixture(
  identity: string,
  calls: readonly Readonly<{ name: string; arguments: Readonly<Record<string, unknown>> }>[],
): Promise<ValidatedModelAttempt> {
  const response = {
    id: `response-${identity}`,
    model: 'model-current',
    status: 'completed',
    output: [
      { id: `message-${identity}`, type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'I will perform the requested actions.' },
      ] },
      ...calls.map((call, index) => ({
        id: `item-${identity}-${index}`,
        type: 'function_call',
        call_id: `wire-${identity}-${index}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  };
  const client: ModelClient = { execute: () => Promise.resolve({ kind: 'json', response }) };
  const route: ModelRouteSnapshotInput = {
    routeId: 'approval-page-route', connectionId: 'connection-current',
    providerId: 'provider-current', modelId: 'model-current', protocol: 'openai-responses',
    codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'approval-page-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec('openai-responses', 'openai-responses@1');
  if (codec === undefined) throw new Error('Missing registered Responses codec');
  const session = createModelSession({ route, generation: {}, codec, client });
  const request: CanonicalModelRequest = {
    model: 'model-current',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  };
  return (await new ModelExecutionGateway({ createAttemptId: () => `${identity}-attempt` })
    .executeAttempt(session, request)).attempt;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function jsonStringWithByteSize(byteSize: number): string {
  if (!Number.isSafeInteger(byteSize) || byteSize < 2) throw new Error('Invalid JSON byte size.');
  return 'x'.repeat(byteSize - 2);
}

async function readResultArtifact(
  store: ProjectArtifactStore | undefined,
  journal: SqliteAgentJournal,
  handle: string | undefined,
): Promise<Record<string, unknown>> {
  if (store === undefined || handle === undefined) throw new Error('Result Artifact is missing.');
  const artifactEvent = (await journal.readProject('project-a', 0, 100)).find(
    (event) => event.type === 'artifact.created' && event.payload.handle === handle,
  );
  if (artifactEvent?.type !== 'artifact.created' || artifactEvent.payload.availability !== 'available') {
    throw new Error('Result Artifact fact is missing.');
  }
  const stream = await store.open({
    schemaVersion: 1,
    artifactId: artifactEvent.payload.artifactId,
    handle: artifactEvent.payload.handle,
    projectId: 'project-a',
    checksum: artifactEvent.payload.checksum,
    byteSize: artifactEvent.payload.byteSize,
    mediaType: artifactEvent.payload.mediaType,
    availability: 'available',
    createdAt: artifactEvent.occurredAt,
    ...(artifactEvent.payload.expiresAt === undefined
      ? {}
      : { expiresAt: artifactEvent.payload.expiresAt }),
  });
  return JSON.parse(await readTextStream(stream)) as Record<string, unknown>;
}

async function readTextStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
