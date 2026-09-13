import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelClientRequest,
  type ModelSession,
} from '@dbagent/core-llm';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../../src/kernel/agent-kernel.js';
import { PermissionManager } from '../../src/permission-manager.js';
import type { ToolRegistry } from '../../src/tool-registry.js';
import { invocationContribution } from './invocation-contribution.js';
import { fixedBaselineRegistry } from './fixed-baseline-catalog.js';

type CrashMode =
  | 'model-returned-before-commit'
  | 'attempt-committed-before-tool'
  | 'tool-started-before-terminal'
  | 'tool-terminal-before-observe'
  | 'context-started-before-result'
  | 'context-completed-before-next-step';

type WorkerInput = Readonly<{
  phase: 'crash' | 'recover';
  mode: CrashMode;
  journalPath: string;
  counterPath: string;
  barrierPath: string;
  runPath: string;
  resultPath: string;
  errorPath: string;
  modelCachePath: string;
  projectId: string;
  sessionId: string;
  leaseTtlMs: number;
}>;

const encoded = process.env.SCHEMANAUT_KERNEL_CRASH_INPUT;
if (encoded === undefined) throw new Error('SCHEMANAUT_KERNEL_CRASH_INPUT is required.');
const input = JSON.parse(encoded) as WorkerInput;

async function main(): Promise<void> {
  const gates = createRuntimeGates();
  const journal = new CrashBarrierJournal({ filePath: input.journalPath }, input);
  const session = await authenticModelSession(input, modelClient(input, gates));
  const tools = toolCatalog(input);
  let identity = 0;
  const kernel = createJournalAgentKernel({
    journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: tools.captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 8,
      content: [{ type: 'text', text: 'Complete the requested task using captured capabilities.' }],
    },
    capability: { snapshotId: 'crash-capability', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    mode: 'full-access',
    revalidateToolTarget: () => undefined,
    ...(isContextMode(input.mode) ? {
      verifier: {
        verifierId: 'kernel-crash-context-verifier',
        revision: 'v1',
        mode: 'required' as const,
        verify: (evidence: Readonly<{ finalContentRef: string }>) =>
          gates.isInitialFinalContentRef(evidence.finalContentRef)
            ? { status: 'revise' as const, observation: 'Continue after compacting Context.' }
            : { status: 'accepted' as const },
      },
    } : {}),
    ownerId: `kernel-${input.phase}-${input.mode}`,
    leaseTtlMs: input.leaseTtlMs,
    createId: () => `${input.phase}_${input.mode}_${++identity}`,
  });

  let runId: string;
  if (input.phase === 'crash') {
    const started = await kernel.start({
      projectId: input.projectId,
      sessionId: input.sessionId,
      clientRequestId: `request-${input.mode}`,
      input: `exercise crash cut ${input.mode}`,
    });
    runId = started.runId;
    writeJson(input.runPath, { runId, projectId: input.projectId, sessionId: input.sessionId });
  } else {
    runId = readJson<{ runId: string }>(input.runPath).runId;
  }

  let result;
  if (input.phase === 'crash' && isContextMode(input.mode)) {
    const advancing = advanceUntilPassive(kernel, runId);
    await gates.initialAgentStarted;
    const active = await kernel.open(runId);
    if (active.currentTurnId === null) {
      throw new Error('Initial Context fixture Model call has no active Turn.');
    }
    gates.setInitialFinalContentRef(`turn:${active.currentTurnId}:content`);
    await kernel.requestManualCompaction({ runId });
    gates.releaseInitialAgent();
    result = await advancing;
  } else {
    result = await advanceUntilPassive(kernel, runId);
  }
  const pending = await kernel.pending(runId);
  const usage = await journal.getRunUsage({
    projectId: input.projectId, sessionId: input.sessionId, runId,
  });
  writeJson(input.resultPath, { result, pending, usage });
}

class CrashBarrierJournal extends SqliteAgentJournal {
  constructor(
    options: ConstructorParameters<typeof SqliteAgentJournal>[0],
    private readonly worker: WorkerInput,
  ) {
    super(options);
  }

  override async commitValidatedAttempt(
    command: Parameters<SqliteAgentJournal['commitValidatedAttempt']>[0],
  ): Promise<Awaited<ReturnType<SqliteAgentJournal['commitValidatedAttempt']>>> {
    if (this.crashesAt('model-returned-before-commit')) {
      await crashBarrier(this.worker, 'model-returned-before-commit');
    }
    return await super.commitValidatedAttempt(command);
  }

  override async getKernelRunProjection(
    scope: Parameters<SqliteAgentJournal['getKernelRunProjection']>[0],
  ): Promise<Awaited<ReturnType<SqliteAgentJournal['getKernelRunProjection']>>> {
    const projection = await super.getKernelRunProjection(scope);
    if (
      this.crashesAt('attempt-committed-before-tool') &&
      projection?.state === 'ResolvingActions'
    ) {
      await crashBarrier(this.worker, 'attempt-committed-before-tool');
    }
    return projection;
  }

  override async getPendingContextCompaction(
    scope: Parameters<SqliteAgentJournal['getPendingContextCompaction']>[0],
  ): Promise<Awaited<ReturnType<SqliteAgentJournal['getPendingContextCompaction']>>> {
    const pending = await super.getPendingContextCompaction(scope);
    if (
      pending === null &&
      this.crashesAt('context-completed-before-next-step')
    ) {
      const checkpoint = await super.getLatestContextCheckpoint({
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        runId: scope.runId,
        status: 'compacted',
      });
      if (checkpoint !== null) {
        await crashBarrier(this.worker, 'context-completed-before-next-step');
      }
    }
    return pending;
  }

  override async getInvocation(
    invocationId: string,
  ): Promise<Awaited<ReturnType<SqliteAgentJournal['getInvocation']>>> {
    const invocation = await super.getInvocation(invocationId);
    if (
      this.crashesAt('tool-terminal-before-observe') &&
      invocation?.terminal !== undefined && invocation.observation === undefined
    ) {
      await crashBarrier(this.worker, 'tool-terminal-before-observe');
    }
    return invocation;
  }

  private crashesAt(mode: CrashMode): boolean {
    return this.worker.phase === 'crash' && this.worker.mode === mode;
  }
}

type RuntimeGates = Readonly<{
  initialAgentStarted: Promise<void>;
  markInitialAgentStarted(): void;
  waitForInitialAgentRelease(): Promise<void>;
  releaseInitialAgent(): void;
  setInitialFinalContentRef(value: string): void;
  isInitialFinalContentRef(value: string): boolean;
}>;

function createRuntimeGates(): RuntimeGates {
  let markInitialAgentStarted!: () => void;
  let releaseInitialAgent!: () => void;
  const initialAgentStarted = new Promise<void>((resolve) => {
    markInitialAgentStarted = resolve;
  });
  const initialAgentRelease = new Promise<void>((resolve) => {
    releaseInitialAgent = resolve;
  });
  let initialFinalContentRef: string | undefined;
  return {
    initialAgentStarted,
    markInitialAgentStarted,
    waitForInitialAgentRelease: async () => await initialAgentRelease,
    releaseInitialAgent,
    setInitialFinalContentRef: (value) => { initialFinalContentRef = value; },
    isInitialFinalContentRef: (value) => value === initialFinalContentRef,
  };
}

function modelClient(worker: WorkerInput, gates: RuntimeGates): ModelClient {
  return {
    execute: async (request) => {
      const compacting = JSON.stringify(request.wireRequest)
        .includes('Summarize only the committed semantic history');
      const counter = compacting ? 'context-model' : 'agent-model';
      const call = incrementCounter(worker.counterPath, counter);
      if (
        worker.phase === 'crash' && isContextMode(worker.mode) &&
        !compacting && call === 1
      ) {
        gates.markInitialAgentStarted();
        await gates.waitForInitialAgentRelease();
      }
      if (
        worker.phase === 'crash' && worker.mode === 'context-started-before-result' &&
        compacting
      ) {
        await crashBarrier(worker, 'context-started-before-result');
      }
      return {
        kind: 'json',
        response: responseFor(worker.mode, request, compacting, call),
      };
    },
  };
}

async function advanceUntilPassive(
  kernel: ReturnType<typeof createJournalAgentKernel>,
  runId: string,
) {
  const passive = new Set([
    'AwaitingUser', 'LimitReached', 'Interrupted', 'Completed', 'Failed', 'Cancelled',
  ]);
  let result = await kernel.advance(runId);
  for (let continuation = 0; continuation < 8 && !passive.has(result.state); continuation += 1) {
    result = await kernel.advance(runId);
  }
  return result;
}

function responseFor(
  mode: CrashMode,
  request: ModelClientRequest,
  compacting: boolean,
  call: number,
): unknown {
  const model = request.route.modelId;
  const usage = { input_tokens: 4, output_tokens: 2, total_tokens: 6 };
  if (compacting) {
    return {
      id: `context-response-${call}`, model, status: 'completed', usage,
      output: [{
        id: `context-message-${call}`, type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'Durable compacted context summary.' }],
      }],
    };
  }
  if (isToolMode(mode) && call === 1) {
    return {
      id: `tool-response-${call}`, model, status: 'completed', usage,
      output: [{
        id: `tool-call-${call}`, type: 'function_call', call_id: `call-${call}`,
        name: 'inspect_project', arguments: '{}',
      }],
    };
  }
  return {
    id: `final-response-${call}`, model, status: 'completed', usage,
    output: [{
      id: `final-message-${call}`, type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'The crash recovery task is complete.' }],
    }],
  };
}

function toolCatalog(worker: WorkerInput): ToolRegistry {
  const registry = fixedBaselineRegistry();
  if (!isToolMode(worker.mode)) return registry;
  const uncertain = worker.mode === 'tool-started-before-terminal';
  const inspectContribution = invocationContribution('inspect_project', {}, {
    handlerRevision: `inspect-project-${uncertain ? 'non-idempotent' : 'read'}@1`,
    exposure: 'direct', access: uncertain ? 'destructive' : 'read',
    recoveryClass: uncertain ? 'non_idempotent' : 'read',
  });
  registry.registerInvocation({
    ...inspectContribution.definition,
    limits: { ...inspectContribution.definition.limits, timeoutMs: 60_000 },
    description: 'Persistent crash acceptance Tool.',
    dangerLevel: uncertain ? 'high' : 'safe', readonly: !uncertain,
    permission: uncertain ? { destructive: true, actions: ['execute'] } : { actions: ['read'] },
    execution: { concurrency: uncertain ? 'write' : 'read', timeoutMs: 60_000 },
  }, {
    ...inspectContribution.runtime,
    prepare: async (preparedInput, context) => ({
      ...await inspectContribution.runtime.prepare(preparedInput, context),
      input: structuredClone(preparedInput),
      toolRevision: context.toolRevision,
      handlerRevision: context.handlerRevision,
      intentRevision: context.intentRevision,
      generation: context.generation,
      limits: context.limits,
    }),
    execute: async () => {
      incrementCounter(worker.counterPath, 'tool-effect');
      if (worker.phase === 'crash' && worker.mode === 'tool-started-before-terminal') {
        await crashBarrier(worker, 'tool-started-before-terminal');
      }
      return { inspected: true };
    },
  });
  return registry;
}

async function authenticModelSession(
  worker: WorkerInput,
  client: ModelClient,
): Promise<ModelSession> {
  mkdirSync(worker.modelCachePath, { recursive: true });
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client,
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const modelId = 'kernel-crash-model';
  const manager = new LlmConnectionManager({
    cacheDirectory: worker.modelCachePath,
    plugins: [providerPlugin(modelId)],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: 'kernel-crash-connection', endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1', credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing crash worker Model connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSession({ connectionId: connection.id, modelId }, {
    generation: { temperature: 0 },
  });
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'kernel-crash-provider', name: 'kernel-crash-provider', mode: 'private',
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
      id: 'kernel-crash-provider-plugin', name: 'kernel-crash-provider', version: '1.0.0',
      protocol: 'openai-responses', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

async function crashBarrier(worker: WorkerInput, label: string): Promise<never> {
  if (!existsSync(worker.barrierPath)) writeFileSync(worker.barrierPath, label, 'utf8');
  await new Promise<never>(() => undefined);
  throw new Error('Unreachable crash barrier.');
}

function incrementCounter(filePath: string, name: string): number {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${name}\n`, 'utf8');
  return readCounter(filePath, name);
}

function readCounter(filePath: string, name: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, 'utf8').split(/\r?\n/u).filter((line) => line === name).length;
}

function isToolMode(mode: CrashMode): boolean {
  return mode === 'attempt-committed-before-tool' ||
    mode === 'tool-started-before-terminal' ||
    mode === 'tool-terminal-before-observe';
}

function isContextMode(mode: CrashMode): boolean {
  return mode === 'context-started-before-result' ||
    mode === 'context-completed-before-next-step';
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

try {
  await main();
} catch (error) {
  writeJson(input.errorPath, {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    rawCausalEvents: rawCausalEvents(input.journalPath),
  });
  throw error;
}

function rawCausalEvents(path: string): readonly unknown[] {
  if (!existsSync(path)) return [];
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (
        filePath: string,
        options?: Readonly<{ readOnly?: boolean }>,
      ) => Readonly<{
        prepare(sql: string): Readonly<{ all(): readonly unknown[] }>;
        close(): void;
      }>;
    };
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(
        `SELECT sequence, event_type, turn_id, attempt_id, invocation_id
         FROM agent_events
         WHERE event_type LIKE 'tool.%' OR event_type LIKE 'turn.%'
            OR event_type = 'model_attempt_committed'
         ORDER BY sequence ASC`,
      ).all();
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}
