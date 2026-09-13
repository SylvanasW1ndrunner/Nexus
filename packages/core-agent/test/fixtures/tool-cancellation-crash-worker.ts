import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  type LlmConnection,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
} from '@dbagent/core-llm';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../../src/kernel/agent-kernel.js';
import { openKernelJournalCommitter } from '../../src/internal/kernel-journal-authority.js';
import { PermissionManager } from '../../src/permission-manager.js';
import type { ToolInvocationExecutionContext } from '../../src/tool-registry.js';
import type { ToolRecoveryClass } from '../../src/tools/tool-protocol.js';
import { invocationContribution } from './invocation-contribution.js';
import { fixedBaselineRegistry } from './fixed-baseline-catalog.js';

type WorkerInput = Readonly<{
  effect: ToolRecoveryClass;
  projectId: string;
  sessionId: string;
  journalPath: string;
  barrierPath: string;
  cancelBarrierPath: string;
  runPath: string;
  leaseTtlMs: number;
  modelId: string;
  toolName: string;
  modelCachePath: string;
}>;

const encoded = process.env.SCHEMANAUT_TOOL_CANCEL_CRASH_INPUT;
if (encoded === undefined) throw new Error('SCHEMANAUT_TOOL_CANCEL_CRASH_INPUT is required.');
const input = JSON.parse(encoded) as WorkerInput;

async function main(): Promise<void> {
  const journal = new SqliteAgentJournal({ filePath: input.journalPath });
  const session = await modelSession();
  const registry = fixedBaselineRegistry();
  const ownerId = `crashing-tool-owner-${input.effect}`;
  const execute = async (
    _arguments: Readonly<Record<string, unknown>>,
    context: ToolInvocationExecutionContext,
  ) => {
    if (!existsSync(input.barrierPath)) {
      mkdirSync(dirname(input.barrierPath), { recursive: true });
      writeFileSync(input.barrierPath, 'tool.started', 'utf8');
    }
    const run = await journal.getKernelRunProjection({
      projectId: context.projectId,
      sessionId: context.sessionId,
      runId: context.runId,
    });
    if (run === null) throw new Error('Started cancellation fixture Run is unavailable.');
    await openKernelJournalCommitter(journal).commit({
      action: 'request-cancel',
      projectId: context.projectId,
      sessionId: context.sessionId,
      runId: context.runId,
      commandId: `worker-cancel-${context.invocationId}`,
      lease: { ownerId, fencingToken: context.fencingToken },
      expectedRunRevision: run.revision,
      reason: `crash after cancelling started ${input.effect} Tool`,
    });
    mkdirSync(dirname(input.cancelBarrierPath), { recursive: true });
    writeFileSync(input.cancelBarrierPath, 'run.cancel_requested', 'utf8');
    // Freeze after the durable cancel request but before a Tool terminal. The
    // parent kills this process to exercise fresh-factory cancellation recovery.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Unreachable orphaned Tool continuation.');
  };
  const contribution = invocationContribution(input.toolName, {}, {
    handlerRevision: `cancellable-tool-${input.effect}@1`, exposure: 'direct',
    access: input.effect === 'read' ? 'read' : 'write', recoveryClass: input.effect,
  });
  registry.registerInvocation({
    ...contribution.definition,
    limits: { ...contribution.definition.limits, timeoutMs: 60_000 },
    description: `Cancellation acceptance Tool with ${input.effect} recovery semantics.`,
    dangerLevel: input.effect === 'read' ? 'safe' : 'medium',
    readonly: input.effect === 'read', permission: { actions: ['read'] },
    execution: { concurrency: input.effect === 'read' ? 'read' : 'write', timeoutMs: 60_000 },
  }, {
    ...contribution.runtime,
    prepare: (argumentsRecord, context) => ({
      input: argumentsRecord,
      toolRevision: context.toolRevision,
      handlerRevision: context.handlerRevision,
      intentRevision: context.intentRevision,
      targetIdentity: { toolName: context.descriptor.flatName },
      generation: context.generation,
      action: { summary: `Execute ${context.descriptor.flatName}.` },
      permission: {
        toolName: context.descriptor.flatName,
        dangerLevel: context.descriptor.dangerLevel,
        readonly: context.descriptor.readonly,
        access: context.descriptor.access,
        recoveryClass: context.descriptor.recoveryClass,
        actions: context.descriptor.permission?.actions ?? [],
        paths: [],
        hosts: [],
        network: false,
        externalWrite: false,
        destructive: false,
        credentials: false,
        admin: false,
        unknownRisk: false,
        resolvedAddresses: [],
        targets: [],
      },
      access: context.descriptor.access,
      recoveryClass: context.descriptor.recoveryClass,
      concurrency: context.descriptor.execution.concurrency,
      resourceKeys: [`fixture:${context.descriptor.flatName}`],
      limits: context.limits,
    }),
    execute,
    ...(input.effect === 'transactional' ? { recover: execute } : {}),
  });
  const kernel = createJournalAgentKernel({
    journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: registry.captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 8,
      content: [{ type: 'text', text: 'Use the exact captured Tool once.' }],
    },
    capability: { snapshotId: 'cancel-capability', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    revalidateToolTarget: () => undefined,
    mode: 'full-access',
    ownerId,
    leaseTtlMs: input.leaseTtlMs,
  });
  const run = await kernel.start({
    projectId: input.projectId,
    sessionId: input.sessionId,
    clientRequestId: `request-crash-${input.effect}`,
    input: `Start and orphan the ${input.effect} Tool.`,
  });
  mkdirSync(dirname(input.runPath), { recursive: true });
  writeFileSync(input.runPath, JSON.stringify({ runId: run.runId }), 'utf8');
  await kernel.advance(run.runId);
  await kernel.advance(run.runId);
}

async function modelSession() {
  const client: ModelClient = {
    execute: (request) => Promise.resolve({
      kind: 'json',
      response: {
        id: 'orphan-tool-response',
        model: request.route.modelId,
        status: 'completed',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        output: [{
          id: 'orphan-tool-call',
          type: 'function_call',
          call_id: 'orphan-call-1',
          name: input.toolName,
          arguments: '{}',
        }],
      },
    }),
  };
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client,
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory: input.modelCachePath,
    plugins: [providerPlugin(input.modelId)],
    trustedModelClientFactory,
  });
  const connection: LlmConnection = {
    id: 'cancel-connection',
    name: 'cancel-connection',
    endpoint: 'http://127.0.0.1:8999',
    apiKey: 'test-only',
    headers: Object.freeze({}),
    connectionConfigurationRevision: 'cancel-config-r1',
    credentialRevision: 'cancel-credential-r1',
  };
  manager.replaceConnections([connection]);
  await manager.discover(connection.id);
  return await manager.prepareModelSession({ connectionId: connection.id, modelId: input.modelId }, {
    generation: { temperature: 0 },
  });
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'cancel-provider', name: 'cancel-provider', mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'unused', toolCalls: [] }),
    listModels: () => Promise.resolve([modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model, source: 'provider-api', contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'cancel-provider-plugin', name: 'cancel-provider', version: '1.0.0',
      protocol: 'openai-responses', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

await main();
