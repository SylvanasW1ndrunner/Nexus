import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { executionPermissionAudit } from './permission-audit-fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ProjectArtifactStore,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolRegistry,
  ToolExecutionError,
  UserActivityProjector,
  createRuntimeCommandToolResult,
  preparedIntentDigest,
  type ToolInvocationExecutionContext,
  type AgentInvocationHookContribution,
  type AgentToolPermissionDeclaration,
  type AgentToolPresentation,
} from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';
import {
  createRuntimeCommandIssuer,
  openRuntimeCommandApplication,
} from '../src/internal/runtime-command-authority.js';
import {
  bindToolLifecycleCommitter,
  openToolLifecycleCommitter,
} from '../src/internal/tool-lifecycle-authority.js';
import {
  openToolArtifactCommitter,
  type PrepareToolArtifactInput,
} from '../src/internal/prepared-tool-artifact-authority.js';
import { RunController } from '../src/kernel/run-controller.js';

const temporaryDirectories: string[] = [];
// Tool Runtime tests exercise lifecycle semantics, not Run-lease or default
// Tool-deadline expiry. Explicit timeout tests override these values.
const FIXTURE_LEASE_TTL_MS = 5 * 60_000;
const FIXTURE_TOOL_TIMEOUT_MS = 2 * 60_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
}, 60_000);

async function runtimeModule() {
  return await import('../src/tools/tool-invocation-runtime.js');
}

describe('ToolInvocationRuntime', () => {
  it('rechecks attempt authorization for legacy intents after a blocked resource lease', async () => {
    const permissionManager = new PermissionManager({ revision: 'legacy-policy.v1' });
    const fixture = await createFixture({ mode: 'full-access', permissionManager });
    const realCommit = openToolLifecycleCommitter(fixture.journal).commit;
    const journalFacade = new Proxy(fixture.journal, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) as unknown : value;
      },
    });
    bindToolLifecycleCommitter(journalFacade, async (command, options) => {
      if (command.action !== 'prepare') return realCommit(command, options);
      // Model a persisted pre-snapshot Journal record through the actual writer.
      const intent = { ...command.intent }; delete intent.runPolicy;
      return realCommit({ ...command, intent, intentDigest: preparedIntentDigest(intent) }, options);
    });
    let entered!: () => void; let release!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { ToolInvocationRuntime } = await runtimeModule();
    const runtime = new ToolInvocationRuntime({ ...fixture.runtimeOptions(), journal: journalFacade,
      resourceLeases: { acquire: async () => { entered(); await blocked; return { release: () => {} }; } },
    });
    await runtime.resolve();
    const events = await fixture.journal.readProject('project-a', 0, 10_000);
    const prepared = events.find(event => event.type === 'tool.prepared' && event.invocationId === fixture.readInvocationId);
    if (prepared?.type !== 'tool.prepared' || !('intent' in prepared.payload)) throw new Error('Expected a legacy prepared intent.');
    expect(prepared.payload.intent.runPolicy).toBeUndefined();
    const execution = runtime.execute(fixture.readInvocationId);
    await acquired;
    permissionManager.replacePolicy({ revision: 'legacy-policy.v2', rules: [{ id: 'deny-while-waiting', decision: 'deny', tools: ['query_database'] }] });
    release();
    await expect(execution).resolves.toMatchObject({ outcome: 'failed', errorCode: 'target_changed' });
    expect(fixture.readCalls()).toBe(0);
  });

  it.each(['default', 'auto', 'full-access'] as const)('passes and persists the actual %s Run policy before execution', async mode => {
    let seen: unknown;
    const permissionManager = new PermissionManager({ revision: 'actual-enterprise.v9' });
    const fixture = await createFixture({ mode, permissionManager, onReadPrepare: policy => { seen = policy; } });
    await fixture.runtime.resolve();
    expect(seen).toEqual({ mode, revision: 'actual-enterprise.v9' });
    const events = await fixture.journal.readProject('project-a', 0, 10_000);
    const prepared = events.find(event => event.type === 'tool.prepared' && event.invocationId === fixture.readInvocationId);
    expect(prepared?.payload).toMatchObject({ intent: { runPolicy: { mode, revision: 'actual-enterprise.v9' } } });
    permissionManager.replacePolicy({ revision: 'actual-enterprise.v10', rules: [] });
    await expect(fixture.runtime.execute(fixture.readInvocationId)).resolves.toMatchObject({ outcome: 'failed', errorCode: 'target_changed' });
    expect(fixture.readCalls()).toBe(0);
  });

  it('batches trusted Handler progress into bounded durable user activities', async () => {
    const secret = 'progress-secret-value';
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        for (let index = 0; index < 200; index += 1) {
          context.reportProgress(
            `phase ${index}: ${'x'.repeat(40)}${index === 100 ? ` password=${secret}` : ''}`,
          );
        }
        return { ok: true };
      },
    });

    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);

    const events = await fixture.journal.readProject('project-a', 0, 10_000);
    const progress = events.filter((event) => event.type === 'tool.progress');
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThan(200);
    expect(progress.every((event) =>
      Buffer.byteLength(event.payload.summary, 'utf8') <= 4_096)).toBe(true);
    expect(progress.map((event) => event.payload.summary).join('\n')).toContain('phase 0:');
    expect(progress.map((event) => event.payload.summary).join('\n')).toContain('phase 199:');
    expect(JSON.stringify(progress)).toContain(secret);
    const terminal = events.find((event) => event.type === 'tool.succeeded');
    expect(terminal).toBeDefined();
    expect(progress.every((event) => event.sequence < terminal!.sequence)).toBe(true);

    const activities = new UserActivityProjector().project(events, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 1_000,
    }).items;
    expect(activities.filter(({ phase }) => phase === 'progress')).toHaveLength(progress.length);
    expect(JSON.stringify(activities)).toContain(secret);
  });

  it('flushes semantic Handler progress after the time threshold', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: async (context) => {
        context.reportProgress('First durable phase.');
        await wait(70, context.signal);
        context.reportProgress('Second durable phase.');
        return { ok: true };
      },
    });

    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);

    const progress = (await fixture.journal.readProject('project-a', 0, 10_000))
      .filter((event) => event.type === 'tool.progress');
    expect(progress.map((event) => event.payload.summary)).toEqual([
      'First durable phase.', 'Second durable phase.',
    ]);
  });

  it('drops progress reported after the Invocation terminal fact', async () => {
    let context: ToolInvocationExecutionContext | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (seen) => {
        context = seen;
        seen.reportProgress('Before terminal.');
        return { ok: true };
      },
    });

    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    expect(context).toBeDefined();
    context!.reportProgress('Too late.');
    await wait(60, new AbortController().signal);

    const progress = (await fixture.journal.readProject('project-a', 0, 10_000))
      .filter((event) => event.type === 'tool.progress');
    expect(progress.map((event) => event.payload.summary)).toEqual(['Before terminal.']);
  });

  it('keeps a successful Tool outcome when diagnostic progress persistence fails', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        context.reportProgress('This diagnostic write will fail.');
        return { changed: true };
      },
    });
    const realCommit = openToolLifecycleCommitter(fixture.journal).commit;
    const journalFacade = new Proxy(fixture.journal, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) as unknown : value;
      },
    });
    bindToolLifecycleCommitter(journalFacade, async (command, options) => {
      if (command.action === 'progress') {
        throw new Error('Synthetic diagnostic persistence failure.');
      }
      return await realCommit(command, options);
    });
    const { ToolInvocationRuntime } = await runtimeModule();
    const runtime = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(), journal: journalFacade,
    });

    await runtime.resolve();
    const observation = await runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');

    expect(observation.outcome).toBe('succeeded');
    expect(await fixture.journal.countEvents('tool.progress', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
  });

  it('drops malformed progress but persists bounded diagnostic progress', async () => {
    const diagnostic = 'durable-progress-detail';
    let externalEffectCount = 0;
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        externalEffectCount += 1;
        context.reportProgress('');
        context.reportProgress('   ');
        context.reportProgress(`${diagnostic}:${'x'.repeat(256)}`);
        (context.reportProgress as (summary: unknown) => void)({ raw: diagnostic });
        context.reportProgress('External effect completed.');
        return { changed: true };
      },
    });

    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');

    expect(externalEffectCount).toBe(1);
    expect(observation.outcome).toBe('succeeded');
    const events = await fixture.journal.readProject('project-a', 0, 10_000);
    const summaries = events.flatMap((event) => event.type === 'tool.progress'
      ? [event.payload.summary]
      : []);
    expect(summaries.join('\n')).toContain(diagnostic);
    expect(summaries.join('\n')).toContain('External effect completed.');
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
  });

  it('replays an exact progress batch after Journal restart and rejects it after terminal', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    await fixture.runtime.resolve();
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const run = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (invocation === null || run === null) throw new Error('Expected an active Invocation.');
    const lease = {
      ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken,
    };
    const started = await openToolLifecycleCommitter(fixture.journal).commit({
      action: 'start', projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'restart-progress-start', lease,
      expectedRunRevision: run.revision, expectedInvocationRevision: invocation.revision,
      intentDigest: invocation.intentDigest ?? '',
      idempotencyKey: 'restart-progress-attempt', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const progressCommand = {
      action: 'progress' as const,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'restart-progress-batch', lease,
      expectedRunRevision: started.invocation.started!.runRevision,
      expectedInvocationRevision: started.invocation.revision,
      idempotencyKey: 'restart-progress-attempt', attempt: 1,
      summary: 'Persisted before restart.',
    };
    const first = await openToolLifecycleCommitter(fixture.journal).commit(progressCommand);
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const replay = await openToolLifecycleCommitter(reopened).commit(progressCommand);

    expect(replay.events).toEqual(first.events);
    expect(await reopened.countEvents('tool.progress', 'project-a')).toBe(1);

    const finished = await openToolLifecycleCommitter(reopened).commit({
      action: 'finish', projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'restart-progress-finish', lease,
      expectedRunRevision: started.invocation.started!.runRevision,
      expectedInvocationRevision: started.invocation.revision,
      intentDigest: invocation.intentDigest ?? '',
      outcome: 'succeeded', summary: 'Completed.', resultRefs: [],
      modelProjection: { ok: true }, durableSummary: { ok: true },
    });
    await expect(openToolLifecycleCommitter(reopened).commit({
      ...progressCommand,
      commandId: 'late-progress-batch',
      expectedInvocationRevision: finished.invocation.revision,
      summary: 'Must not be appended.',
    })).rejects.toMatchObject({ code: 'INVOCATION_STATE_CONFLICT' });
    expect(await reopened.countEvents('tool.progress', 'project-a')).toBe(1);
  });

  it('rejects Tool progress after durable Run cancellation begins', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    await fixture.runtime.resolve();
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const run = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (invocation === null || run === null) throw new Error('Expected an active Invocation.');
    const lease = {
      ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken,
    };
    const started = await openToolLifecycleCommitter(fixture.journal).commit({
      action: 'start', projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'cancel-progress-start', lease,
      expectedRunRevision: run.revision, expectedInvocationRevision: invocation.revision,
      intentDigest: invocation.intentDigest ?? '',
      idempotencyKey: 'cancel-progress-attempt', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const afterStart = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (afterStart === null) throw new Error('Expected a started Tool Run.');
    const cancelled = await controller.requestCancel({
      commandId: 'cancel-before-progress', expectedRunRevision: afterStart.revision,
    });

    await expect(openToolLifecycleCommitter(fixture.journal).commit({
      action: 'progress', projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'cancelled-progress-batch', lease,
      expectedRunRevision: cancelled.run.revision,
      expectedInvocationRevision: started.invocation.revision,
      idempotencyKey: 'cancel-progress-attempt', attempt: 1,
      summary: 'Must not be appended.',
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(await fixture.journal.countEvents('tool.progress', 'project-a')).toBe(0);
  });

  it('persists the bounded Tool-owned action summary used by the user activity stream', async () => {
    const fixture = await createFixture({
      mode: 'default',
      readResolvePermission: () => ({ externalWrite: true }),
      readPresentation: {
        preparingMessage: '正在执行 SQL。',
        inputPreview: { argument: 'sql', label: 'SQL', language: 'sql' },
      },
    });

    await fixture.runtime.resolve();

    const events = await fixture.journal.readProject('project-a', 0, 100);
    const validated = events
      .find((event) => event.type === 'tool.prepared' &&
        event.invocationId === fixture.readInvocationId);
    expect(validated?.payload).toMatchObject({
      actionSummary: '正在执行 SQL。\nSQL:\nselect 1',
    });
    const approval = events.find((event) => event.type === 'tool.approval_requested' &&
      event.invocationId === fixture.readInvocationId);
    expect(JSON.stringify(approval)).toContain('Mode: default. Actions: write.');
    const activities = new UserActivityProjector().project(events, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    }).items;
    const activity = activities.find((item) => item.kind === 'tool');
    expect(activity).toMatchObject({
      kind: 'tool', phase: 'started',
      summary: '正在执行 SQL。\nSQL:\nselect 1',
      detail: { actionSummary: '正在执行 SQL。\nSQL:\nselect 1' },
    });
    expect(activities.filter((item) => item.kind === 'tool' &&
      item.summary === '正在执行 SQL。\nSQL:\nselect 1')).toHaveLength(1);
    expect(JSON.stringify(activity)).not.toMatch(/arguments|normalizedArgumentsDigest|invocationId/u);
  });

  it('uses the same long bounded action summary for validation and approval', async () => {
    const sql = `select '${'x'.repeat(2_500)}'`;
    const fixture = await createFixture({
      mode: 'default',
      attempt: await toolCallAttemptFixture('long-action-summary', [
        { name: 'query_database', arguments: { sql } },
      ]),
      readResolvePermission: () => ({ externalWrite: true }),
      readPresentation: {
        preparingMessage: '正在执行 SQL。',
        inputPreview: { argument: 'sql', label: 'SQL', language: 'sql' },
      },
    });

    await fixture.runtime.resolve();

    const events = await fixture.journal.readProject('project-a', 0, 100);
    const validated = events.find((event) => event.type === 'tool.prepared');
    const approval = events.find((event) => event.type === 'tool.approval_requested');
    expect(validated?.payload.actionSummary.length).toBeGreaterThan(2_000);
    expect(approval?.payload.summary).toContain(validated?.payload.actionSummary);
    expect(approval?.payload.summary).toContain('Mode: default. Actions: write.');
  });

  it('applies one sealed Runtime Command after the Handler returns and replays without reapplying it', async () => {
    let handlerCalls = 0;
    const fixture = await createFixture({
      mode: 'full-access',
      readToolName: 'tool_search',
      readTimeoutMs: FIXTURE_TOOL_TIMEOUT_MS,
      attempt: await toolCallAttemptFixture('runtime-discovery-activation', [
        { name: 'tool_search', arguments: {} },
      ]),
      readHandler: () => {
        handlerCalls += 1;
        return createRuntimeCommandToolResult({
          command: { kind: 'discovery.activate', payload: { tools: [{ name: 'database_query', toolRevision: 'database_query@1', handlerRevision: 'database_query-handler@1' }], targets: [], bindings: [] } },
          result: { activated: ['database_query'] },
        });
      },
    });

    const { ToolInvocationRuntime } = await runtimeModule();
    let executorCalls = 0;
    const runtime = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(),
      runtimeCommandExecutor: () => { executorCalls += 1; },
    });
    const first = await runtime.execute(fixture.readInvocationId);
    const replay = await runtime.execute(fixture.readInvocationId);

    expect(first).toMatchObject({ outcome: 'succeeded' });
    expect(replay).toEqual(first);
    expect(handlerCalls).toBe(1);
    expect(executorCalls).toBe(1);
    expect(await fixture.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    })).toMatchObject({
      activeTools: [{
        name: 'database_query', toolRevision: 'database_query@1',
        handlerRevision: 'database_query-handler@1',
      }],
      revision: 1,
    });
    expect((await fixture.journal.readProject('project-a', 0, 10_000))
      .filter(({ type }) => type === 'runtime.command_applied')).toHaveLength(1);
  }, 60_000);

  it('gives an Invocation Handler the immutable Runtime Command projection for its exact Run', async () => {
    let seen: ToolInvocationExecutionContext['runtimeState'] | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        seen = context.runtimeState;
        return { ok: true };
      },
    });

    await fixture.runtime.execute(fixture.readInvocationId);
    expect(seen).toMatchObject({
      schemaVersion: 2,
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: fixture.runId,
      revision: 0,
      plan: null,
      activeTools: [],
      discoveredCapabilities: [],
      activeSkills: [],
      children: [],
    });
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('gives Handlers only the immutable discoverable catalog captured for this Turn', async () => {
    let seen: ToolInvocationExecutionContext['discoverableTools'] | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        seen = context.discoverableTools;
        return { ok: true };
      },
    });
    const late = invocationContribution('late_tool', {}, {
      toolRevision: 'late_tool@1', handlerRevision: 'late@1', exposure: 'deferred',
    });
    fixture.registry.registerInvocation(late.definition, late.runtime);

    await fixture.runtime.execute(fixture.readInvocationId);
    expect(seen?.map(({ flatName }) => flatName)).toEqual(['query_database', 'read_result']);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.[0])).toBe(true);
    expect(JSON.stringify(seen)).toMatch(/handlerRevision|invocationRevision/u);
  });

  it('rejects malformed captured Tool identities and Invocation Hooks at construction', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    const { ToolInvocationRuntime } = await runtimeModule();
    const malformedIdentities: readonly unknown[] = [
      [null],
      [{}],
      [{ name: 42, revision: 'query_database@1' }],
      [{ name: 'query_database', revision: false }],
    ];
    for (const identities of malformedIdentities) {
      expect(() => new ToolInvocationRuntime({
        ...fixture.runtimeOptions(),
        allowedTools: identities as readonly Readonly<{ name: string; revision: string }>[],
      })).toThrowError(/Tool Runtime allowed Tool identities require non-empty name and revision/u);
    }

    const malformedHooks: readonly unknown[] = [
      [null],
      [{}],
      [{ id: 'audit', revision: 'audit@1', before: 'not-a-function' }],
      [{ id: 'audit', revision: 'audit@1', after: 42 }],
    ];
    for (const hooks of malformedHooks) {
      expect(() => new ToolInvocationRuntime({
        ...fixture.runtimeOptions(),
        invocationHooks: hooks as readonly AgentInvocationHookContribution[],
      })).toThrowError(/Invocation Hook entries require id, revision, and callable phases/u);
    }
  });

  it('passes the durable Run cancellation signal separately from the bounded Invocation signal', async () => {
    const controller = new AbortController();
    let seenRunSignal: AbortSignal | undefined;
    let seenInvocationSignal: AbortSignal | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: (context) => {
        seenRunSignal = context.runSignal;
        seenInvocationSignal = context.signal;
        return { ok: true };
      },
    });

    await fixture.runtime.execute(fixture.readInvocationId, { signal: controller.signal });
    expect(seenRunSignal).toBe(controller.signal);
    expect(seenInvocationSignal).not.toBe(controller.signal);
    expect(seenRunSignal?.aborted).toBe(false);
    controller.abort();
    expect(seenRunSignal?.aborted).toBe(true);
    expect(seenInvocationSignal?.aborted).toBe(false);
  });

  it('persists a pre-Hook rejection before tool.started and never calls the Handler', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      invocationHooks: [{
        id: 'policy', revision: 'policy@1',
        before: () => ({ reject: 'Project policy rejected this operation.' }),
      }],
    });

    const result = await fixture.runtime.execute(fixture.readInvocationId);

    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_INPUT_INVALID' });
    expect(fixture.readCalls()).toBe(0);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.hook_rejected', 'project-a')).toBe(1);
  });

  it('persists post-Hook failure as a warning without changing external success', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      invocationHooks: [{
        id: 'audit', revision: 'audit@1',
        after: () => { throw new Error('private observer detail'); },
      }],
    });

    const result = await fixture.runtime.execute(fixture.readInvocationId);

    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(fixture.readCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(0);
    const warning = (await fixture.journal.readProject('project-a', 0, 10_000))
      .find(({ type }) => type === 'tool.hook_warning');
    expect(warning?.payload).toMatchObject({ hookId: 'audit', hookRevision: 'audit@1' });
    expect(JSON.stringify(warning)).not.toContain('private observer detail');
  });

  it.each([
    { mode: 'default' as const, permission: { externalWrite: true } as const },
    { mode: 'auto' as const, permission: { destructive: true } as const },
  ])('projects one-time approval into exact permission facts', async ({
    mode,
    permission,
  }) => {
    let authorization: ToolInvocationExecutionContext['authorization'] | undefined;
    const fixture = await createFixture({
      mode,
      readResolvePermission: () => permission,
      readHandler: (context) => {
        authorization = context.authorization;
        return { ok: true };
      },
    });
    await fixture.runtime.resolve();
    const approval = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.readInvocationId,
    });
    expect(approval).toMatchObject({ status: 'pending' });
    await fixture.runtime.decideApproval(fixture.approvalDecision(approval, 'approve'));

    await fixture.runtime.execute(fixture.readInvocationId);
    expect(authorization).toMatchObject({
      policyMode: mode,
      policyDecision: 'ask',
      policyRevision: 'permission-policy:test',
      matchedRuleIds: [],
      permission: {
        toolName: 'query_database', dangerLevel: 'safe', readonly: false,
        access: permission.destructive ? 'destructive' : 'external', recoveryClass: 'idempotent',
        actions: ['write'], paths: [], hosts: [], network: false,
        externalWrite: permission.externalWrite === true, destructive: permission.destructive === true,
        credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [],
      },
      approvalId: approval?.approvalId,
    });
  });

  it('re-evaluates current enterprise rules after approval and audits the execution fence', async () => {
    const permissionManager = new PermissionManager({ revision: 'policy:v1' });
    const fixture = await createFixture({
      mode: 'default',
      permissionManager,
      readResolvePermission: () => ({ externalWrite: true }),
    });
    await fixture.runtime.resolve();
    const approval = await fixture.journal.getApproval({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: fixture.runId,
      invocationId: fixture.readInvocationId,
    });
    await fixture.runtime.decideApproval(fixture.approvalDecision(approval, 'approve'));
    permissionManager.replacePolicy({
      revision: 'policy:v2',
      rules: [{ id: 'emergency-deny', decision: 'deny', tools: ['query_database'] }],
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId)).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'target_changed',
    });
    expect(fixture.readCalls()).toBe(0);
    const started = (await fixture.journal.readProject('project-a', 0, 10_000))
      .find((event) => event.type === 'tool.started' &&
        event.invocationId === fixture.readInvocationId);
    expect(started?.type).toBe('tool.started');
    if (started?.type !== 'tool.started') {
      throw new Error('expected tool.started event');
    }
    expect(started?.payload.permissionAudit).toMatchObject({
      decision: 'deny',
      policyRevision: 'policy:v2',
      matchedRuleIds: ['emergency-deny'],
    });
  });

  it('uses dynamic permission facts for automatic authorization without inventing approval', async () => {
    let authorization: ToolInvocationExecutionContext['authorization'] | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readResolvePermission: () => ({ externalWrite: true }),
      readHandler: (context) => {
        authorization = context.authorization;
        return { ok: true };
      },
    });

    await fixture.runtime.execute(fixture.readInvocationId);
    expect(authorization).toMatchObject({
      policyMode: 'full-access',
      policyDecision: 'allow', matchedRuleIds: [],
      policyRevision: 'permission-policy:test',
      permission: {
        toolName: 'query_database', dangerLevel: 'safe', readonly: false,
        access: 'external', recoveryClass: 'idempotent', actions: ['write'],
        paths: [], hosts: [], network: false, externalWrite: true,
        destructive: false, credentials: false, admin: false, unknownRisk: false,
      },
    });
    expect(await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.readInvocationId,
    })).toBeNull();
  });

  it('resolves dynamic permission from the exact frozen arguments used by the Handler', async () => {
    let resolverArguments: Readonly<Record<string, unknown>> | undefined;
    let handlerArguments: Readonly<Record<string, unknown>> | undefined;
    const fixture = await createFixture({
      mode: 'full-access',
      readResolvePermission: (args) => {
        resolverArguments = args;
        expect(Object.isFrozen(args)).toBe(true);
        return args.sql === 'select 1' ? { actions: ['read'] } : { destructive: true };
      },
      readHandler: (_context, args) => {
        handlerArguments = args;
        return { ok: true };
      },
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(resolverArguments).toEqual({ sql: 'select 1' });
    expect(handlerArguments).toEqual(resolverArguments);
    expect(Object.isFrozen(handlerArguments)).toBe(true);
  });

  it('does not interpret forged, cloned, or ordinary Tool results as Runtime Commands', async () => {
    const forged = await createFixture({
      mode: 'full-access',
      readToolName: 'tool_search',
      attempt: await toolCallAttemptFixture('runtime-discovery-forged', [
        { name: 'tool_search', arguments: {} },
      ]),
      readHandler: () => ({
        ok: true,
        runtimeCommand: { kind: 'discovery.activate', payload: { tools: [], targets: [], bindings: [] } },
      }),
    });
    await expect(forged.runtime.execute(forged.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(await forged.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: forged.runId,
    })).toBeNull();

    const sealed = createRuntimeCommandToolResult({
      command: { kind: 'discovery.activate', payload: { tools: [{ name: 'cloned', toolRevision: 'cloned@1', handlerRevision: 'cloned-handler@1' }], targets: [], bindings: [] } },
      result: { ok: true },
    });
    const cloned = await createFixture({
      mode: 'full-access',
      readToolName: 'tool_search',
      attempt: await toolCallAttemptFixture('runtime-discovery-cloned', [
        { name: 'tool_search', arguments: {} },
      ]),
      readHandler: () => structuredClone(sealed),
    });
    await expect(cloned.runtime.execute(cloned.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(await cloned.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: cloned.runId,
    })).toBeNull();
  });

  it('fails the Tool instead of reporting success when Runtime Command admission fails', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => createRuntimeCommandToolResult({
        command: {
          kind: 'plan.update',
          payload: { planId: 'missing-plan', expectedPlanRevision: 1, plan: {} },
        },
        result: { updated: true },
      }),
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'unknown', errorCode: 'INVALID_TOOL_RESULT' });
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('runtime.command_applied', 'project-a')).toBe(0);
  });

  it('derives Runtime Command authority fields from the Invocation and ignores Handler-supplied headers', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readToolName: 'tool_search',
      attempt: await toolCallAttemptFixture('runtime-discovery-authority', [
        { name: 'tool_search', arguments: {} },
      ]),
      readHandler: () => createRuntimeCommandToolResult({
        command: {
          kind: 'discovery.activate',
          payload: { tools: [{ name: 'trusted-origin', toolRevision: 'trusted-origin@1', handlerRevision: 'trusted-origin-handler@1' }], targets: [], bindings: [] },
          commandId: 'handler-command',
          origin: { runId: 'wrong', turnId: 'wrong', invocationId: 'wrong' },
          expectedRunRevision: 999,
          fencingToken: 999,
        } as never,
        result: { ok: true },
      }),
    });

    const { ToolInvocationRuntime } = await runtimeModule();
    let executorCalls = 0;
    const runtime = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(),
      runtimeCommandExecutor: () => { executorCalls += 1; },
    });
    await expect(runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(executorCalls).toBe(1);
    expect(await fixture.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    })).toMatchObject({
      activeTools: [{
        name: 'trusted-origin', toolRevision: 'trusted-origin@1',
        handlerRevision: 'trusted-origin-handler@1',
      }],
    });
  });

  it('runs the injected post-commit executor on durable child Runtime Command truth and uses its resolved result', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readToolName: 'subagent_spawn',
      attempt: await toolCallAttemptFixture('runtime-child-executor', [
        { name: 'subagent_spawn', arguments: { sql: 'select 1' } },
      ]),
      readHandler: () => createRuntimeCommandToolResult({
        command: {
          kind: 'child.start',
          payload: { task: 'Inspect the child capability.', context: { source: 'test' } },
        },
        result: { state: 'scheduled' },
      }),
    });
    let executorCalls = 0;
    const { ToolInvocationRuntime } = await runtimeModule();
    const runtime = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(),
      runtimeCommandExecutor: ({ command, application, handlerResult, context }) => {
        executorCalls += 1;
        expect(command).toMatchObject({
          kind: 'child.start',
          origin: { invocationId: fixture.readInvocationId },
        });
        expect(application.events.some(({ type }) => type === 'runtime.command_applied')).toBe(true);
        expect(handlerResult).toEqual({ state: 'scheduled' });
        expect(context.invocationId).toBe(fixture.readInvocationId);
        return { state: 'completed' };
      },
    });

    const first = await runtime.execute(fixture.readInvocationId);
    const replay = await runtime.execute(fixture.readInvocationId);
    expect(first).toMatchObject({
      outcome: 'succeeded', modelProjection: { status: 'ok', preview: '{"state":"completed"}' },
    });
    expect(replay).toEqual(first);
    expect(executorCalls).toBe(1);
  });

  it('requires a post-commit executor before applying discovery Runtime Commands', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readToolName: 'tool_search',
      attempt: await toolCallAttemptFixture('runtime-discovery-no-child-executor', [
        { name: 'tool_search', arguments: {} },
      ]),
      readHandler: () => createRuntimeCommandToolResult({
        command: { kind: 'discovery.activate', payload: { tools: [{ name: 'durably-activated', toolRevision: 'durably-activated@1', handlerRevision: 'durably-activated-handler@1' }], targets: [], bindings: [] } },
        result: { state: 'scheduled' },
      }),
    });
    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'unknown', errorCode: 'HANDLER_FAILED' });
    expect(await fixture.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    })).toBeNull();
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(1);
  });

  it('rejects child Runtime Commands before Journal application when no executor is configured', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readToolName: 'subagent_spawn',
      attempt: await toolCallAttemptFixture('runtime-child-no-executor', [
        { name: 'subagent_spawn', arguments: { sql: 'select 1' } },
      ]),
      readHandler: () => createRuntimeCommandToolResult({
        command: {
          kind: 'child.start',
          payload: { task: 'Inspect the project.', context: { source: 'test' } },
        },
        result: { state: 'scheduled' },
      }),
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'unknown', errorCode: 'HANDLER_FAILED' });
    expect(await fixture.journal.getRuntimeCommandProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    })).toBeNull();
    expect(await fixture.journal.countEvents('runtime.command_applied', 'project-a')).toBe(0);
  });

  it('replays a command committed before process loss and reruns the post-commit executor once', async () => {
    const intent = {
      kind: 'child.start' as const,
      payload: { task: 'Recover the child.', context: { source: 'recovery-test' } },
    };
    const fixture = await createFixture({
      mode: 'full-access',
      readEffect: 'idempotent',
      readToolName: 'subagent_spawn',
      attempt: await toolCallAttemptFixture('runtime-child-replay', [
        { name: 'subagent_spawn', arguments: { sql: 'select 1' } },
      ]),
      readHandler: () => createRuntimeCommandToolResult({
        command: intent,
        result: { state: 'scheduled' },
      }),
    });
    await fixture.runtime.resolve();
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const run = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (invocation === null || run === null) throw new Error('Expected an authorized Invocation.');
    await openToolLifecycleCommitter(fixture.journal).commit({
      action: 'start', projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'start-before-runtime-command-crash',
      lease: { ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken },
      expectedRunRevision: run.revision, expectedInvocationRevision: invocation.revision,
      intentDigest: invocation.intentDigest ?? '',
      idempotencyKey: 'runtime-command-recovery', attempt: 1,
      permissionAudit: executionPermissionAudit('idempotent', 'subagent_spawn', 'safe'),
    });
    const runAfterStart = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (runAfterStart === null) throw new Error('Expected a started Tool Run.');
    const command = createRuntimeCommandIssuer().issue({
      schemaVersion: 2,
      commandId: `runtime-command:${fixture.readInvocationId}`,
      origin: { runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId },
      expectedRunRevision: runAfterStart.revision,
      fencingToken: fixture.lease.fencingToken,
      ...intent,
    });
    await openRuntimeCommandApplication(fixture.journal).apply(command);
    await fixture.journal.releaseRunLease({
      projectId: 'project-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken,
    });
    const replacement = await fixture.journal.acquireRunLease({
      projectId: 'project-a', runId: fixture.runId, ownerId: 'recovery-worker',
      ttlMs: FIXTURE_LEASE_TTL_MS,
    });
    let executorCalls = 0;
    const { ToolInvocationRuntime } = await runtimeModule();
    const recovered = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(),
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
        turnId: 'turn-a', lease: replacement, mode: 'full-access',
      },
      runtimeCommandExecutor: ({ application }) => {
        executorCalls += 1;
        return { childRunId: application.projection.children[0]?.childRunId ?? null };
      },
    });

    await expect(recovered.recover(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(executorCalls).toBe(1);
    expect(await fixture.journal.countEvents('runtime.command_applied', 'project-a')).toBe(1);
    expect(fixture.readCalls()).toBe(1);
  });

  it('uses the sanitized completion evidence summary for successful Tool activity', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => ({ ok: true }),
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId)).resolves.toMatchObject({
      outcome: 'succeeded',
      summary: 'The tool completed.',
    });
  });

  it('accepts an ordinary Handler payload without the retired evidence envelope', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => ({ ok: true }),
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId)).resolves.toMatchObject({
      outcome: 'succeeded',
    });
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
  });

  it('replays immutable bounded Tool evidence and redacts completion diagnostics', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => ({ ok: true }),
    });

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation).toMatchObject({
      outcome: 'succeeded',
      modelProjection: { status: 'ok', preview: '{"ok":true}', truncated: false },
    });
    expect(Object.isFrozen(observation)).toBe(true);
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    await reopened.rebuildProjectProjections('project-a');
    expect(await reopened.getInvocation(fixture.readInvocationId)).toMatchObject({
      terminal: { resultRefs: [] },
      observation: {
        outcome: 'succeeded',
        modelProjection: { status: 'ok', preview: '{"ok":true}', truncated: false },
      },
    });
  });

  it('rejects a Provider-requested Tool that was not exposed in the captured Turn', async () => {
    const fixture = await createFixture({ mode: 'full-access', allowedToolNames: ['query_database'] });

    await expect(fixture.runtime.executeEligible()).resolves.toEqual([
      expect.objectContaining({ outcome: 'succeeded' }),
      expect.objectContaining({ outcome: 'failed', errorCode: 'TOOL_NOT_FOUND' }),
    ]);
    expect(fixture.readCalls()).toBe(1);
    expect(fixture.writeCalls()).toBe(0);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(1);
  });

  it('rejects execution when the captured Turn Tool revision is not the runtime revision', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      allowedToolRevisionOverrides: { query_database: 'query_database@stale' },
    });

    await expect(fixture.runtime.execute(fixture.readInvocationId)).resolves.toMatchObject({
      outcome: 'unsupported_revision', errorCode: 'TOOL_REVISION_MISMATCH',
    });
    expect(fixture.readCalls()).toBe(0);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(0);
  });

  it('binds approval to the exact invocation scope, Tool revision, effect, digest and proposed revision', async () => {
    const fixture = await createFixture({ mode: 'default' });
    const schedule = await fixture.runtime.resolve();
    expect(schedule).toEqual({ state: 'ExecutingTools', invocationIds: [fixture.readInvocationId] });
    await fixture.runtime.execute(fixture.readInvocationId);
    expect(await fixture.runtime.resolve()).toEqual({
      state: 'AwaitingUser', reason: 'approval', invocationIds: [fixture.writeInvocationId],
    });

    const approval = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    });
    expect(approval).toMatchObject({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.writeInvocationId,
      canonicalToolId: { name: 'read_result' },
      recoveryClass: 'non_idempotent', proposedRevision: 1, status: 'pending',
    });
    expect(approval?.toolRevision).toBe('read_result@1');
    expect(approval?.intentDigest).toMatch(/^[a-f0-9]{64}$/u);

    await expect(fixture.runtime.decideApproval({
      ...fixture.approvalDecision(approval, 'approve'),
      toolRevision: 'changed-revision',
    })).rejects.toMatchObject({ code: 'APPROVAL_BINDING_MISMATCH' });
    expect(fixture.writeCalls()).toBe(0);
  });

  it.each([
    { change: 'none', schemaChanged: false, recoveryClass: 'read' as const, handlerRevision: 'query_database-handler@1', succeeds: true },
    { change: 'schema', schemaChanged: true, recoveryClass: 'read' as const, handlerRevision: 'query_database-handler@1', succeeds: false },
    { change: 'recovery class', schemaChanged: false, recoveryClass: 'idempotent' as const, handlerRevision: 'query_database-handler@1', succeeds: false },
    { change: 'handler revision', schemaChanged: false, recoveryClass: 'read' as const, handlerRevision: 'query_database@2', succeeds: false },
  ])('binds restart recovery to stable Tool semantics when $change changes', async ({
    schemaChanged, recoveryClass, handlerRevision, succeeds,
  }) => {
    const fixture = await createFixture({ mode: 'full-access' });
    await fixture.runtime.resolve();
    const registry = new ToolRegistry();
    let calls = 0;
    const contribution = invocationContribution('query_database', {}, {
      toolRevision: 'query_database@1', handlerRevision, recoveryClass, exposure: 'direct',
    });
    registry.registerInvocation({
      ...contribution.definition,
      description: 'read fixture',
      dangerLevel: recoveryClass === 'read' ? 'safe' : 'medium',
      readonly: recoveryClass === 'read',
      access: recoveryClass === 'read' ? 'read' : 'write',
      permission: { actions: [recoveryClass === 'read' ? 'read' : 'write'] },
      limits: {
        timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536,
        maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128,
      },
      execution: { concurrency: recoveryClass === 'read' ? 'read' : 'write', timeoutMs: 10_000 },
      inputSchema: {
        type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
        ...(schemaChanged ? { additionalProperties: false } : {}),
      },
    }, {
      ...contribution.runtime,
      execute: () => {
        calls += 1;
        return { ok: true };
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
        outcome: 'unsupported_revision', errorCode: 'TOOL_REVISION_MISMATCH',
      });
      expect(calls).toBe(0);
      expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(0);
    }
  });

  it('makes identical approval decisions idempotent and conflicting decisions typed conflicts', async () => {
    const fixture = await createFixture({ mode: 'default' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    await fixture.runtime.resolve();
    const approval = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    });
    const decision = fixture.approvalDecision(approval, 'approve');

    const first = await fixture.runtime.decideApproval(decision);
    const replay = await fixture.runtime.decideApproval(decision);
    expect(replay).toEqual(first);
    await expect(fixture.runtime.decideApproval({
      ...decision, commandId: 'approval-conflict', decision: 'deny',
    })).rejects.toMatchObject({ code: 'APPROVAL_DECISION_CONFLICT' });
    expect(await fixture.journal.countEvents('tool.authorized', 'project-a')).toBe(2);
  });

  it('loads only the bounded current-Turn Invocation page on the scheduling hot path', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    const legacyRunList = vi.spyOn(fixture.journal, 'listInvocations');
    const turnList = vi.spyOn(fixture.journal, 'listTurnInvocations');

    await fixture.runtime.resolve();

    expect(legacyRunList).not.toHaveBeenCalled();
    expect(turnList).toHaveBeenCalledWith({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', afterActionOrdinal: -1, limit: 256,
    });
  });

  it('executes one Handler and commits exactly one terminal outcome and Observation on duplicate execution', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
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
    const fixture = await createFixture({ mode: 'full-access' });

    await expect(fixture.runtime.execute(fixture.writeInvocationId))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(fixture.readCalls()).toBe(0);
    expect(fixture.writeCalls()).toBe(0);

    const twoReads = await createFixture({
      mode: 'full-access', maxConcurrency: 2,
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
      mode: 'full-access', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('direct-over-concurrency', [
        { name: 'query_database', arguments: { sql: 'select 1' } },
        { name: 'query_database', arguments: { sql: 'select 2' } },
        { name: 'query_database', arguments: { sql: 'select 3' } },
      ]),
    });
    await expect(threeReads.runtime.execute(threeReads.invocationIds[2] ?? ''))
      .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(threeReads.readCalls()).toBe(0);
  }, 2 * 60_000);

  it('commits parallel terminals out of order but applies Observations strictly in action order', async () => {
    const completionOrder: string[] = [];
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('ordered-observations', [
        { name: 'query_database', arguments: { sql: 'slow' } },
        { name: 'query_database', arguments: { sql: 'fast' } },
        { name: 'read_result', arguments: { resultRef: 'after-reads' } },
      ]),
      readHandler: async (context, args) => {
        const sql = String(args.sql);
        await wait(sql === 'slow' ? 40 : 5, context.signal);
        completionOrder.push(sql);
        return { sql };
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
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(3);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(3);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(3);
  });

  it('continues one durable Tool window across independent Journal instances without duplicate Handlers', async () => {
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('durable-parallel-window', [
        { name: 'query_database', arguments: { sql: 'slow' } },
        { name: 'query_database', arguments: { sql: 'fast' } },
      ]),
      readHandler: async (context, args) => {
        await wait(String(args.sql) === 'slow' ? 35 : 5, context.signal);
        return { sql: String(args.sql) };
      },
    });
    await fixture.runtime.resolve();
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const { ToolInvocationRuntime } = await runtimeModule();
    const restarted = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(), journal: reopened,
    });

    const [original, independent] = await Promise.all([
      fixture.runtime.executeEligible(),
      restarted.executeEligible(),
    ]);

    expect([...new Set(
      [...original, ...independent].map(({ invocationId }) => invocationId),
    )].sort()).toEqual([...fixture.invocationIds].sort());
    expect(fixture.readCalls()).toBe(2);
    expect(await reopened.countEvents('tool.started', 'project-a')).toBe(2);
    expect(await reopened.countEvents('tool.succeeded', 'project-a')).toBe(2);
    expect(await reopened.countEvents('tool.observed', 'project-a')).toBe(2);
    await reopened.rebuildProjectProjections('project-a');
    expect((await reopened.listInvocations(fixture.runId)).every(
      ({ state }) => state === 'observed',
    )).toBe(true);
  });

  it('lets a manual Context request rebase two in-flight Tool executions without invalidating settlement', async () => {
    let startedCount = 0;
    let signalBothStarted = (): void => undefined;
    let releaseHandlers = (): void => undefined;
    const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseHandlers = resolve; });
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 2,
      attempt: await toolCallAttemptFixture('manual-queue-tool-window', [
        { name: 'query_database', arguments: { sql: 'select 1' } },
        { name: 'query_database', arguments: { sql: 'select 2' } },
      ]),
      readHandler: async (_context, args) => {
        startedCount += 1;
        if (startedCount === 2) signalBothStarted();
        await release;
        return { sql: String(args.sql) };
      },
    });
    await fixture.runtime.resolve();
    const inFlight = fixture.runtime.executeEligible();
    await bothStarted;
    const current = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (current === null) throw new Error('Expected active Tool Run.');
    const controller = new RunController({
      journal: fixture.journal, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, ownerId: fixture.lease.ownerId,
      leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const queuedRequest = controller.queueContextCompaction({
      commandId: 'queue-context-during-tools', expectedRunRevision: current.revision,
      decisionId: 'decision-during-tools',
    });
    releaseHandlers();
    const queued = await queuedRequest;
    expect(queued.run.revision).toBe(current.revision + 1);

    await expect(inFlight).resolves.toHaveLength(2);
    expect((await fixture.journal.listInvocations(fixture.runId)).map(({ state }) => state))
      .toEqual(['observed', 'observed']);
  });

  it('rejects an old approval submission when steering supersedes a queued Tool window', async () => {
    const fixture = await createFixture({ mode: 'default' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    const approval = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    });
    const current = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (current === null) throw new Error('Expected approval Tool Run.');
    const controller = new RunController({
      journal: fixture.journal, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, ownerId: fixture.lease.ownerId,
      leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const queued = await controller.queueContextCompaction({
      commandId: 'queue-before-steer', expectedRunRevision: current.revision,
      decisionId: 'decision-before-steer',
    });
    await controller.steer({
      commandId: 'steer-after-queue', expectedRunRevision: queued.run.revision,
      clientRequestId: 'steer-request', value: 'change the task',
    });

    await expect(fixture.runtime.decideApproval(
      fixture.approvalDecision(approval, 'approve'),
    )).rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    expect(fixture.writeCalls()).toBe(0);
  });

  it.each(['limit', 'interrupt'] as const)(
    'restores queued Tool work after %s without executing it during Run control',
    async (control) => {
      const fixture = await createFixture({ mode: 'full-access' });
      await fixture.runtime.resolve();
      const current = await fixture.journal.getKernelRunProjection({
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      });
      if (current === null) throw new Error('Expected executable Tool Run.');
      const controller = new RunController({
        journal: fixture.journal, projectId: 'project-a', sessionId: 'session-a',
        runId: fixture.runId, ownerId: fixture.lease.ownerId,
        leaseTtlMs: FIXTURE_LEASE_TTL_MS,
      });
      await controller.acquire();
      const queued = await controller.queueContextCompaction({
        commandId: `queue-before-${control}`, expectedRunRevision: current.revision,
        decisionId: `decision-before-${control}`,
      });
      const suspended = control === 'limit'
        ? await controller.reachLimit({
          commandId: 'limit-after-tool-queue', expectedRunRevision: queued.run.revision,
          limit: 'deadline',
        })
        : await controller.interrupt({
          commandId: 'interrupt-after-tool-queue', expectedRunRevision: queued.run.revision,
          code: 'DEPENDENCY_FAILED',
        });
      await expect(fixture.runtime.execute(fixture.readInvocationId))
        .rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
      expect(fixture.readCalls()).toBe(0);
      await controller.resume({
        commandId: `resume-after-${control}`,
        expectedRunRevision: suspended.run.revision,
        reason: 'resume durable Tool work',
      });
      const resumedRun = await fixture.journal.getKernelRunProjection({
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      });
      expect(resumedRun).toMatchObject({ state: 'ExecutingTools' });
      expect(await fixture.journal.getInvocation(fixture.readInvocationId)).toMatchObject({
        state: 'authorized',
      });
      await expect(fixture.runtime.execute(fixture.readInvocationId))
        .resolves.toMatchObject({ outcome: 'succeeded' });
      expect(fixture.readCalls()).toBe(1);
    },
  );

  it('settles an unstarted Tool as cancelled without running it after queued-window cancellation', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    await fixture.runtime.resolve();
    const current = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (current === null) throw new Error('Expected executable Tool Run.');
    const controller = new RunController({
      journal: fixture.journal, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, ownerId: fixture.lease.ownerId,
      leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const queued = await controller.queueContextCompaction({
      commandId: 'queue-before-cancel', expectedRunRevision: current.revision,
      decisionId: 'decision-before-cancel',
    });
    await controller.requestCancel({
      commandId: 'cancel-after-tool-queue', expectedRunRevision: queued.run.revision,
    });
    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'cancelled' });
    expect(fixture.readCalls()).toBe(0);
  });

  it('rebuilds an active compatibility Tool window before any Tool transition', async () => {
    const fixture = await createFixture({ mode: 'full-access' });

    await fixture.runtime.resolve();
    const current = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (current === null) throw new Error('Expected active Tool Run.');
    const controller = new RunController({
      journal: fixture.journal, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, ownerId: fixture.lease.ownerId,
      leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    await controller.queueContextCompaction({
      commandId: 'queue-before-tool-window-rebuild',
      expectedRunRevision: current.revision,
      decisionId: 'decision-before-tool-window-rebuild',
    });

    await fixture.journal.rebuildProjectProjections('project-a');
    const lease = await fixture.journal.acquireRunLease({
      projectId: 'project-a', runId: fixture.runId, ownerId: 'worker-rebuilt',
      ttlMs: FIXTURE_LEASE_TTL_MS,
    });
    const { ToolInvocationRuntime } = await runtimeModule();
    const reopened = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(),
      binding: {
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, turnId: 'turn-a',
        lease, mode: 'full-access',
      },
    });
    const observations = await reopened.executeEligible();

    expect(observations).toHaveLength(2);
    expect(fixture.readCalls()).toBe(1);
    expect(fixture.writeCalls()).toBe(1);
    expect((await fixture.journal.listInvocations(fixture.runId)).map((item) => item.state))
      .toEqual(['observed', 'observed']);
    expect(await fixture.journal.countEvents('tool.started', 'project-a')).toBe(2);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(2);
  });

  it('lets two Runtime instances race one Invocation without a duplicate Handler call', async () => {
    const fixture = await createFixture({ mode: 'full-access', readDelayMs: 40 });
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
      mode: 'full-access', maxConcurrency: 2,
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
    const fixture = await createFixture({ mode: 'full-access' });
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

  it('maps unknown Handler errors to a bounded raw diagnostic', async () => {
    const secret = 'synthetic-api-key-never-persist';
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => {
        throw new Error(`ECONNRESET ${secret} C:\\Users\\private\\raw-output`);
      },
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const persisted = JSON.stringify(await reopened.readProject('project-a', 0, 100));

    expect(invocation).toMatchObject({
      state: 'observed', terminal: {
        kind: 'unknown', error: {
          code: 'HANDLER_FAILED', category: 'internal', retryable: false, outcome: 'unknown',
        },
      },
    });
    expect(observation.summary).toContain(secret);
    expect(persisted).toContain(secret);
    expect(persisted).toContain('C:\\\\Users\\\\private');
    expect(persisted).toContain('ECONNRESET');
  });

  it('persists a bounded external failure summary without content rewriting', async () => {
    const databasePassword = 'journal-password-never-persist';
    const apiKey = 'sk-journal-api-key-never-persist';
    const fixture = await createFixture({
      mode: 'full-access',
      readHandler: () => {
        throw new ToolExecutionError({
          code: 'HANDLER_FAILED', category: 'external', retryable: false, outcome: 'not_applied',
        }, [
          `PostgreSQL rejected postgresql://app:${databasePassword}@db.example.com/app.`,
          `apiKey=${apiKey}`,
          'Useful provider detail.',
          'x'.repeat(8_192),
        ].join(' '));
      },
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const persisted = JSON.stringify(await reopened.readProject('project-a', 0, 100));

    expect(observation).toMatchObject({ outcome: 'failed', errorCode: 'HANDLER_FAILED' });
    expect(observation.summary).toContain(`PostgreSQL rejected postgresql://app:${databasePassword}@db.example.com/app.`);
    expect(observation.summary).toContain(`apiKey=${apiKey}`);
    expect(observation.summary).toContain('Useful provider detail.');
    expect(observation.summary).toContain('[truncated]');
    expect(observation.summary.length).toBeLessThanOrEqual(4_096);
    expect(persisted).toContain(databasePassword);
    expect(persisted).toContain(apiKey);
    expect(persisted).not.toContain('x'.repeat(4_097));
  });

  it('stages an unbounded result in the Artifact Store and journals only bounded projections and refs', async () => {
    const retained = 'x'.repeat(256 * 1024);
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: true,
      readHandler: () => ({ rows: [{ id: 1 }] }),
      retainedResult: retained,
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(invocation?.terminal?.resultRefs).toHaveLength(1);
    expect(observation.modelProjection).toMatchObject({
      status: 'partial', contentType: 'text/plain; charset=utf-8',
      totalBytes: retained.length, truncated: true,
    });
    expect(JSON.stringify(await fixture.journal.readProject('project-a', 0, 100)).length)
      .toBeLessThan(32 * 1024);
    const handle = invocation?.terminal?.resultRefs[0];
    const artifactEvent = (await fixture.journal.readProject('project-a', 0, 100))
      .find((event) => event.type === 'artifact.created' && event.payload.handle === handle);
    expect(artifactEvent?.type).toBe('artifact.created');
    if (artifactEvent?.type !== 'artifact.created') throw new Error('Artifact fact is missing.');
    expect(artifactEvent.payload.byteSize).toBe(retained.length);
  });

  it('commits parallel Tool Artifacts inside one durable Tool window without retrying either Handler', async () => {
    let signalArtifactCommitPaused = (): void => undefined;
    let releaseArtifactCommit = (): void => undefined;
    const artifactCommitPaused = new Promise<void>((resolve) => {
      signalArtifactCommitPaused = resolve;
    });
    const artifactCommitRelease = new Promise<void>((resolve) => {
      releaseArtifactCommit = resolve;
    });
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 2, artifactStore: true,
      retainedResult: 'x'.repeat(256 * 1024),
      artifactAfterCommitBytesVerified: async () => {
        signalArtifactCommitPaused();
        await artifactCommitRelease;
      },
      attempt: await toolCallAttemptFixture('parallel-artifacts', [
        { name: 'query_database', arguments: { sql: 'left' } },
        { name: 'query_database', arguments: { sql: 'right' } },
      ]),
      readHandler: async (_context, args) => {
        const sql = String(args.sql);
        if (sql === 'right') {
          await artifactCommitPaused;
          return { sql };
        }
        return { sql };
      },
    });

    const executing = fixture.runtime.executeEligible();
    await artifactCommitPaused;
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    releaseArtifactCommit();
    const observations = await executing;
    const invocations = await fixture.journal.listInvocations(fixture.runId);

    expect(observations.map(({ invocationId }) => invocationId)).toEqual(fixture.invocationIds);
    expect(invocations.map(({ state }) => state)).toEqual(['observed', 'observed']);
    expect(invocations.every(({ terminal }) => terminal?.kind === 'succeeded')).toBe(true);
    expect(fixture.readCalls()).toBe(2);
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(2);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(2);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(0);
  });

  it('keeps an atomic successful Tool terminal when Artifact promotion crashes and fresh open promotes it', async () => {
    const raw = 'x'.repeat(256 * 1024);
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: true,
      artifactCrashAt: 'after-journal-before-promotion',
      readHandler: () => ({ rows: [{ id: 1 }] }),
      retainedResult: raw,
    });
    await fixture.runtime.resolve();

    await expect(fixture.runtime.execute(fixture.readInvocationId))
      .rejects.toMatchObject({ code: 'INJECTED_CRASH' });
    const terminal = await fixture.journal.getInvocation(fixture.readInvocationId);
    expect(terminal).toMatchObject({ state: 'succeeded', terminal: { kind: 'succeeded' } });
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(0);
    const invocationTypes = (await fixture.journal.readProject('project-a', 0, 200))
      .filter(({ invocationId }) => invocationId === fixture.readInvocationId)
      .map(({ type }) => type);
    expect(invocationTypes.slice(-3)).toEqual([
      'artifact.created', 'tool.succeeded', 'tool.transition_committed',
    ]);

    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const freshStore = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: join(fixture.directory, 'artifacts'), journal: reopened,
    });
    const gc = await freshStore.collectGarbage(new Date(Date.now() + 48 * 60 * 60 * 1_000));
    expect(gc.stagedObjectsDeleted).toBe(0);
    expect(terminal?.terminal?.resultRefs[0]).toMatch(/^agent-artifact:/u);

    const { ToolInvocationRuntime } = await runtimeModule();
    const restarted = new ToolInvocationRuntime({
      ...fixture.runtimeOptions(), journal: reopened, artifactStore: freshStore,
    });
    await expect(restarted.execute(fixture.readInvocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(fixture.readCalls()).toBe(1);
    expect(await reopened.countEvents('artifact.created', 'project-a')).toBe(1);
  });

  it('accepts only an authentic exact-scope Prepared Artifact and replays its atomic finish once', async () => {
    const fixture = await createFixture({ mode: 'full-access', artifactStore: true });
    if (fixture.artifactStore === undefined) throw new Error('Expected an Artifact Store.');
    await fixture.runtime.resolve();
    const authorized = await fixture.journal.getInvocation(fixture.readInvocationId);
    const kernel = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (authorized === null || kernel === null) throw new Error('Expected an authorized Invocation.');
    const lifecycle = openToolLifecycleCommitter(fixture.journal);
    const lease = {
      ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken,
    };
    const started = await lifecycle.commit({
      action: 'start', projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'prepared-artifact-start', lease,
      expectedRunRevision: kernel.revision, expectedInvocationRevision: authorized.revision,
      intentDigest: authorized.intentDigest ?? '',
      idempotencyKey: 'prepared-artifact-effect', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ rows: [{ id: 1 }] }));
    const staged = await fixture.artifactStore.stage({
      mediaType: 'application/vnd.schemanaut.tool-result+json',
      source: (async function* () { yield await Promise.resolve(bytes); })(),
      expectedByteSize: bytes.byteLength,
    });
    const artifactLifecycle = openToolArtifactCommitter(fixture.artifactStore);
    const prepared = await artifactLifecycle.prepare({
      staged, sessionId: 'session-a', runId: fixture.runId, turnId: 'turn-a',
      invocationId: fixture.readInvocationId, startedAttempt: 1,
      idempotencyKey: 'prepared-artifact-effect', fencingToken: fixture.lease.fencingToken,
      summary: 'Prepared test Artifact.',
    });
    const runAfterStart = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (runAfterStart === null) throw new Error('Expected the started Tool Run.');
    const finish = {
      action: 'finish' as const, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'prepared-artifact-finish', lease,
      expectedRunRevision: runAfterStart.revision,
      expectedInvocationRevision: started.invocation.revision,
      intentDigest: authorized.intentDigest ?? '',
      outcome: 'succeeded' as const, summary: 'Completed.', resultRefs: [staged.handle],
      modelProjection: { rows: [{ id: 1 }] }, durableSummary: { rowCount: 1 },
    };

    try {
      await expect(lifecycle.commit(finish, {
        preparedArtifacts: [structuredClone(prepared)],
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(lifecycle.commit({ ...finish, commandId: 'forged-prepared-finish' }, {
        preparedArtifacts: [Object.freeze({ preparedToolArtifact: true })],
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      for (const [suffix, identity] of [
        ['project', { projectId: 'project-b' }],
        ['session', { sessionId: 'session-b' }],
        ['run', { runId: 'run-b' }],
        ['turn', { turnId: 'turn-b' }],
        ['invocation', { invocationId: 'invocation-b' }],
      ] as const) {
        await expect(lifecycle.commit({
          ...finish, ...identity, commandId: `wrong-prepared-${suffix}`,
        }, { preparedArtifacts: [prepared] }))
          .rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });
      }
      await expect(lifecycle.commit({
        ...finish, commandId: 'mismatched-prepared-ref', resultRefs: [],
      }, { preparedArtifacts: [prepared] }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

      const otherJournal = new SqliteAgentJournal({ filePath: fixture.journalPath });
      await expect(openToolLifecycleCommitter(otherJournal).commit({
        ...finish, commandId: 'wrong-journal-owner',
      }, { preparedArtifacts: [prepared] }))
        .rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
      const otherStore = new ProjectArtifactStore({
        projectId: 'project-a', rootDir: join(fixture.directory, 'artifacts'),
        journal: fixture.journal,
      });
      await expect(openToolArtifactCommitter(otherStore).complete(prepared))
        .rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });

      const first = await lifecycle.commit(finish, { preparedArtifacts: [prepared] });
      const replay = await lifecycle.commit(finish, { preparedArtifacts: [prepared] });
      expect(replay).toEqual(first);
      expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(1);
      expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
      await artifactLifecycle.complete(prepared);
      const transitionsBeforeReuse = await fixture.journal.countEvents(
        'tool.transition_committed', 'project-a',
      );
      await expect(lifecycle.commit({ ...finish, commandId: 'reuse-prepared-capability' }, {
        preparedArtifacts: [prepared],
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(1);
      expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
      expect(await fixture.journal.countEvents('tool.transition_committed', 'project-a'))
        .toBe(transitionsBeforeReuse);
      expect(await fixture.journal.getInvocation(fixture.readInvocationId))
        .toMatchObject({ state: 'succeeded', terminal: { resultRefs: [staged.handle] } });
    } finally {
      artifactLifecycle.release(prepared);
    }
  });

  it.each([
    ['started attempt', { startedAttempt: 2 }],
    ['idempotency key', { idempotencyKey: 'another-effect' }],
    ['fencing token', { fencingToken: 99 }],
  ] as const)('rejects an authentic Prepared Artifact bound to the wrong %s', async (
    _label, overrides,
  ) => {
    const preparedFixture = await createPreparedToolArtifactFixture(overrides);
    const {
      fixture, lifecycle, artifactLifecycle, prepared, finish,
    } = preparedFixture;
    try {
      await expect(lifecycle.commit(finish, { preparedArtifacts: [prepared] }))
        .rejects.toMatchObject({ code: 'INVOCATION_STATE_CONFLICT' });
    } finally {
      artifactLifecycle.release(prepared);
    }
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    expect(invocation?.state).toBe('started');
    expect(invocation?.terminal).toBeUndefined();
  });

  it('holds the Artifact mutation gate until finish or release and later GCs an uncommitted preparation', async () => {
    const preparedFixture = await createPreparedToolArtifactFixture();
    const { fixture, artifactLifecycle, prepared } = preparedFixture;
    const collector = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: join(fixture.directory, 'artifacts'),
      journal: fixture.journal, mutationGateTimeoutMs: 100, stagedOrphanRetentionMs: 0,
    });

    await expect(collector.collectGarbage(new Date(Date.now() + 60_000)))
      .rejects.toMatchObject({ code: 'STORE_BUSY' });
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(0);
    artifactLifecycle.release(prepared);

    const gc = await collector.collectGarbage(new Date(Date.now() + 60_000));
    expect(gc.stagedObjectsDeleted).toBe(1);
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(0);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    expect(invocation?.state).toBe('started');
    expect(invocation?.terminal).toBeUndefined();
  });

  it('rejects mutated or expired staged bytes and releases every failed preparation gate', async () => {
    const fixture = await createFixture({ mode: 'full-access', artifactStore: true });
    const artifactStore = fixture.artifactStore;
    if (artifactStore === undefined) throw new Error('Expected an Artifact Store.');
    const artifactLifecycle = openToolArtifactCommitter(artifactStore);
    const exactScope = {
      sessionId: 'session-a', runId: fixture.runId, turnId: 'turn-a',
      invocationId: fixture.readInvocationId, startedAttempt: 1,
      idempotencyKey: 'prepared-validation', fencingToken: fixture.lease.fencingToken,
      summary: 'Prepared validation Artifact.',
    };
    const original = new TextEncoder().encode('original');
    const mutated = await artifactStore.stage({
      mediaType: 'application/octet-stream',
      source: (async function* () { yield await Promise.resolve(original); })(),
      expectedByteSize: original.byteLength,
    });
    await writeFile(
      join(fixture.directory, 'artifacts', 'staged', `${mutated.artifactId}.blob`),
      new TextEncoder().encode('tampered'),
    );
    await expect(artifactLifecycle.prepare({ staged: mutated, ...exactScope }))
      .rejects.toMatchObject({ code: 'CORRUPT' });

    const expired = await artifactStore.stage({
      mediaType: 'application/octet-stream',
      source: (async function* () { yield await Promise.resolve(original); })(),
      expectedByteSize: original.byteLength,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await expect(artifactLifecycle.prepare({ staged: expired, ...exactScope }))
      .rejects.toMatchObject({ code: 'EXPIRED' });

    const collector = new ProjectArtifactStore({
      projectId: 'project-a', rootDir: join(fixture.directory, 'artifacts'),
      journal: fixture.journal, mutationGateTimeoutMs: 100, stagedOrphanRetentionMs: 0,
    });
    const gc = await collector.collectGarbage(new Date(Date.now() + 60_000));
    expect(gc.stagedObjectsDeleted).toBe(2);
    expect(await fixture.journal.countEvents('artifact.created', 'project-a')).toBe(0);
  });

  it.each([
    ['16 KiB', 16 * 1024],
    ['just above 16 KiB', 16 * 1024 + 1],
    ['just below 32 KiB', 32 * 1024 - 1],
    ['32 KiB', 32 * 1024],
    ['just above 32 KiB', 32 * 1024 + 1],
  ] as const)(
    'materializes explicitly retained %s result content as a Runtime content reference',
    async (_label, retainedBytes) => {
      const retained = jsonStringWithByteSize(retainedBytes);
      const fixture = await createFixture({
        mode: 'full-access', artifactStore: true,
        readHandler: () => ({ ok: true }), retainedResult: retained,
      });
      await fixture.runtime.resolve();
      const observation = await fixture.runtime.execute(fixture.readInvocationId);
      if (observation === undefined) throw new Error('Expected a Tool observation.');
      const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
      const handle = invocation?.terminal?.resultRefs[0];

      expect(handle).toMatch(/^agent-artifact:/u);
      expect(observation.modelProjection).toMatchObject({
        status: 'partial', contentType: 'text/plain; charset=utf-8',
        totalBytes: new TextEncoder().encode(retained).byteLength,
        truncated: true,
      });
      const contentRef = contentReference(observation.modelProjection);
      expect(contentRef).toEqual(expect.any(String));
      await expect(readRetainedArtifact(fixture.artifactStore, contentRef, fixture.runId))
        .resolves.toEqual(retained);
    },
  );

  it.each([
    ['model', 16 * 1024 + 1],
    ['user', 16 * 1024 + 1],
    ['durable', 4 * 1024 + 1],
  ] as const)(
    'materializes a Runtime content reference in the %s projection',
    async (projection, retainedBytes) => {
      const retained = jsonStringWithByteSize(retainedBytes);
      const fixture = await createFixture({
        mode: 'full-access', artifactStore: true,
        readHandler: () => ({ ok: true }), retainedResult: retained,
      });
      await fixture.runtime.resolve();
      const observation = await fixture.runtime.execute(fixture.readInvocationId);
      if (observation === undefined) throw new Error('Expected a Tool observation.');
      const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
      const handle = invocation?.terminal?.resultRefs[0];
      expect(handle).toMatch(/^agent-artifact:/u);
      const projected = projection === 'model'
        ? observation.modelProjection
        : projection === 'user'
          ? invocation?.terminal?.userProjection
          : invocation?.terminal?.durableSummary;
      expect(projected).toMatchObject({
        totalBytes: new TextEncoder().encode(retained).byteLength, truncated: true,
      });
      const contentRef = contentReference(projected);
      expect(contentRef).toEqual(expect.any(String));
      await expect(readRetainedArtifact(fixture.artifactStore, contentRef, fixture.runId))
        .resolves.toEqual(retained);
    },
  );

  it('never commits a referenced placeholder when the required Artifact cannot be created', async () => {
    const retained = jsonStringWithByteSize(16 * 1024 + 1);
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: false,
      readHandler: () => ({ ok: true }), retainedResult: retained,
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation.outcome).toBe('unknown');
    expect(invocation?.terminal?.kind).toBe('unknown');
    expect(invocation?.terminal?.resultRefs).toEqual([]);
    expect(JSON.stringify(invocation?.terminal)).not.toContain('bounded-projection');
  });

  it('records an unknown outcome when a risky Handler completed but its required Artifact failed', async () => {
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: false, readEffect: 'non_idempotent',
      readHandler: () => ({ ok: true }), retainedResult: jsonStringWithByteSize(16 * 1024 + 1),
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation.outcome).toBe('unknown');
    expect(invocation?.terminal).toMatchObject({
      kind: 'unknown', resultRefs: [], error: { outcome: 'unknown' },
    });
    expect(JSON.stringify(invocation?.terminal)).not.toContain('bounded-projection');
  });

  it('preserves raw diagnostics in the retained result artifact', async () => {
    const apiKey = 'fake-api-key-result-value';
    const password = 'never-persist-password';
    const localPath = 'C:\\Users\\private\\result.json';
    const stack = 'Error: private\n    at C:\\Users\\private\\handler.js:1:1';
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: true, readEffect: 'non_idempotent',
      readHandler: () => ({ businessPath: '/orders/42', ok: true }),
      retainedResult: `/orders/42 apiKey=${apiKey} password=${password} path=${localPath} ${stack}`,
    });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = await fixture.journal.readProject('project-a', 0, 100);
    const persisted = JSON.stringify(events);
    if (observation === undefined) throw new Error('Expected a Tool observation.');

    expect(observation).toMatchObject({
      outcome: 'succeeded',
      modelProjection: {
        status: 'partial', contentType: 'text/plain; charset=utf-8',
        totalBytes: `/orders/42 apiKey=${apiKey} password=${password} path=${localPath} ${stack}`.length, truncated: true,
      },
    });
    expect(invocation?.terminal).toMatchObject({
      kind: 'succeeded',
      durableSummary: { truncated: true },
      userProjection: { truncated: true },
    });
    expect(fixture.readCalls()).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(0);
    for (const detail of [apiKey, password, localPath, stack]) expect(persisted).not.toContain(detail);

    const contentRef = contentReference(observation.modelProjection);
    expect(contentRef).toEqual(expect.any(String));
    const artifactText = await readRetainedArtifact(fixture.artifactStore, contentRef, fixture.runId);
    for (const detail of [apiKey, password, localPath, stack]) {
      expect(artifactText).toContain(detail);
    }
    expect(artifactText).toContain('/orders/42');
  });

  it('bounds dispatch, stops undispatched work on cancellation, and propagates AbortSignal to started Handlers', async () => {
    const fixture = await createFixture({ mode: 'full-access', readDelayMs: 5_000, maxConcurrency: 1 });
    await fixture.runtime.resolve();
    const controller = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: controller.signal });
    await fixture.waitUntilReadStarted();
    controller.abort('cancelled by test');
    const observations = await execution;

    expect(fixture.sawReadAbort()).toBe(true);
    expect(fixture.writeCalls()).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: 'unknown' });
  });

  it('maps caller cancellation during cooperative preparation without validation failure', async () => {
    const fixture = await createFixture({
      mode: 'full-access', readPrepareAwaitAbort: true,
    });
    const controller = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: controller.signal });
    await fixture.waitUntilReadPreparationStarted();
    controller.abort('cancel preparation');

    await expect(execution).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        invocationId: fixture.readInvocationId,
        outcome: 'cancelled',
        errorCode: 'TOOL_CANCELLED',
      }),
    ]));
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = (await fixture.journal.readProject('project-a', 0, 100))
      .filter((event) => event.invocationId === fixture.readInvocationId)
      .map((event) => event.type);

    expect(invocation).toMatchObject({ state: 'observed', terminal: { kind: 'cancelled' } });
    expect(events.indexOf('tool.prepared')).toBeGreaterThanOrEqual(0);
    expect(events).not.toContain('tool.started');
    expect(events.filter((type) => type === 'tool.cancelled')).toHaveLength(1);
    expect(events).not.toContain('tool.failed');
    expect(fixture.readCalls()).toBe(0);
  }, 1_000);

  it('maps a cooperative preparation deadline without validation failure', async () => {
    const fixture = await createFixture({
      mode: 'full-access', readTimeoutMs: 10, readPrepareAwaitAbort: true,
    });

    await expect(fixture.runtime.executeEligible()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        invocationId: fixture.readInvocationId,
        outcome: 'timed_out',
        errorCode: 'TOOL_TIMEOUT',
      }),
    ]));
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = (await fixture.journal.readProject('project-a', 0, 100))
      .filter((event) => event.invocationId === fixture.readInvocationId)
      .map((event) => event.type);

    expect(invocation).toMatchObject({ state: 'observed', terminal: { kind: 'timed_out' } });
    expect(events.indexOf('tool.prepared')).toBeGreaterThanOrEqual(0);
    expect(events).not.toContain('tool.started');
    expect(events.filter((type) => type === 'tool.timed_out')).toHaveLength(1);
    expect(events).not.toContain('tool.failed');
    expect(fixture.readCalls()).toBe(0);
  });

  it('bounds an uncooperative preparation at the caller cancellation boundary', async () => {
    const fixture = await createFixture({
      mode: 'full-access', readPrepareNeverSettles: true,
    });
    const controller = new AbortController();
    const resolution = fixture.runtime.resolve({ signal: controller.signal });
    await fixture.waitUntilReadPreparationStarted();
    controller.abort('cancel uncooperative preparation');

    await expect(resolution).resolves.toMatchObject({ state: 'ApplyingObservations' });
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = (await fixture.journal.readProject('project-a', 0, 100))
      .filter((event) => event.invocationId === fixture.readInvocationId)
      .map((event) => event.type);

    expect(invocation).toMatchObject({ state: 'cancelled', terminal: { kind: 'cancelled' } });
    expect(events).toContain('tool.cancelled');
    expect(events).not.toContain('tool.failed');
    expect(events).not.toContain('tool.started');
    expect(fixture.readCalls()).toBe(0);
  });

  it('bounds an uncooperative preparation at its own deadline', async () => {
    const fixture = await createFixture({
      mode: 'full-access', readTimeoutMs: 10, readPrepareNeverSettles: true,
    });

    await expect(fixture.runtime.resolve()).resolves.toMatchObject({ state: 'ApplyingObservations' });
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
    const events = (await fixture.journal.readProject('project-a', 0, 100))
      .filter((event) => event.invocationId === fixture.readInvocationId)
      .map((event) => event.type);

    expect(invocation).toMatchObject({ state: 'timed_out', terminal: { kind: 'timed_out' } });
    expect(events).toContain('tool.timed_out');
    expect(events).not.toContain('tool.failed');
    expect(events).not.toContain('tool.started');
    expect(fixture.readCalls()).toBe(0);
  });

  it('atomically observes every proposed Tool when cancellation precedes resolution', async () => {
    const fixture = await createFixture({ mode: 'full-access' });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const active = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (active === null) throw new Error('Expected an active Kernel Run.');

    const requested = await controller.requestCancel({
      commandId: 'cancel-before-tool-resolution', expectedRunRevision: active.revision,
    });
    expect(requested.run.state).toBe('Cancelling');
    const invocations = await fixture.journal.listInvocations(fixture.runId);
    expect(invocations.map(({ state }) => state)).toEqual(['observed', 'observed']);
    expect(invocations.map(({ terminal }) => terminal?.kind)).toEqual(['cancelled', 'cancelled']);
    expect(invocations.map(({ observation }) => observation?.outcome))
      .toEqual(['cancelled', 'cancelled']);
    expect(fixture.readCalls()).toBe(0);
    expect(fixture.writeCalls()).toBe(0);

    const settled = await controller.settleCancellation({
      commandId: 'settle-before-tool-resolution', expectedRunRevision: requested.run.revision,
    });
    expect(settled.run.state).toBe('Cancelled');
  });

  it('denies and observes pending approval when the Run is cancelled', async () => {
    const fixture = await createFixture({ mode: 'default' });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    await fixture.runtime.resolve();
    const pending = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    });
    expect(pending?.status).toBe('pending');
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    const active = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (active === null) throw new Error('Expected an active Kernel Run.');

    const requested = await controller.requestCancel({
      commandId: 'cancel-pending-tool-approval', expectedRunRevision: active.revision,
    });
    expect((await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    }))?.status)
      .toBe('denied');
    expect(await fixture.journal.getInvocation(fixture.writeInvocationId)).toMatchObject({
      state: 'observed', terminal: { kind: 'denied' }, observation: { outcome: 'denied' },
    });
    expect(fixture.writeCalls()).toBe(0);
    await expect(controller.settleCancellation({
      commandId: 'settle-pending-tool-approval', expectedRunRevision: requested.run.revision,
    })).resolves.toMatchObject({ run: { state: 'Cancelled' } });
  });

  it.each([
    ['read', 'unknown'],
    ['idempotent', 'unknown'],
    ['transactional', 'unknown'],
    ['non_idempotent', 'unknown'],
  ] as const)(
    'settles a stale started %s Tool after cancellation and restart without rerunning its Handler',
    async (effect, expectedOutcome) => {
      const fixture = await createFixture({ mode: 'full-access', maxConcurrency: 1, readEffect: effect });
      await fixture.runtime.resolve();
      const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);
      const active = await fixture.journal.getKernelRunProjection({
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      });
      if (invocation === null || active === null) throw new Error('Expected an active Invocation.');
      await openToolLifecycleCommitter(fixture.journal).commit({
        action: 'start', projectId: 'project-a', sessionId: 'session-a',
        runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId,
        commandId: `start-before-restart-${effect}`,
        lease: { ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken },
        expectedRunRevision: active.revision, expectedInvocationRevision: invocation.revision,
        intentDigest: invocation.intentDigest ?? '',
        idempotencyKey: `restart-${effect}`, attempt: 1,
        permissionAudit: executionPermissionAudit(effect, 'query_database', 'safe'),
      });
      const controller = new RunController({
        journal: fixture.journal,
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
        ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
      });
      await controller.acquire();
      const afterStart = await fixture.journal.getKernelRunProjection({
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      });
      if (afterStart === null) throw new Error('Expected a started Tool Run.');
      await controller.requestCancel({
        commandId: `cancel-before-restart-${effect}`, expectedRunRevision: afterStart.revision,
      });
      const oldFence = controller.currentLease().fencingToken;
      await expect(controller.release()).resolves.toBe(true);

      const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
      const replacement = await reopened.acquireRunLease({
        projectId: 'project-a', runId: fixture.runId,
        ownerId: `replacement-${effect}`, ttlMs: FIXTURE_LEASE_TTL_MS,
      });
      expect(replacement.fencingToken).toBe(oldFence + 1);
      const { ToolInvocationRuntime } = await runtimeModule();
      const restarted = new ToolInvocationRuntime({
        ...fixture.runtimeOptions(), journal: reopened,
        binding: {
          projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
          turnId: 'turn-a', lease: replacement, mode: 'full-access',
        },
      });

      await expect(restarted.recover(fixture.readInvocationId))
        .resolves.toMatchObject({ outcome: expectedOutcome, errorCode: 'TOOL_CANCELLED' });
      expect(fixture.readCalls()).toBe(0);
      expect(await reopened.getInvocation(fixture.readInvocationId)).toMatchObject({
        state: 'observed', terminal: { kind: expectedOutcome },
        observation: { outcome: expectedOutcome },
      });
      const replacementController = new RunController({
        journal: reopened,
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
        ownerId: replacement.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
      });
      await replacementController.acquire();
      const cancelling = await reopened.getKernelRunProjection({
        projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      });
      if (cancelling === null) throw new Error('Expected a cancelling Run.');
      await expect(replacementController.settleCancellation({
        commandId: `settle-after-restart-${effect}`, expectedRunRevision: cancelling.revision,
      })).resolves.toMatchObject({ run: { state: 'Cancelled' } });
    },
  );

  it('rebuilds a cancelling Tool window and settles it under one higher fencing token', async () => {
    const fixture = await createFixture({ mode: 'full-access', readDelayMs: 5_000, maxConcurrency: 1 });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    await fixture.runtime.resolve();
    const cancellation = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: cancellation.signal });
    await fixture.waitUntilReadStarted();
    const active = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (active === null) throw new Error('Expected an active Tool Run.');
    await controller.requestCancel({
      commandId: 'cancel-before-projection-rebuild', expectedRunRevision: active.revision,
    });
    cancellation.abort('cancel before rebuild');
    await expect(execution).resolves.toEqual([
      expect.objectContaining({ outcome: 'unknown' }),
    ]);
    const oldFence = controller.currentLease().fencingToken;

    await fixture.journal.rebuildProjectProjections('project-a');
    await expect(controller.release()).resolves.toBe(false);
    expect((await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    }))?.state).toBe('Cancelling');
    expect((await fixture.journal.listInvocations(fixture.runId)).map(({ state }) => state))
      .toEqual(['observed', 'observed']);
    const replacement = await fixture.journal.acquireRunLease({
      projectId: 'project-a', runId: fixture.runId,
      ownerId: 'replacement-after-rebuild', ttlMs: FIXTURE_LEASE_TTL_MS,
    });
    expect(replacement.fencingToken).toBe(oldFence + 1);
    const replacementController = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: replacement.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await replacementController.acquire();
    const rebuilt = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (rebuilt === null) throw new Error('Expected the rebuilt cancelling Run.');
    await expect(replacementController.settleCancellation({
      commandId: 'settle-after-projection-rebuild', expectedRunRevision: rebuilt.revision,
    })).resolves.toMatchObject({ run: { state: 'Cancelled' } });
    await expect(fixture.journal.getTurnLifecycle({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, turnId: 'turn-a',
    })).resolves.toMatchObject({ status: 'closed' });
  });

  it('settles Run cancellation through an in-flight Tool without leaving a started Invocation', async () => {
    const fixture = await createFixture({ mode: 'full-access', readDelayMs: 5_000, maxConcurrency: 1 });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    await fixture.runtime.resolve();
    const cancellation = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: cancellation.signal });
    await fixture.waitUntilReadStarted();
    const running = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (running === null) throw new Error('Expected an active Kernel Run.');
    const requested = await controller.requestCancel({
      commandId: 'cancel-in-flight-tool', expectedRunRevision: running.revision,
      reason: 'Operator cancelled the Run.',
    });
    cancellation.abort('Operator cancelled the Run.');

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ outcome: 'unknown' }),
    ]);
    const afterToolSettlement = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (afterToolSettlement === null) throw new Error('Expected a cancelling Kernel Run.');
    expect(afterToolSettlement.state).toBe('Cancelling');
    expect(afterToolSettlement.revision).toBeGreaterThan(requested.run.revision);
    const settled = await controller.settleCancellation({
      commandId: 'settle-in-flight-tool-cancellation',
      expectedRunRevision: afterToolSettlement.revision,
    });
    expect(settled.run.state).toBe('Cancelled');
    const invocations = await fixture.journal.listInvocations(fixture.runId);
    expect(invocations.map((item) => item.state)).toEqual(['observed', 'observed']);
    expect(invocations.map(({ terminal }) => terminal?.kind)).toEqual([
      'unknown', 'cancelled',
    ]);
    expect(fixture.readCalls()).toBe(1);
    expect(fixture.writeCalls()).toBe(0);
  });

  it('preserves a Handler success committed after cancellation was requested and then settles the Run', async () => {
    let release = (): void => undefined;
    const result = new Promise<unknown>((resolve) => {
      release = () => resolve({ rows: [{ value: 1 }] });
    });
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 1, readHandler: () => result,
    });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    await fixture.runtime.resolve();
    const execution = fixture.runtime.executeEligible();
    await fixture.waitUntilReadStarted();
    const running = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (running === null) throw new Error('Expected an active Kernel Run.');
    await controller.requestCancel({
      commandId: 'cancel-before-handler-success', expectedRunRevision: running.revision,
      reason: 'Operator cancelled while the Handler was finishing.',
    });
    release();

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ outcome: 'succeeded' }),
    ]);
    const cancelling = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (cancelling === null) throw new Error('Expected a cancelling Run.');
    const settled = await controller.settleCancellation({
      commandId: 'settle-after-handler-success', expectedRunRevision: cancelling.revision,
    });
    expect(settled.run.state).toBe('Cancelled');
    const invocations = await fixture.journal.listInvocations(fixture.runId);
    expect(invocations.map(({ terminal }) => terminal?.kind)).toEqual([
      'succeeded', 'cancelled',
    ]);
    expect(fixture.readCalls()).toBe(1);
    expect(fixture.writeCalls()).toBe(0);
  });

  it('records an explicit unknown outcome when cancellation interrupts a non-idempotent Handler', async () => {
    let applyLateEffect = (): void => undefined;
    let effects = 0;
    const result = new Promise<unknown>((resolve) => {
      applyLateEffect = () => {
        effects += 1;
        resolve({ effects });
      };
    });
    const fixture = await createFixture({
      mode: 'full-access', maxConcurrency: 1, readEffect: 'non_idempotent',
      readHandler: () => result,
    });
    const controller = new RunController({
      journal: fixture.journal,
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      ownerId: fixture.lease.ownerId, leaseTtlMs: FIXTURE_LEASE_TTL_MS,
    });
    await controller.acquire();
    await fixture.runtime.resolve();
    const cancellation = new AbortController();
    const execution = fixture.runtime.executeEligible({ signal: cancellation.signal });
    await fixture.waitUntilReadStarted();
    const running = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (running === null) throw new Error('Expected an active Kernel Run.');
    await controller.requestCancel({
      commandId: 'cancel-risky-handler', expectedRunRevision: running.revision,
      reason: 'Operator cancelled a non-idempotent Handler.',
    });
    cancellation.abort();

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ outcome: 'unknown', errorCode: 'TOOL_CANCELLED' }),
    ]);
    const cancelling = await fixture.journal.getKernelRunProjection({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
    });
    if (cancelling === null) throw new Error('Expected a cancelling Run.');
    const settled = await controller.settleCancellation({
      commandId: 'settle-risky-handler-cancel', expectedRunRevision: cancelling.revision,
    });
    expect(settled.run.state).toBe('Cancelled');
    expect((await fixture.journal.getInvocation(fixture.readInvocationId))?.terminal)
      .toMatchObject({ kind: 'unknown', error: { outcome: 'unknown' } });
    applyLateEffect();
    await wait(25, new AbortController().signal);
    expect(effects).toBe(1);
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(fixture.readCalls()).toBe(1);
  });

  it('uses descriptor timeout metadata and never parses an Error message to classify timeout', async () => {
    const fixture = await createFixture({ mode: 'full-access', readDelayMs: 100, readTimeoutMs: 10 });
    await fixture.runtime.resolve();
    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    const invocation = await fixture.journal.getInvocation(fixture.readInvocationId);

    expect(observation).toMatchObject({ outcome: 'timed_out', errorCode: 'TOOL_TIMEOUT' });
    expect(invocation?.terminal?.error).toMatchObject({
      code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied',
    });
  });

  it('converges invalid arguments to one typed Observation without calling a Handler', async () => {
    const fixture = await createFixture({
      mode: 'default',
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
    const events = await fixture.journal.readProject('project-a', 0, 100);
    const invalidValidation = events.find((event) =>
      event.type === 'tool.prepared' && 'validationError' in event.payload);
    if (invalidValidation?.type !== 'tool.prepared' ||
      !('validationError' in invalidValidation.payload)) {
      throw new Error('Expected the rejected validation event.');
    }
    const activities = new UserActivityProjector().project(
      events,
      { projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100 },
    ).items;
    expect(activities).not.toContainEqual(expect.objectContaining({
      kind: 'tool', phase: 'started', summary: invalidValidation.payload.actionSummary,
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      kind: 'result', phase: 'failed',
    }));
  });

  it('converges an unavailable Tool to one typed Observation without orphaning proposed work', async () => {
    const fixture = await createFixture({ mode: 'default', registerRead: false });

    const observations = await fixture.runtime.executeEligible();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: 'failed', errorCode: 'TOOL_NOT_FOUND' });
    expect((await fixture.journal.getInvocation(fixture.readInvocationId))?.state).toBe('observed');
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('validates representative JSON Schema 2020-12 Tool arguments', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
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
      { late: true },
    ); });
    const fixture = await createFixture({
      mode: 'full-access', readTimeoutMs: 10, readHandler: () => blocked,
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation).toMatchObject({ outcome: 'timed_out', errorCode: 'TOOL_TIMEOUT' });
    release();
    await wait(25, new AbortController().signal);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.timed_out', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it.each([
    { effect: 'idempotent' as const, outcome: 'unknown', unknownEvents: 1 },
    { effect: 'transactional' as const, outcome: 'unknown', unknownEvents: 1 },
    { effect: 'non_idempotent' as const, outcome: 'unknown', unknownEvents: 1 },
  ])('maps an opaque $effect Handler failure by its declared effect', async ({
    effect, outcome, unknownEvents,
  }) => {
    const fixture = await createFixture({
      mode: 'full-access', readEffect: effect,
      readHandler: () => { throw new Error('opaque native failure'); },
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    expect(observation).toMatchObject({ outcome, errorCode: 'HANDLER_FAILED' });
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a'))
      .toBe(unknownEvents);
    expect(await fixture.journal.countEvents('tool.failed', 'project-a'))
      .toBe(unknownEvents === 0 ? 1 : 0);
  });

  it('uses one exact dynamic effect for persisted scheduling and failure classification', async () => {
    const fixture = await createFixture({
      mode: 'full-access',
      readEffect: 'non_idempotent',
      readResolveEffect: (args) => String(args.sql).toUpperCase().startsWith('SELECT')
        ? 'read'
        : 'non_idempotent',
      readHandler: () => { throw new Error('query failed before application'); },
    });

    const result = await fixture.runtime.execute(fixture.readInvocationId);

    expect(result).toMatchObject({ outcome: 'unknown', errorCode: 'HANDLER_FAILED' });
    expect((await fixture.journal.getInvocation(fixture.readInvocationId))?.recoveryClass).toBe('read');
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(1);
  });

  it('times out before dispatch when the bounded invocation deadline expires', async () => {
    let applyEffect = (): void => undefined;
    let effects = 0;
    const blocked = new Promise<unknown>((resolve) => {
      applyEffect = () => {
        effects += 1;
        resolve({ effects });
      };
    });
    const fixture = await createFixture({
      mode: 'full-access', readEffect: 'non_idempotent', readTimeoutMs: 10,
      readHandler: () => blocked,
    });
    await fixture.runtime.resolve();

    const observation = await fixture.runtime.execute(fixture.readInvocationId);
    if (observation === undefined) throw new Error('Expected a Tool observation.');
    expect(observation.outcome).toBe('timed_out');
    applyEffect();
    await wait(25, new AbortController().signal);
    expect(effects).toBe(1);
    expect(await fixture.journal.countEvents('tool.cancelled', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(0);
    expect(fixture.readCalls()).toBe(0);
  });

  it.each([
    ['small', 'user-visible'],
    ['large', 'x'.repeat(256 * 1024)],
  ])('keeps the %s user projection recoverable after Journal rebuild', async (_kind, value) => {
    const fixture = await createFixture({
      mode: 'full-access', artifactStore: true,
      readHandler: () => ({ ok: true }), retainedResult: value,
    });
    await fixture.runtime.resolve();
    await fixture.runtime.execute(fixture.readInvocationId);
    const before = await fixture.journal.getInvocation(fixture.readInvocationId);

    await fixture.journal.rebuildProjectProjections('project-a');
    const after = await fixture.journal.getInvocation(fixture.readInvocationId);
    expect(after?.terminal?.userProjection).toEqual(before?.terminal?.userProjection);
    expect(after?.terminal?.userProjection).toMatchObject({
      totalBytes: new TextEncoder().encode(value).byteLength,
      truncated: true,
    });
    expect(contentReference(after?.terminal?.userProjection)).toEqual(expect.any(String));
    expect(after?.terminal?.resultRefs).toHaveLength(1);
  });

  it('atomically projects mixed Tool lifecycle state and rebuilds the same Run aggregate', async () => {
    const fixture = await createFixture({ mode: 'default' });

    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('ResolvingActions');
    await fixture.runtime.resolve();
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('ExecutingTools');
    await fixture.runtime.execute(fixture.readInvocationId);
    expect((await fixture.journal.getRunProjection(fixture.runId))?.state).toBe('AwaitingUser');
    const approval = await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId, invocationId: fixture.writeInvocationId,
    });
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
  mode: 'default' | 'auto' | 'full-access';
  onReadPrepare?: (policy: Readonly<{ mode: string; revision: string }>) => void;
  permissionManager?: PermissionManager;
  maxConcurrency?: number;
  readDelayMs?: number;
  readTimeoutMs?: number;
  readPrepareAwaitAbort?: boolean;
  readPrepareNeverSettles?: boolean;
  artifactStore?: boolean;
  artifactAfterCommitBytesVerified?: () => Promise<void>;
  artifactCrashAt?: 'after-journal-before-promotion';
  readHandler?: (
    context: ToolInvocationExecutionContext,
    args: Readonly<Record<string, unknown>>,
  ) => unknown;
  readEffect?: 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
  readResolveEffect?: (
    args: Record<string, unknown>,
  ) => 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
  readInputSchema?: Record<string, unknown>;
  readResolvePermission?: (args: Record<string, unknown>) => AgentToolPermissionDeclaration;
  readPresentation?: AgentToolPresentation;
  retainedResult?: string;
  readToolName?: string;
  registerRead?: boolean;
  attempt?: ValidatedModelAttempt;
  allowedToolNames?: readonly string[];
  allowedToolRevisionOverrides?: Readonly<Record<string, string>>;
  invocationHooks?: readonly AgentInvocationHookContribution[];
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
    projectId: 'project-a', runId: created.runId, ownerId: 'worker-a',
    ttlMs: FIXTURE_LEASE_TTL_MS,
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
    billingMode: 'byok',
    attempt: options.attempt ?? await validatedAttemptFixture('task-5-attempt'),
  });
  let registry: ToolRegistry;
  const readToolName = options.readToolName ?? 'query_database';
  let readCallCount = 0;
  let writeCallCount = 0;
  let readStarted = false;
  let readAborted = false;
  let signalReadStarted = (): void => undefined;
  const readStartedPromise = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  let readPreparationStarted = false;
  let signalReadPreparationStarted = (): void => undefined;
  const readPreparationStartedPromise = new Promise<void>((resolve) => {
    signalReadPreparationStarted = resolve;
  });
  const executeRead = async (
    argumentsRecord: Readonly<Record<string, unknown>>,
    context: ToolInvocationExecutionContext,
  ) => {
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
      return options.readHandler?.(context, argumentsRecord) ?? { rows: [{ value: 1 }] };
    };
  if (readToolName === 'tool_search') {
    registry = fixedBaselineRegistry({
      handlers: { tool_search: executeRead },
      ...(options.readTimeoutMs === undefined
        ? {}
        : { timeoutMsByTool: { tool_search: options.readTimeoutMs } }),
    });
    for (const name of ['database_query', 'trusted-origin', 'durably-activated', 'cloned']) {
      const contribution = invocationContribution(name, {}, { exposure: 'deferred' });
      registry.registerInvocation(contribution.definition, contribution.runtime);
    }
  } else {
    registry = new ToolRegistry();
  }
  if (options.registerRead !== false && readToolName !== 'tool_search') registry.registerInvocation({
    name: readToolName, description: 'read fixture', dangerLevel: 'safe',
    readonly: (options.readEffect ?? 'read') === 'read',
    source: 'unknown', access: (options.readEffect ?? 'read') === 'read' ? 'read' : 'write', recoveryClass: options.readEffect ?? 'read',
    toolRevision: `${readToolName}@1`, handlerRevision: `${readToolName}-handler@1`,
    intentRevision: 'prepared-tool-intent.v1',
    permission: { actions: ['read'] }, exposure: 'direct',
    ...(options.readPresentation === undefined
      ? {}
      : { presentation: options.readPresentation }),
    limits: { timeoutMs: options.readTimeoutMs ?? 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
    outputSchema: { type: 'object' },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    inputSchema: options.readInputSchema ?? {
      type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
    },
    execution: {
      concurrency: options.readEffect === undefined || options.readEffect === 'read' ? 'read' : 'write',
      timeoutMs: options.readTimeoutMs ?? 10_000,
    },
  }, {
    revision: { toolName: readToolName, toolRevision: `${readToolName}@1`, handlerRevision: `${readToolName}-handler@1`, intentRevision: 'prepared-tool-intent.v1' },
    prepare: async (input, context) => {
      options.onReadPrepare?.(context.runPolicy);
      readPreparationStarted = true;
      signalReadPreparationStarted();
      if (options.readPrepareNeverSettles) {
        await new Promise<never>(() => undefined);
      }
      if (options.readPrepareAwaitAbort) {
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      }
      const declared = options.readResolvePermission?.(input) ?? {};
      const recoveryClass = options.readResolveEffect?.(input) ??
        options.readEffect ?? (declared.destructive || declared.externalWrite ? 'idempotent' : 'read');
      const access = declared.destructive ? 'destructive' : declared.externalWrite
        ? 'external' : recoveryClass === 'read' ? 'read' : 'write';
      const readonly = access === 'read';
      const preview = options.readPresentation?.inputPreview;
      const previewValue = preview === undefined ? undefined : input[preview.argument];
      const actionSummary = preview === undefined || typeof previewValue !== 'string'
        ? options.readPresentation?.preparingMessage ?? `Execute ${context.descriptor.flatName}.`
        : `${options.readPresentation?.preparingMessage ?? `Execute ${context.descriptor.flatName}.`}\n${preview.label}:\n${previewValue}`;
      return {
        input,
        toolRevision: context.toolRevision,
        handlerRevision: context.handlerRevision,
        intentRevision: context.intentRevision,
        targetIdentity: { toolName: context.descriptor.flatName, input },
        generation: context.generation,
        action: { summary: actionSummary.slice(0, 4_096) },
        permission: {
          toolName: context.descriptor.flatName,
          dangerLevel: context.descriptor.dangerLevel,
          readonly,
          access,
          recoveryClass,
          actions: declared.actions ?? [readonly ? 'read' : 'write'],
          paths: declared.paths ?? [],
          hosts: declared.hosts ?? [],
          network: declared.network ?? false,
          externalWrite: declared.externalWrite ?? false,
          destructive: declared.destructive ?? false,
          credentials: declared.credentials ?? false,
          admin: declared.admin ?? false,
          unknownRisk: false,
          resolvedAddresses: [],
          targets: [],
        },
        access,
        recoveryClass,
        concurrency: readonly ? 'read' as const : 'write' as const,
        resourceKeys: [
          `fixture:${context.descriptor.flatName}:${JSON.stringify(input)}`,
        ],
        limits: context.limits,
      };
    },
    execute: executeRead,
    ...(options.retainedResult === undefined
      ? {}
      : {
          retainResult: () => {
            const bytes = new TextEncoder().encode(options.retainedResult);
            return {
              mediaType: 'text/plain; charset=utf-8',
              expectedByteSize: bytes.byteLength,
              source: (async function* () { await Promise.resolve(); yield bytes; })(),
            };
          },
        }),
  });
  registry.registerInvocation({
    name: 'read_result', description: 'write fixture', dangerLevel: 'medium', readonly: false,
    source: 'unknown', access: 'write', recoveryClass: 'non_idempotent',
    toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1',
    permission: { actions: ['write'], externalWrite: true }, exposure: 'direct',
    limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
    outputSchema: { type: 'object' }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    inputSchema: {
      type: 'object', properties: { resultRef: { type: 'string' } }, required: ['resultRef'],
    },
    execution: { concurrency: 'write', timeoutMs: 10_000 },
  }, {
    revision: { toolName: 'read_result', toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1' },
    prepare: (input, context) => ({
      input,
      toolRevision: context.toolRevision,
      handlerRevision: context.handlerRevision,
      intentRevision: context.intentRevision,
      targetIdentity: { toolName: context.descriptor.flatName, input },
      generation: context.generation,
      action: { summary: `Execute ${context.descriptor.flatName}.` },
      permission: {
        toolName: context.descriptor.flatName, dangerLevel: context.descriptor.dangerLevel,
        readonly: false, access: 'write', recoveryClass: 'non_idempotent', actions: ['write'],
        paths: [], hosts: [], network: false, externalWrite: true, destructive: false,
        credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [],
      },
      access: 'write', recoveryClass: 'non_idempotent', concurrency: 'write' as const,
      resourceKeys: [`fixture:${context.descriptor.flatName}`], limits: context.limits,
    }),
    execute: () => {
      writeCallCount += 1;
      return { written: true };
    },
  });
  const snapshot = registry.captureSnapshot();
  const artifactStore = options.artifactStore
    ? new ProjectArtifactStore({
        projectId: 'project-a', rootDir: join(directory, 'artifacts'), journal,
        ...(options.artifactAfterCommitBytesVerified === undefined
          ? {}
          : { afterCommitBytesVerified: options.artifactAfterCommitBytesVerified }),
        ...(options.artifactCrashAt === undefined ? {} : { crashAt: options.artifactCrashAt }),
      })
    : undefined;
  const { ToolInvocationRuntime } = await runtimeModule();
  const runtimeOptions = () => ({
    journal,
    registry: snapshot,
    permissionManager: options.permissionManager ??
      new PermissionManager({ revision: 'permission-policy:test' }),
    artifactStore,
    allowedTools: (options.allowedToolNames ?? snapshot.llmTools().map(({ name }) => name)).map(
      (name) => ({
        name,
        revision: options.allowedToolRevisionOverrides?.[name] ?? snapshot.invocationRevision(name)!,
      }),
    ),
    binding: {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
      lease, mode: options.mode,
    },
    revalidateTarget: () => undefined,
    maxConcurrency: options.maxConcurrency ?? 2,
    ...(options.invocationHooks === undefined ? {} : { invocationHooks: options.invocationHooks }),
  });
  const runtime = new ToolInvocationRuntime(runtimeOptions());
  const readInvocationId = committed.invocations[0]?.invocationId ?? '';
  const writeInvocationId = committed.invocations[1]?.invocationId ?? '';
  return {
    directory, journalPath, journal, runId: created.runId, lease, runtime, runtimeOptions, snapshot,
    registry,
    artifactStore, readInvocationId, writeInvocationId,
    invocationIds: committed.invocations.map(({ invocationId }) => invocationId),
    readCalls: () => readCallCount, writeCalls: () => writeCallCount,
    sawReadAbort: () => readAborted,
    waitUntilReadStarted: async () => {
      if (readStarted) return;
      await readStartedPromise;
    },
    waitUntilReadPreparationStarted: async () => {
      if (readPreparationStarted) return;
      await readPreparationStartedPromise;
    },
    approvalDecision: (approval: Awaited<ReturnType<typeof journal.getApproval>>, decision: 'approve' | 'deny') => {
      if (approval === null) throw new Error('Expected pending approval');
      return {
        commandId: `approval-${approval.approvalId}-${decision}`, approvalId: approval.approvalId,
        projectId: approval.projectId, sessionId: approval.sessionId, runId: approval.runId,
        turnId: approval.turnId, invocationId: approval.invocationId,
        canonicalToolId: approval.canonicalToolId, toolRevision: approval.toolRevision,
        recoveryClass: approval.recoveryClass, intentDigest: approval.intentDigest,
        proposedRevision: approval.proposedRevision, decision,
      } as const;
    },
  };
}

async function createPreparedToolArtifactFixture(
  overrides: Partial<Pick<
    PrepareToolArtifactInput,
    'startedAttempt' | 'idempotencyKey' | 'fencingToken'
  >> = {},
) {
  const fixture = await createFixture({ mode: 'full-access', artifactStore: true });
  const artifactStore = fixture.artifactStore;
  if (artifactStore === undefined) throw new Error('Expected an Artifact Store.');
  await fixture.runtime.resolve();
  const authorized = await fixture.journal.getInvocation(fixture.readInvocationId);
  const kernel = await fixture.journal.getKernelRunProjection({
    projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
  });
  if (authorized === null || kernel === null) throw new Error('Expected an authorized Invocation.');
  const lifecycle = openToolLifecycleCommitter(fixture.journal);
  const lease = {
    ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken,
  };
  const idempotencyKey = 'prepared-binding-effect';
  const started = await lifecycle.commit({
    action: 'start', projectId: 'project-a', sessionId: 'session-a',
    runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId,
    commandId: 'prepared-binding-start', lease,
    expectedRunRevision: kernel.revision, expectedInvocationRevision: authorized.revision,
    intentDigest: authorized.intentDigest ?? '',
    idempotencyKey, attempt: 1, permissionAudit: executionPermissionAudit(),
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ rows: [{ id: 1 }] }));
  const staged = await artifactStore.stage({
    mediaType: 'application/vnd.schemanaut.tool-result+json',
    source: (async function* () { yield await Promise.resolve(bytes); })(),
    expectedByteSize: bytes.byteLength,
  });
  const artifactLifecycle = openToolArtifactCommitter(artifactStore);
  const prepared = await artifactLifecycle.prepare({
    staged, sessionId: 'session-a', runId: fixture.runId, turnId: 'turn-a',
    invocationId: fixture.readInvocationId,
    startedAttempt: overrides.startedAttempt ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? idempotencyKey,
    fencingToken: overrides.fencingToken ?? fixture.lease.fencingToken,
    summary: 'Prepared binding test Artifact.',
  });
  const runAfterStart = await fixture.journal.getKernelRunProjection({
    projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
  });
  if (runAfterStart === null) throw new Error('Expected the started Tool Run.');
  return {
    fixture, artifactStore, artifactLifecycle, lifecycle, prepared, staged,
    finish: {
      action: 'finish' as const, projectId: 'project-a', sessionId: 'session-a',
      runId: fixture.runId, turnId: 'turn-a', invocationId: fixture.readInvocationId,
      commandId: 'prepared-binding-finish', lease,
      expectedRunRevision: runAfterStart.revision,
      expectedInvocationRevision: started.invocation.revision,
      intentDigest: authorized.intentDigest ?? '',
      outcome: 'succeeded' as const, summary: 'Completed.', resultRefs: [staged.handle],
      modelProjection: { rows: [{ id: 1 }] }, durableSummary: { rowCount: 1 },
    },
  };
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

async function readRetainedArtifact(
  store: ProjectArtifactStore | undefined,
  contentRef: string | undefined,
  runId: string,
): Promise<string> {
  if (store === undefined || contentRef === undefined) throw new Error('Retained result content is missing.');
  const page = await store.readContent({
    contentRef,
    access: { hostId: 'local', projectId: 'project-a', sessionId: 'session-a', runId },
    mode: 'text', limit: 1_000_000,
  });
  if (typeof page.data !== 'string' || !page.eof) throw new Error('Expected a complete text result page.');
  return page.data;
}

function contentReference(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contentRef = (value as Record<string, unknown>).contentRef;
  return typeof contentRef === 'string' ? contentRef : undefined;
}
