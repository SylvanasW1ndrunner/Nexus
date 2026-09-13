import { permissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  createModelSessionBundle,
  describeModelSessionBundle,
  type CanonicalModelRequest,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelClientRequest,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import * as coreAgentPackage from '../src/index.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import * as agentKernelModule from '../src/kernel/agent-kernel.js';
import { RunController } from '../src/kernel/run-controller.js';
import { SessionModelBindingStore } from '../src/kernel/session-model-binding.js';
import { PermissionManager } from '../src/permission-manager.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent Kernel architecture', () => {
  it('exposes only concrete Journal-backed production construction', () => {
    expect(coreAgentPackage).toHaveProperty('createJournalAgentKernel');
    expect(coreAgentPackage).not.toHaveProperty('JournalDrivenAgentKernel');
    expect(coreAgentPackage).not.toHaveProperty('AgentKernelPort');
  });

  it('executes the production capture-to-delivery spine without an injectable effect port', async () => {
    const journal = createJournal();
    const session = await authenticModelSession();
    const kernel = agentKernelModule.createJournalAgentKernel({
      journal,
      gateway: new ModelExecutionGateway(),
      resolveModelSession: () => session,
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: fixedBaselineRegistry().captureSnapshot(),
      permissionManager: new PermissionManager(),
      runtimeProtocol: {
        id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
        revision: 'runtime-r1', cacheability: 'stable',
        content: [{ type: 'text', text: 'Use tools when useful and deliver the requested result.' }],
        tokenEstimate: 16,
      },
      capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
      promptRevision: 'prompt-r1',
      settingsRevision: 'settings-r1',
      permissionPolicyRevision: 'permission-r1',
      ownerId: 'owner-production-test',
    });
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'session-production',
      clientRequestId: 'request-production', input: 'Answer briefly.',
    });

    const completed = await kernel.advance(started.runId);

    expect(completed).toMatchObject({
      state: 'Completed', deliveryStatus: 'not-required',
      currentAttemptId: null,
    });
    expect(await journal.countEvents('model_attempt_started')).toBe(1);
    expect(await journal.countEvents('model_attempt_committed')).toBe(1);
    expect(await journal.countEvents('run.completed')).toBe(1);
  });

  it('atomically freezes the Run Environment before start returns', async () => {
    const journal = createJournal();
    let modelACalls = 0;
    let modelBCalls = 0;
    const sessionA = await authenticModelSession('text', {
      modelId: 'model-start-a', onExecute: () => { modelACalls += 1; },
    });
    const sessionB = await authenticModelSession('text', {
      modelId: 'model-start-b', onExecute: () => { modelBCalls += 1; },
    });
    const bindings = new SessionModelBindingStore(journal);
    const bindingA = await bindings.bind({
      projectId: 'project-1', sessionId: 'session-start-freeze',
      commandId: 'bind-start-a', expectedRevision: 0, session: sessionA,
    });
    const first = agentKernelModule.createJournalAgentKernel({
      journal, gateway: new ModelExecutionGateway(),
      resolveModelSession: ({ binding }) => {
        const modelId = binding?.model.descriptor.primary.route.modelId;
        if (modelId === 'model-start-a') return sessionA;
        if (modelId === 'model-start-b') return sessionB;
        throw new Error(`Unexpected model ${String(modelId)}`);
      },
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: fixedBaselineRegistry().captureSnapshot(),
      permissionManager: new PermissionManager(), runtimeProtocol: runtimeProtocol(),
      capability: { snapshotId: 'capability-start', revision: 'capability-start@1' },
      promptRevision: 'prompt-start@1', settingsRevision: 'settings-start@1',
      permissionPolicyRevision: 'permission-policy:edit:v1', ownerId: 'owner-start-first',
    });

    const started = await first.start({
      projectId: 'project-1', sessionId: 'session-start-freeze',
      clientRequestId: 'request-start-freeze', input: 'Use the frozen model.',
    });
    const frozen = await journal.getEnvironmentBinding({
      projectId: 'project-1', sessionId: 'session-start-freeze', runId: started.runId,
    });
    expect(started.environmentBindingId).not.toBeNull();
    expect(frozen?.payload).toMatchObject({
      settingsRevision: 'settings-start@1',
      permissionPolicyRevision: 'permission-policy:edit:v1',
      modelSession: { primary: { route: { modelId: 'model-start-a' } } },
    });

    await bindings.bind({
      projectId: 'project-1', sessionId: 'session-start-freeze',
      commandId: 'bind-start-b', expectedRevision: bindingA.revision, session: sessionB,
    });
    const restarted = agentKernelModule.createJournalAgentKernel({
      journal, gateway: new ModelExecutionGateway(),
      resolveModelSession: ({ binding }) => {
        const modelId = binding?.model.descriptor.primary.route.modelId;
        if (modelId === 'model-start-a') return sessionA;
        if (modelId === 'model-start-b') return sessionB;
        throw new Error(`Unexpected model ${String(modelId)}`);
      },
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: fixedBaselineRegistry().captureSnapshot(),
      permissionManager: new PermissionManager(), runtimeProtocol: runtimeProtocol(),
      capability: { snapshotId: 'capability-start', revision: 'capability-start@1' },
      promptRevision: 'prompt-start@2', settingsRevision: 'settings-start@2',
      permissionPolicyRevision: 'permission-policy:read:v2', ownerId: 'owner-start-restarted',
    });
    await expect(restarted.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(modelACalls).toBe(1);
    expect(modelBCalls).toBe(0);
  });

  it('returns the single durable winner for concurrent idempotent starts', async () => {
    const journal = createJournal();
    const session = await authenticModelSession('text', { modelId: 'model-concurrent-start' });
    let releaseResolvers!: () => void;
    const resolverGate = new Promise<void>((resolve) => { releaseResolvers = resolve; });
    let resolverCount = 0;
    const kernel = (ownerId: string) => agentKernelModule.createJournalAgentKernel({
      journal,
      gateway: new ModelExecutionGateway(),
      resolveModelSession: async () => {
        resolverCount += 1;
        if (resolverCount === 2) releaseResolvers();
        await resolverGate;
        return session;
      },
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: fixedBaselineRegistry().captureSnapshot(),
      permissionManager: new PermissionManager(), runtimeProtocol: runtimeProtocol(),
      capability: { snapshotId: 'capability-concurrent', revision: 'capability-concurrent@1' },
      promptRevision: 'prompt-concurrent@1', settingsRevision: 'settings-concurrent@1',
      permissionPolicyRevision: 'permission-policy:edit:v1', ownerId,
    });
    const first = kernel('owner-concurrent-a');
    const second = kernel('owner-concurrent-b');
    const input = {
      projectId: 'project-1', sessionId: 'session-concurrent-start',
      clientRequestId: 'request-concurrent-start', input: 'Execute exactly once.',
    };

    const [left, right] = await Promise.all([first.start(input), second.start(input)]);

    expect(left.runId).toBe(right.runId);
    expect(await journal.countEvents('run.created')).toBe(1);
    expect(await journal.countEvents('run.environment_bound')).toBe(1);
  });

  it('persists one exact model-visible Tool allowlist and applies Skill allowed-tools at Turn capture', async () => {
    const journal = createJournal();
    const requests: unknown[] = [];
    const session = await authenticModelSession('text', {
      onExecute: (request) => requests.push(request),
    });
    const registry = fixedBaselineRegistry();
    for (const [name, exposure] of [
      ['direct_tool', 'direct'],
      ['deferred_tool', 'deferred'],
      ['hidden_tool', 'hidden'],
      ['disabled_tool', 'disabled'],
    ] as const) {
      const contribution = invocationContribution(name, {}, {
        handlerRevision: `${name}@1`, exposure,
      });
      registry.registerInvocation(contribution.definition, contribution.runtime);
    }
    const catalog = registry.captureSnapshot();
    const kernel = agentKernelModule.createJournalAgentKernel({
      journal, gateway: new ModelExecutionGateway(), resolveModelSession: () => session,
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: catalog, permissionManager: new PermissionManager(),
      runtimeProtocol: runtimeProtocol(),
      capability: { snapshotId: 'capability-exposure', revision: 'capability-exposure@1' },
      promptRevision: 'prompt-r1', settingsRevision: 'settings-r1',
      permissionPolicyRevision: 'permission-r1', ownerId: 'owner-exposure',
      skills: [{ id: 'skill:project:fixture:r1', revision: 'r1', allowedTools: ['deferred_tool'] }],
    });
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'session-exposure',
      clientRequestId: 'request-exposure', input: 'finish',
    });
    await kernel.advance(started.runId);

    const toolNames = (requests[0] as {
      wireRequest?: { tools?: readonly { name: string }[] };
    } | undefined)?.wireRequest?.tools?.map(({ name }) => name) ?? [];
    expect(toolNames).toContain('direct_tool');
    expect(toolNames).not.toContain('disabled_tool');
    const turnId = (await journal.readProject('project-1', 0, 100))
      .find((event) => event.runId === started.runId && event.type === 'turn.started')?.turnId;
    expect(turnId).toBeTruthy();
    const snapshot = await journal.getTurnSnapshot({
      projectId: 'project-1', sessionId: 'session-exposure', runId: started.runId,
      turnId: turnId!,
    });
    expect(snapshot?.payload.tools.map(({ name }) => name)).toEqual(toolNames);
    expect(snapshot?.payload.discoverableTools?.map(({ name }) => name)).toContain('deferred_tool');
  });

  it('builds every Model transcript once from Journal order after a Tool observation', async () => {
    const journal = createJournal();
    const requests: ModelClientRequest[] = [];
    let modelCalls = 0;
    const session = await authenticModelSession('text', {
      execute: (request) => {
        requests.push(request);
        modelCalls += 1;
        return Promise.resolve({
          kind: 'json',
          response: modelCalls === 1
            ? {
                id: 'response-tool-once', model: 'model-a', status: 'completed',
                output: [{
                  id: 'tool-item-once', type: 'function_call', call_id: 'call-once',
                  name: 'query_database', arguments: '{"sql":"select 1"}',
                }],
                usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
              }
            : {
                id: 'response-final-once', model: 'model-a', status: 'completed',
                output: [{
                  id: 'message-final-once', type: 'message', role: 'assistant',
                  content: [{ type: 'output_text', text: 'The query returned one row.' }],
                }],
                usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
              },
        });
      },
    });
    let executions = 0;
    const tools = fixedBaselineRegistry();
    const queryContribution = invocationContribution('query_database', {}, {
      handlerRevision: 'query-database@once', exposure: 'direct',
    });
    tools.registerInvocation({
      ...queryContribution.definition,
      description: 'query one database value',
      inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } },
      permission: { actions: ['read'] },
    }, {
      ...queryContribution.runtime,
      execute: () => {
        executions += 1;
        return { rows: [{ value: 1 }] };
      },
    });
    const kernel = agentKernelModule.createJournalAgentKernel({
      journal, gateway: new ModelExecutionGateway(), resolveModelSession: () => session,
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: tools.captureSnapshot(), permissionManager: new PermissionManager(),
      runtimeProtocol: runtimeProtocol(),
      capability: { snapshotId: 'capability-transcript', revision: 'capability-transcript@1' },
      promptRevision: 'prompt-transcript@1', settingsRevision: 'settings-transcript@1',
      permissionPolicyRevision: 'permission-policy:read:v1', ownerId: 'owner-transcript',
    });
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'session-transcript',
      clientRequestId: 'request-transcript', input: 'Read the value exactly once.',
    });

    const afterToolTurn = await kernel.advance(started.runId);
    expect(afterToolTurn.state).toBe('Preparing');
    const completed = await kernel.advance(started.runId);
    expect(completed.state).toBe('Completed');

    expect(executions).toBe(0);
    expect(requests).toHaveLength(2);
    const first = responseInput(requests[0]!);
    const second = responseInput(requests[1]!);
    expect(countWireText(first, 'Read the value exactly once.')).toBe(1);
    expect(countWireText(second, 'Read the value exactly once.')).toBe(1);
    expect(second.map((item) => item.type)).toEqual([
      'message', 'message', 'function_call', 'function_call_output', 'message',
    ]);
    expect(second.at(-2)).toMatchObject({
      type: 'function_call_output', call_id: 'call-once',
    });
    expect(JSON.stringify(second.at(-1))).toContain(
      'previous committed turn produced no new committed evidence',
    );
  });

  it('rejects context lifecycle facts from the generic Journal committer', async () => {
    const journal = createJournal();
    const ingress = await journal.createRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      clientRequestId: 'request-context-authority',
      input: 'compact the committed context',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-1',
      runId: ingress.runId,
      ownerId: 'owner-1',
      ttlMs: 60_000,
    });
    await journal.startRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: ingress.runId,
      commandId: 'start-run',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });

    await expect(journal.commit({
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: ingress.runId,
      commandId: 'forged-context-start',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 2,
      events: [{
        type: 'context.compaction_started',
        payload: {
          checkpointId: 'checkpoint-forged',
          decisionId: 'decision-forged',
          reason: 'automatic',
          coveredSequence: 1,
        },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
  });

  it('persists the exact provider-neutral Model Session descriptor', async () => {
    const journal = createJournal();
    const session = await authenticModelSession();
    const store = new SessionModelBindingStore(journal);
    const binding = await store.bind({
      projectId: 'project-1',
      sessionId: 'session-1',
      commandId: 'bind-exact-model-session',
      expectedRevision: 0,
      session,
    });

    expect(binding.model.descriptor.primary.route).toEqual(session.route);
    expect(binding.model.descriptor.primary.generation).toEqual(session.generation);
    expect(binding.model.bindingDigest).toBe(createModelSessionBundle({ primary: session }).bindingDigest);
    expect(await store.get('project-1', 'session-1')).toEqual(binding);
  });

  it('rehydrates an existing Run from its immutable Environment after the Session switches model', async () => {
    const journal = createJournal();
    let modelACalls = 0;
    let modelBCalls = 0;
    const modelARequests: unknown[] = [];
    const modelBRequests: unknown[] = [];
    const sessionA = await authenticModelSession('text', {
      modelId: 'model-a', outputText: 'answer-from-a', onExecute: (request) => {
        modelACalls += 1;
        modelARequests.push(structuredClone(request));
      },
    });
    const sessionB = await authenticModelSession('text', {
      modelId: 'model-b', outputText: 'answer-from-b', onExecute: (request) => {
        modelBCalls += 1;
        modelBRequests.push(structuredClone(request));
      },
    });
    const bindingStore = new SessionModelBindingStore(journal);
    const bindingA = await bindingStore.bind({
      projectId: 'project-1', sessionId: 'session-switch', commandId: 'bind-model-a',
      expectedRevision: 0, session: sessionA,
    });
    const ingress = await journal.createRun({
      projectId: 'project-1', sessionId: 'session-switch',
      clientRequestId: 'request-model-a', input: 'Finish with the captured model.',
    });
    const controller = new RunController({
      journal, projectId: 'project-1', sessionId: 'session-switch', runId: ingress.runId,
      ownerId: 'owner-model-switch', leaseTtlMs: 60_000,
    });
    await controller.acquire();
    await controller.captureTurn({
      commandId: 'capture-model-a', expectedRunRevision: 1, turnId: 'turn-model-a',
      environment: {
        environmentBindingId: `environment_${bindingA.model.bindingDigest}`,
        settingsRevision: 'settings-r1', permissionPolicyRevision: 'permission-r1',
        modelSession: bindingA.model.descriptor,
      },
      snapshot: {
        turnSnapshotId: 'snapshot-model-a',
        capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
        promptRevision: 'prompt-r1', tools: [], skills: [], verifiers: [],
      },
    });
    await bindingStore.bind({
      projectId: 'project-1', sessionId: 'session-switch', commandId: 'bind-model-b',
      expectedRevision: bindingA.revision, session: sessionB,
    });
    const catalogA = fixedBaselineRegistry().captureSnapshot();
    const catalogB = fixedBaselineRegistry();
    const newToolContribution = invocationContribution('new_tool', { ok: true }, {
      handlerRevision: 'new_tool@1', exposure: 'direct',
    });
    catalogB.registerInvocation({
      ...newToolContribution.definition,
      namespace: 'test', title: 'New Tool', source: 'test',
      description: 'A tool added only after the old Run captured its Environment.',
    }, newToolContribution.runtime);
    const catalogBSnapshot = catalogB.captureSnapshot();
    const currentCatalogToolNames = catalogBSnapshot.llmTools().map((tool) => tool.name);

    try {
      const restarted = agentKernelModule.createJournalAgentKernel({
        journal,
        gateway: new ModelExecutionGateway(),
        resolveModelSession: ({ binding }) => {
          const modelId = binding?.model.descriptor.primary.route.modelId;
          if (modelId === 'model-a') return sessionA;
          if (modelId === 'model-b') return sessionB;
          throw new Error(`Unexpected persisted model binding: ${String(modelId)}`);
        },
        resolveUsageBillingMode: () => 'byok',
        resolveToolCatalogSnapshot: ({ tools }) => {
          expect(tools).toEqual([]);
          return { snapshot: catalogA, release: () => catalogA.release() };
        },
        toolCatalog: catalogBSnapshot,
        permissionManager: new PermissionManager(),
        runtimeProtocol: runtimeProtocol(),
        capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
        promptRevision: 'prompt-r1', settingsRevision: 'settings-r2',
        permissionPolicyRevision: 'permission-r1', ownerId: 'owner-model-switch',
      });

      const oldRun = await restarted.advance(ingress.runId);
      expect(oldRun).toMatchObject({ state: 'Completed', deliveryStatus: 'not-required' });
      expect(modelACalls).toBe(1);
      expect(modelBCalls).toBe(0);
      expect((modelARequests[0] as {
        wireRequest?: { tools?: readonly unknown[] };
      } | undefined)?.wireRequest?.tools ?? []).toEqual([]);
      expect((await journal.getEnvironmentBinding({
        projectId: 'project-1', sessionId: 'session-switch', runId: ingress.runId,
      }))?.payload.settingsRevision).toBe('settings-r1');
      const oldAttempt = (await journal.readProject('project-1', 0, 100)).find(
        (event) => event.runId === ingress.runId && event.type === 'model_attempt_committed',
      );
      expect(oldAttempt?.type === 'model_attempt_committed'
        ? oldAttempt.payload.validatedAttempt.origin.model
        : null).toBe('model-a');

      const newRun = await restarted.start({
        projectId: 'project-1', sessionId: 'session-switch',
        clientRequestId: 'request-model-b', input: 'Use the current Session model.',
      });
      const completedNewRun = await restarted.advance(newRun.runId);
      expect(completedNewRun).toMatchObject({ state: 'Completed' });
      expect(modelACalls).toBe(1);
      expect(modelBCalls).toBe(1);
      const modelBWireTools = (modelBRequests[0] as {
        wireRequest?: { tools?: readonly { name: string }[] };
      } | undefined)?.wireRequest?.tools ?? [];
      expect(modelBWireTools.map((tool) => tool.name)).toEqual(currentCatalogToolNames);
      expect((await journal.getEnvironmentBinding({
        projectId: 'project-1', sessionId: 'session-switch', runId: newRun.runId,
      }))?.payload.settingsRevision).toBe('settings-r2');
    } finally {
      catalogA.release();
      catalogBSnapshot.release();
    }
  });

  it('commits one monotonic Kernel revision per Tool command and replays it exactly', async () => {
    const journal = createJournal();
    const session = await authenticModelSession('tool');
    const bundle = createModelSessionBundle({ primary: session });
    const ingress = await journal.createRun({
      projectId: 'project-1', sessionId: 'session-1',
      clientRequestId: 'request-tool-transition', input: 'use the tool',
    });
    const controller = new RunController({
      journal, projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
      ownerId: 'owner-1', leaseTtlMs: 60_000,
    });
    await controller.acquire();
    const captured = await controller.captureTurn({
      commandId: 'capture-tool-turn', expectedRunRevision: 1, turnId: 'turn-1',
      environment: {
        environmentBindingId: 'environment-1', settingsRevision: 'settings-r1',
        permissionPolicyRevision: 'permission-r1',
        modelSession: describeModelSessionBundle(bundle),
      },
      snapshot: {
        turnSnapshotId: 'snapshot-1',
        capability: { snapshotId: 'capability-1', revision: 'cap-r1' },
        promptRevision: 'prompt-r1', tools: [{ name: 'query_database', revision: '1' }],
        skills: [], verifiers: [],
      },
    });
    const ready = await controller.commitContextReady({
      commandId: 'context-ready', expectedRunRevision: captured.run.revision,
      turnId: 'turn-1', expectedTurnRevision: 1,
    });
    const attempt = (await new ModelExecutionGateway({ createAttemptId: () => 'attempt-1' })
      .executeAttempt(session, modelRequest(), { purpose: 'agent-turn', toolsEnabled: true })).attempt;
    const started = await controller.startModelAttempt({
      commandId: 'attempt-start', expectedRunRevision: ready.run.revision,
      turnId: 'turn-1', expectedTurnRevision: 1,
      attemptId: attempt.attemptId, origin: attempt.origin,
    });
    const queuedDuringModel = await controller.queueContextCompaction({
      commandId: 'queue-context-during-model',
      expectedRunRevision: started.run.revision,
      decisionId: 'decision-during-model',
    });
    expect(queuedDuringModel.run).toMatchObject({
      state: 'ReceivingModel', revision: started.run.revision + 1,
    });
    await journal.rebuildProjectProjections('project-1');
    const recoveredLease = await journal.acquireRunLease({
      projectId: 'project-1', runId: ingress.runId,
      ownerId: 'owner-model-rebuild', ttlMs: 60_000,
    });
    await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
      turnId: 'turn-1', commandId: 'attempt-commit',
      lease: { ownerId: recoveredLease.ownerId, fencingToken: recoveredLease.fencingToken },
      expectedRunRevision: started.run.revision, expectedTurnRevision: 1, billingMode: 'byok', attempt,
    });
    const [invocation] = await journal.listInvocations(ingress.runId);
    if (invocation === undefined) throw new Error('Expected one committed Invocation.');
    const before = await journal.getKernelRunProjection({
      projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    });
    if (before === null) throw new Error('Expected Kernel projection.');
    const preparedTool = preparedToolIntent({
      toolName: 'query_database', toolRevision: '1', handlerRevision: 'query_database-handler@1',
    });
    const preparedInvocation = await openToolLifecycleCommitter(journal).commit({
      action: 'prepare', projectId: 'project-1', sessionId: 'session-1',
      runId: ingress.runId, turnId: 'turn-1', invocationId: invocation.invocationId,
      commandId: 'prepare-tool', lease: { ownerId: recoveredLease.ownerId, fencingToken: recoveredLease.fencingToken },
      expectedRunRevision: before.revision, expectedInvocationRevision: invocation.revision,
      canonicalToolId: { name: 'query_database' }, catalogRevision: 'fixture-catalog@1',
      intent: preparedTool.intent, intentDigest: preparedTool.intentDigest, deadline: '2030-01-01T00:00:00.000Z',
    });
    const preparedRun = await journal.getKernelRunProjection({
      projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    });
    if (preparedRun === null) throw new Error('Expected prepared Kernel projection.');
    await openToolLifecycleCommitter(journal).commit({
      action: 'validate', projectId: 'project-1', sessionId: 'session-1',
      runId: ingress.runId, turnId: 'turn-1', invocationId: invocation.invocationId,
      commandId: 'validate-tool',
      lease: { ownerId: recoveredLease.ownerId, fencingToken: recoveredLease.fencingToken },
      expectedRunRevision: preparedRun.revision, expectedInvocationRevision: preparedInvocation.invocation.revision,
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', recoveryClass: 'read',
      intentDigest: preparedTool.intentDigest, authorization: 'allow', permissionAudit: permissionAudit('allow'),
      actionSummary: 'Read database metadata.',
      approvalSummary: 'Read database metadata.',
    });
    const online = await journal.getKernelRunProjection({
      projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    });
    expect(online?.revision).toBe(before.revision + 2);
    await journal.rebuildProjectProjections('project-1');
    expect(await journal.getKernelRunProjection({
      projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    })).toEqual(online);
  });

  it.each(['cancel', 'limit', 'interrupt'] as const)(
    'rejects an old queued Model response after %s supersedes its window',
    async (control) => {
      const fixture = await activeModelWindow(`supersede-${control}`);
      const queued = await fixture.controller.queueContextCompaction({
        commandId: `queue-${control}`,
        expectedRunRevision: fixture.started.run.revision,
        decisionId: `decision-${control}`,
      });
      if (control === 'cancel') {
        await fixture.controller.requestCancel({
          commandId: 'cancel-after-queue', expectedRunRevision: queued.run.revision,
        });
      } else if (control === 'limit') {
        await fixture.controller.reachLimit({
          commandId: 'limit-after-queue', expectedRunRevision: queued.run.revision,
          limit: 'deadline',
        });
      } else {
        await fixture.controller.interrupt({
          commandId: 'interrupt-after-queue', expectedRunRevision: queued.run.revision,
          code: 'MODEL_TRANSPORT_FAILED',
        });
      }
      await expect(new RunEventCommitter(fixture.journal).commitValidatedAttempt({
        projectId: 'project-1', sessionId: 'session-1', runId: fixture.runId,
        turnId: fixture.turnId, commandId: `late-model-${control}`,
        lease: { ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken },
        expectedRunRevision: fixture.started.run.revision,
        expectedTurnRevision: 1,
        billingMode: 'byok',
        attempt: fixture.attempt,
      })).rejects.toSatisfy((error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        /CONFLICT$/u.test(error.code));
    },
  );
});

async function activeModelWindow(label: string) {
  const journal = createJournal();
  const session = await authenticModelSession('text');
  const ingress = await journal.createRun({
    projectId: 'project-1', sessionId: 'session-1',
    clientRequestId: `request-${label}`, input: 'wait for the model',
  });
  const controller = new RunController({
    journal, projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    ownerId: `owner-${label}`, leaseTtlMs: 60_000,
  });
  const lease = await controller.acquire();
  const turnId = `turn-${label}`;
  const captured = await controller.captureTurn({
    commandId: `capture-${label}`, expectedRunRevision: 1, turnId,
    environment: {
      environmentBindingId: `environment-${label}`,
      settingsRevision: 'settings-r1', permissionPolicyRevision: 'permission-r1',
      modelSession: describeModelSessionBundle(createModelSessionBundle({ primary: session })),
    },
    snapshot: {
      turnSnapshotId: `snapshot-${label}`,
      capability: { snapshotId: `capability-${label}`, revision: 'cap-r1' },
      promptRevision: 'prompt-r1', tools: [], skills: [], verifiers: [],
    },
  });
  const ready = await controller.commitContextReady({
    commandId: `context-ready-${label}`, expectedRunRevision: captured.run.revision,
    turnId, expectedTurnRevision: 1,
  });
  const attempt = (await new ModelExecutionGateway({ createAttemptId: () => `attempt-${label}` })
    .executeAttempt(session, modelRequest(), { purpose: 'agent-turn', toolsEnabled: true })).attempt;
  const started = await controller.startModelAttempt({
    commandId: `attempt-start-${label}`, expectedRunRevision: ready.run.revision,
    turnId, expectedTurnRevision: 1, attemptId: attempt.attemptId, origin: attempt.origin,
  });
  return { journal, controller, lease, runId: ingress.runId, turnId, attempt, started };
}

function createJournal(): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), 'agent-kernel-architecture-'));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}

type TestModelOptions = Readonly<{
  modelId?: string;
  outputText?: string;
  onExecute?: (request: unknown) => void;
  execute?: ModelClient['execute'];
}>;

async function authenticModelSession(
  mode: 'text' | 'tool' = 'text',
  options: TestModelOptions = {},
): Promise<ModelSession> {
  const modelId = options.modelId ?? 'model-a';
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'agent-kernel-model-session-'));
  roots.push(cacheDirectory);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: modelClient(mode, { ...options, modelId }),
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory, plugins: [providerPlugin(modelId)], trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: 'formal', endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1', credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing test connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSession({ connectionId: connection.id, modelId }, {
    generation: { temperature: 0.2, maxOutputTokens: 2_048 },
  });
}

function modelClient(mode: 'text' | 'tool', options: TestModelOptions = {}): ModelClient {
  const modelId = options.modelId ?? 'model-a';
  return {
    execute: (request) => {
      if (options.execute !== undefined) return options.execute(request);
      options.onExecute?.(request);
      return Promise.resolve({
        kind: 'json',
        response: mode === 'tool'
          ? {
              id: `response-tool-${modelId}`, model: modelId, status: 'completed',
              output: [{
                id: 'call-item', type: 'function_call', call_id: 'wire-call-1',
                name: 'query_database', arguments: '{"sql":"select 1"}',
              }],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }
          : {
              id: `response-text-${modelId}`, model: modelId, status: 'completed',
              output: [{
                id: 'message-1', type: 'message', role: 'assistant',
                content: [{ type: 'output_text', text: options.outputText ?? 'ok' }],
              }],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
      });
    },
  };
}

function responseInput(request: ModelClientRequest): Array<Record<string, unknown>> {
  const wire = request.wireRequest as { input?: unknown };
  if (!Array.isArray(wire.input)) throw new Error('Expected an OpenAI Responses input array.');
  return wire.input as Array<Record<string, unknown>>;
}

function countWireText(items: readonly Record<string, unknown>[], text: string): number {
  return JSON.stringify(items).split(text).length - 1;
}

function providerPlugin(modelId = 'model-a'): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'formal-provider', name: 'formal', mode: 'private', protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'provider', toolCalls: [] }),
    listModels: () => Promise.resolve([modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model, source: 'provider-api', contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported', maxOutputTokens: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'formal-test', name: 'formal', version: '1.0.0',
      protocol: 'openai-responses', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function runtimeProtocol() {
  return {
    id: 'runtime-protocol', source: 'runtime' as const, scope: 'static' as const, priority: 0,
    revision: 'runtime-r1', cacheability: 'stable' as const,
    content: [{ type: 'text' as const, text: 'Use the captured environment and finish the task.' }],
    tokenEstimate: 16,
  };
}

function modelRequest(): CanonicalModelRequest {
  return {
    model: 'model-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the database tool.' }] }],
    tools: [{
      name: 'query_database', description: 'Query database metadata.',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    }],
  };
}
