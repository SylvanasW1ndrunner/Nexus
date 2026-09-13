import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  type CanonicalModelRequest,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { RunController, type KernelRunProjection } from '../src/kernel/run-controller.js';
import { PermissionManager } from '../src/permission-manager.js';
import { type ToolCatalogSnapshot, type ToolInvocationHandlerRuntime, type ToolRegistry } from '../src/tool-registry.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';

const PROJECT_ID = 'resume-matrix-project';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent Kernel persisted resume matrix', () => {
  it('does not let generic resume bypass an approval decision after restart', async () => {
    const journal = createJournal();
    const catalog = approvalCatalog();
    const session = await authenticModelSession({
      modelId: 'approval-model',
      firstToolName: 'write_project_file',
    });
    const first = kernel({ journal, session, catalog: catalog.captureSnapshot(), mode: 'default' });
    const started = await first.start(startInput('approval'));
    const waiting = await first.advance(started.runId);
    expect(waiting).toMatchObject({ state: 'AwaitingUser', waitReason: 'approval' });
    const pendingBefore = await first.pending(started.runId);
    expect(pendingBefore).toEqual([expect.objectContaining({ kind: 'approval' })]);

    const restarted = kernel({
      journal,
      session,
      catalog: catalog.captureSnapshot(),
      mode: 'default',
      ownerId: 'approval-restarted-owner',
    });
    const resumeError = await restarted.resume({
      runId: started.runId,
      reason: 'generic continue must not approve the write',
    }).then(() => undefined, (error: unknown) => error);
    const after = await restarted.open(started.runId);

    expect.soft(resumeError).toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect.soft(after).toEqual(waiting);
    expect(await restarted.pending(started.runId)).toEqual(pendingBefore);
  });

  it('does not let generic resume bypass an outcome-resolution decision after restart', async () => {
    const journal = createJournal();
    const catalog = unknownOutcomeCatalog();
    const session = await authenticModelSession({
      modelId: 'outcome-model',
      firstToolName: 'publish_external_change',
    });
    const first = kernel({ journal, session, catalog: catalog.captureSnapshot(), mode: 'full-access' });
    const started = await first.start(startInput('outcome'));
    const waiting = await first.advance(started.runId);
    expect(waiting).toMatchObject({
      state: 'AwaitingUser',
      waitReason: 'outcome_resolution',
    });
    const [unknown] = await journal.listInvocations(started.runId);
    if (unknown === undefined) throw new Error('Expected an outcome-unknown Invocation.');
    expect(unknown).toMatchObject({
      state: 'observed',
      terminal: { kind: 'unknown' },
    });
    const pendingBefore = await first.pending(started.runId);
    expect(pendingBefore).toEqual([expect.objectContaining({
      kind: 'outcome-resolution',
      invocationId: unknown.invocationId,
    })]);

    const restarted = kernel({
      journal,
      session,
      catalog: catalog.captureSnapshot(),
      mode: 'full-access',
      ownerId: 'outcome-restarted-owner',
    });
    const resumeError = await restarted.resume({
      runId: started.runId,
      reason: 'generic continue must not resolve an unknown side effect',
    }).then(() => undefined, (error: unknown) => error);
    const after = await restarted.open(started.runId);
    const [invocationAfter] = await journal.listInvocations(started.runId);

    expect.soft(resumeError).toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect.soft(after).toEqual(waiting);
    expect(invocationAfter).toEqual(unknown);
    expect(await restarted.pending(started.runId)).toEqual(pendingBefore);
  }, 45_000);

  it('discards a lost in-flight model attempt and resumes the exact Turn with a replacement attempt', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'limited-model' });
    const original = kernel({ journal, session });
    const started = await original.start(startInput('limit'));
    const receiving = await captureReceivingModel({
      journal,
      run: started,
      session,
      ownerId: 'limit-preparer',
    });
    const limited = await original.advance(started.runId, {
      limits: { deadlineAt: '1970-01-01T00:00:00.000Z' },
    });
    expect(limited).toMatchObject({
      state: 'LimitReached',
      currentTurnId: receiving.currentTurnId,
      turnSnapshotId: receiving.turnSnapshotId,
      currentAttemptId: receiving.currentAttemptId,
    });

    const restarted = kernel({ journal, session, ownerId: 'limit-restarted-owner' });
    const resumed = await restarted.resume({ runId: started.runId, reason: 'continue' });

    expect(resumed).toMatchObject({
      state: 'CallingModel',
      currentTurnId: receiving.currentTurnId,
      turnSnapshotId: receiving.turnSnapshotId,
      currentAttemptId: null,
    });
    const events = await journal.readRunEvents({
      projectId: resumed.projectId, sessionId: resumed.sessionId, runId: resumed.runId,
      afterSequence: 0, limit: 500,
    });
    const discarded = events.events.filter(({ type }) => type === 'model_attempt_discarded');
    expect(discarded).toHaveLength(1);
    const discardedAttempt = discarded[0];
    if (discardedAttempt?.type !== 'model_attempt_discarded') {
      throw new Error('Expected one discarded Model attempt.');
    }
    expect(discardedAttempt.attemptId).toBe(receiving.currentAttemptId);
    expect(discardedAttempt.payload.reason).toBe('explicit-resume-after-interruption');
  });

  it('restores an interrupted ResolvingActions window and preserves Invocation identity', async () => {
    const journal = createJournal();
    const catalog = inspectCatalog();
    const session = await authenticModelSession({
      modelId: 'interrupted-model',
      firstToolName: 'inspect_project',
    });
    const original = kernel({ journal, session, catalog: catalog.captureSnapshot() });
    const started = await original.start(startInput('interrupt'));
    const resolving = await captureResolvingActions({
      journal,
      run: started,
      session,
      catalog: catalog.captureSnapshot(),
      ownerId: 'interrupt-preparer',
    });
    const [invocationBefore] = await journal.listInvocations(started.runId);
    if (invocationBefore === undefined) throw new Error('Expected a persisted Invocation.');
    expect(invocationBefore).toMatchObject({
      turnId: resolving.currentTurnId,
      attemptId: 'attempt-interrupted',
      state: 'proposed',
    });

    const controller = controllerFor({
      journal,
      run: resolving,
      ownerId: 'interrupt-committer',
    });
    await controller.acquire();
    const interrupted = await controller.interrupt({
      commandId: 'interrupt-resolving-actions',
      expectedRunRevision: resolving.revision,
      code: 'PROCESS_RESTARTED',
    });
    await controller.release();
    expect(interrupted.run).toMatchObject({
      state: 'Interrupted',
      currentTurnId: resolving.currentTurnId,
      turnSnapshotId: resolving.turnSnapshotId,
    });

    const restarted = kernel({
      journal,
      session,
      catalog: catalog.captureSnapshot(),
      ownerId: 'interrupt-restarted-owner',
    });
    const resumed = await restarted.resume({ runId: started.runId, reason: 'continue' });
    const [invocationAfter] = await journal.listInvocations(started.runId);

    expect(resumed).toMatchObject({
      state: 'ResolvingActions',
      currentTurnId: resolving.currentTurnId,
      turnSnapshotId: resolving.turnSnapshotId,
      currentAttemptId: null,
    });
    expect(invocationAfter).toEqual(invocationBefore);
  });
});

type KernelFixtureOptions = Readonly<{
  journal: SqliteAgentJournal;
  session: ModelSession;
  catalog?: ToolCatalogSnapshot;
  mode?: 'default' | 'auto' | 'full-access';
  ownerId?: string;
}>;

function kernel(options: KernelFixtureOptions) {
  return createJournalAgentKernel({
    journal: options.journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => options.session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: options.catalog ?? fixedBaselineRegistry().captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol',
      source: 'runtime',
      scope: 'static',
      priority: 0,
      revision: 'runtime-r1',
      cacheability: 'stable',
      tokenEstimate: 8,
      content: [{ type: 'text', text: 'Use the captured capabilities.' }],
    },
    capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    revalidateToolTarget: () => undefined,
    ownerId: options.ownerId ?? 'resume-matrix-owner',
    mode: options.mode ?? 'default',
  });
}

function startInput(suffix: string) {
  return {
    projectId: PROJECT_ID,
    sessionId: `session-${suffix}`,
    clientRequestId: `request-${suffix}`,
    input: `perform ${suffix}`,
  };
}

async function captureReceivingModel(input: Readonly<{
  journal: SqliteAgentJournal;
  run: KernelRunProjection;
  session: ModelSession;
  ownerId: string;
}>): Promise<KernelRunProjection> {
  const captured = await captureTurn({
    ...input,
    catalog: fixedBaselineRegistry().captureSnapshot(),
  });
  const controller = controllerFor({ journal: input.journal, run: captured, ownerId: input.ownerId });
  await controller.acquire();
  const turn = await requiredTurn(input.journal, captured);
  const ready = await controller.commitContextReady({
    commandId: 'limit-context-ready',
    expectedRunRevision: captured.revision,
    turnId: turn.turnId,
    expectedTurnRevision: turn.revision,
  });
  const started = await controller.startModelAttempt({
    commandId: 'limit-attempt-started',
    expectedRunRevision: ready.run.revision,
    turnId: turn.turnId,
    expectedTurnRevision: turn.revision,
    attemptId: 'attempt-limited',
    origin: {
      connectionId: input.session.route.connectionId,
      model: input.session.route.modelId,
      protocol: input.session.route.protocol,
    },
  });
  await controller.release();
  return started.run;
}

async function captureResolvingActions(input: Readonly<{
  journal: SqliteAgentJournal;
  run: KernelRunProjection;
  session: ModelSession;
  catalog: ToolCatalogSnapshot;
  ownerId: string;
}>): Promise<KernelRunProjection> {
  const captured = await captureTurn(input);
  const controller = controllerFor({ journal: input.journal, run: captured, ownerId: input.ownerId });
  const lease = await controller.acquire();
  const turn = await requiredTurn(input.journal, captured);
  const ready = await controller.commitContextReady({
    commandId: 'interrupt-context-ready',
    expectedRunRevision: captured.revision,
    turnId: turn.turnId,
    expectedTurnRevision: turn.revision,
  });
  const attempt = (await new ModelExecutionGateway({
    createAttemptId: () => 'attempt-interrupted',
  }).executeAttempt(input.session, modelToolRequest(input.session, 'inspect_project'), {
    purpose: 'agent-turn',
    toolsEnabled: true,
  })).attempt;
  const receiving = await controller.startModelAttempt({
    commandId: 'interrupt-attempt-started',
    expectedRunRevision: ready.run.revision,
    turnId: turn.turnId,
    expectedTurnRevision: turn.revision,
    attemptId: attempt.attemptId,
    origin: attempt.origin,
  });
  await new RunEventCommitter(input.journal).commitValidatedAttempt({
    projectId: input.run.projectId,
    sessionId: input.run.sessionId,
    runId: input.run.runId,
    turnId: turn.turnId,
    commandId: 'interrupt-attempt-committed',
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    expectedRunRevision: receiving.run.revision,
    expectedTurnRevision: turn.revision,
    billingMode: 'byok',
    attempt,
  });
  const resolving = await input.journal.getKernelRunProjection({
    projectId: input.run.projectId,
    sessionId: input.run.sessionId,
    runId: input.run.runId,
  });
  await controller.release();
  if (resolving === null) throw new Error('Expected a ResolvingActions projection.');
  expect(resolving.state).toBe('ResolvingActions');
  return resolving;
}

async function captureTurn(input: Readonly<{
  journal: SqliteAgentJournal;
  run: KernelRunProjection;
  session: ModelSession;
  catalog: ToolCatalogSnapshot;
  ownerId: string;
}>): Promise<KernelRunProjection> {
  const controller = controllerFor(input);
  await controller.acquire();
  const tools = input.catalog.llmTools().map((tool) => ({
    name: tool.name,
    revision: requiredToolRevision(input.catalog, tool.name),
  }));
  const environment = await requiredEnvironment(input.journal, input.run);
  const captured = await controller.captureTurn({
    commandId: `capture-${input.run.runId}`,
    expectedRunRevision: input.run.revision,
    turnId: `turn-${input.run.runId}`,
    environment: environment.payload,
    snapshot: {
      turnSnapshotId: `snapshot-${input.run.runId}`,
      capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
      promptRevision: 'prompt-r1',
      tools,
      skills: [],
      verifiers: [],
    },
  });
  await controller.release();
  return captured.run;
}

async function requiredEnvironment(journal: SqliteAgentJournal, run: KernelRunProjection) {
  const environment = await journal.getEnvironmentBinding({
    projectId: run.projectId,
    sessionId: run.sessionId,
    runId: run.runId,
  });
  if (environment === null) throw new Error('Expected a persisted Run Environment Binding.');
  return environment;
}

function controllerFor(input: Readonly<{
  journal: SqliteAgentJournal;
  run: KernelRunProjection;
  ownerId: string;
}>) {
  return new RunController({
    journal: input.journal,
    projectId: input.run.projectId,
    sessionId: input.run.sessionId,
    runId: input.run.runId,
    ownerId: input.ownerId,
    leaseTtlMs: 60_000,
  });
}

async function requiredTurn(journal: SqliteAgentJournal, run: KernelRunProjection) {
  if (run.currentTurnId === null) throw new Error('Expected an active Turn.');
  const turn = await journal.getTurnLifecycle({
    projectId: run.projectId,
    sessionId: run.sessionId,
    runId: run.runId,
    turnId: run.currentTurnId,
  });
  if (turn === null) throw new Error('Expected a Turn lifecycle.');
  return { turnId: run.currentTurnId, ...turn };
}

function modelToolRequest(session: ModelSession, name: string): CanonicalModelRequest {
  return {
    model: session.route.modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'use the tool' }] }],
    tools: [{ name, inputSchema: { type: 'object', additionalProperties: false } }],
  };
}

function approvalCatalog(): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const write = invocationContribution('write_project_file', { ok: true }, { handlerRevision: 'write-r1', exposure: 'direct', access: 'write', recoveryClass: 'idempotent' });
  registry.registerInvocation({ ...write.definition, description: 'write a project file', permission: { actions: ['write'], externalWrite: true } }, { ...write.runtime, prepare: prepareFixtureIntent });
  return registry;
}

function unknownOutcomeCatalog(): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const publish = invocationContribution('publish_external_change', {}, { handlerRevision: 'publish-r1', exposure: 'direct', access: 'external', recoveryClass: 'non_idempotent' });
  registry.registerInvocation({
    ...publish.definition,
    description: 'publish an external change',
    dangerLevel: 'high',
    readonly: false,
    permission: { actions: ['execute'] },
    limits: { ...publish.definition.limits, timeoutMs: 60_000 },
    execution: { ...publish.definition.execution, timeoutMs: 60_000 },
  }, {
    ...publish.runtime, prepare: prepareFixtureIntent,
    execute: () => { throw new Error('external acknowledgement was lost'); },
  });
  return registry;
}

function inspectCatalog(): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const inspect = invocationContribution('inspect_project', { ok: true }, { handlerRevision: 'inspect-r1', exposure: 'direct' });
  registry.registerInvocation({ ...inspect.definition, description: 'inspect project state', permission: { actions: ['read'] } }, { ...inspect.runtime, prepare: prepareFixtureIntent });
  return registry;
}

const prepareFixtureIntent: ToolInvocationHandlerRuntime['prepare'] = (input, context) => ({
  input, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision,
  intentRevision: context.intentRevision, targetIdentity: { toolName: context.descriptor.flatName },
  generation: context.generation, action: { summary: `Execute ${context.descriptor.flatName}.` },
  permission: {
    toolName: context.descriptor.flatName, dangerLevel: context.descriptor.dangerLevel,
    readonly: context.descriptor.readonly, access: context.descriptor.access,
    recoveryClass: context.descriptor.recoveryClass, actions: context.descriptor.permission?.actions ?? [],
    paths: context.descriptor.permission?.paths ?? [], hosts: context.descriptor.permission?.hosts ?? [],
    network: context.descriptor.permission?.network ?? false, externalWrite: context.descriptor.permission?.externalWrite ?? false,
    destructive: context.descriptor.permission?.destructive ?? false, credentials: context.descriptor.permission?.credentials ?? false,
    admin: context.descriptor.permission?.admin ?? false, unknownRisk: false, resolvedAddresses: [], targets: [],
  },
  access: context.descriptor.access, recoveryClass: context.descriptor.recoveryClass,
  concurrency: context.descriptor.execution.concurrency,
  resourceKeys: [`fixture:${context.descriptor.flatName}`], limits: context.limits,
});

function requiredToolRevision(snapshot: ToolCatalogSnapshot, name: string): string {
  const revision = snapshot.invocationRevision(name) ?? snapshot.get(name)?.descriptor.toolRevision;
  if (revision === undefined) throw new Error(`Missing Tool revision: ${name}`);
  return revision;
}

type SessionOptions = Readonly<{ modelId: string; firstToolName?: string }>;

async function authenticModelSession(options: SessionOptions): Promise<ModelSession> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'resume-matrix-model-'));
  roots.push(cacheDirectory);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: modelClient(options),
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory,
    plugins: [providerPlugin(options.modelId)],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: `connection-${options.modelId}`,
    endpoint: 'http://127.0.0.1:8999',
    apiKey: 'test-only',
    connectionConfigurationRevision: `config-${options.modelId}`,
    credentialRevision: `credential-${options.modelId}`,
  }]);
  const [connection] = manager.connections();
  if (connection === undefined) throw new Error('Missing test connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSession({ connectionId: connection.id, modelId: options.modelId }, {
    generation: { temperature: 0, maxOutputTokens: 4_096 },
  });
}

function modelClient(options: SessionOptions): ModelClient {
  let calls = 0;
  return {
    execute: () => {
      calls += 1;
      return Promise.resolve({
        kind: 'json',
        response: options.firstToolName !== undefined && calls === 1
          ? {
              id: `response-tool-${options.modelId}`,
              model: options.modelId,
              status: 'completed',
              output: [{
                id: 'tool-call-1',
                type: 'function_call',
                call_id: 'wire-call-1',
                name: options.firstToolName,
                arguments: '{}',
              }],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            }
          : {
              id: `response-text-${options.modelId}`,
              model: options.modelId,
              status: 'completed',
              output: [{
                id: 'message-1',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'completed' }],
              }],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
      });
    },
  };
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'resume-matrix-provider',
    name: 'resume-matrix-provider',
    mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'completed', toolCalls: [] }),
    listModels: () => Promise.resolve([modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported', maxOutputTokens: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: `resume-${modelId}`,
      name: 'resume-matrix-provider',
      version: '1.0.0',
      protocol: 'openai-responses',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function createJournal(): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), 'agent-resume-matrix-'));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}
