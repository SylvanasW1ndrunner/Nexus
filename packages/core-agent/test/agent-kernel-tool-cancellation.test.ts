import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  type LlmConnection,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelClientRequest,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { PermissionManager } from '../src/permission-manager.js';
import type {
  ToolRegistry,
  ToolInvocationExecutionContext,
  ToolInvocationHandlerRuntime,
} from '../src/tool-registry.js';
import type { ToolRecoveryClass } from '../src/tools/tool-protocol.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';
import { resolveViteNodeEntry } from './fixtures/vite-node-entry.js';

type CancellationEffect = ToolRecoveryClass;

type CancellationExpectation = Readonly<{
  effect: CancellationEffect;
  terminal: 'unknown';
  eventType: 'tool.cancelled' | 'tool.unknown';
}>;

const scenarios: readonly CancellationExpectation[] = [
  { effect: 'read', terminal: 'unknown', eventType: 'tool.unknown' },
  { effect: 'idempotent', terminal: 'unknown', eventType: 'tool.unknown' },
  { effect: 'transactional', terminal: 'unknown', eventType: 'tool.unknown' },
  { effect: 'non_idempotent', terminal: 'unknown', eventType: 'tool.unknown' },
] as const;

const temporaryRoots: string[] = [];
const liveChildren = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...liveChildren].map(async (child) => {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => undefined);
  }));
  liveChildren.clear();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent Kernel Tool cancellation', () => {
  it.each(scenarios)(
    'aborts a started $effect Handler and settles one observed $terminal fact before Run cancellation',
    async ({ effect, terminal, eventType }) => {
      const fixture = await onlineFixture(effect);
      const advancing = advanceUntilToolStarted(fixture);
      await fixture.handlerStarted;

      const firstCancel = fixture.kernel.cancel({
        runId: fixture.runId,
        reason: `cancel online ${effect}`,
      });
      const racingCancel = fixture.kernel.cancel({
        runId: fixture.runId,
        reason: `cancel online ${effect}`,
      });
      const [first, second, active] = await Promise.all([firstCancel, racingCancel, advancing]);

      expect(first.state).toBe('Cancelled');
      expect(second.state).toBe('Cancelled');
      expect(active.state).toBe('Cancelled');
      expect(fixture.handlerCalls()).toBe(1);
      expect(fixture.handlerSawAbort()).toBe(true);
      expect(fixture.recoveryCalls()).toBe(0);

      const invocation = onlyInvocation(await fixture.journal.listInvocations(fixture.runId));
      expect(invocation).toMatchObject({
        state: 'observed',
        recoveryClass: effect,
        terminal: {
          kind: terminal,
          error: { code: 'TOOL_CANCELLED' },
        },
        observation: {
          outcome: terminal,
          errorCode: 'TOOL_CANCELLED',
        },
      });
      await expectCancellationFacts(
        fixture.journal,
        fixture.scope,
        eventType,
      );
      await expectOnlineReopenAndRebuildIdentity(fixture);
    },
    20_000,
  );

  it('converges a Tool-terminal/cancel CAS race without duplicate terminal or observation facts', async () => {
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const fixture = await onlineFixture('read', async () => {
      await handlerRelease;
      return toolResult('handler won or raced with cancellation');
    });
    const advancing = advanceUntilToolStarted(fixture);
    await fixture.handlerStarted;

    const cancelling = fixture.kernel.cancel({ runId: fixture.runId, reason: 'race terminal CAS' });
    releaseHandler();
    const [cancelled, active] = await Promise.all([cancelling, advancing]);

    expect(cancelled.state).toBe('Cancelled');
    expect(active.state).toBe('Cancelled');
    const events = await allRunEvents(fixture.journal, fixture.scope);
    const terminalEvents = events.filter(({ type }) =>
      type === 'tool.succeeded' || type === 'tool.failed' ||
      type === 'tool.cancelled' || type === 'tool.unknown');
    expect(terminalEvents).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'tool.observed')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'run.cancel_requested')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'run.cancelled')).toHaveLength(1);
    expect(onlyInvocation(await fixture.journal.listInvocations(fixture.runId)).state)
      .toBe('observed');
    await expectOnlineReopenAndRebuildIdentity(fixture);
  }, 20_000);

  it.each(scenarios)(
    'lets a fresh factory cancel and recover an orphaned started $effect Tool after process exit',
    async ({ effect, terminal, eventType }) => {
      const fixture = crashFixture(effect);
      const worker = startCrashWorker(fixture.worker);
      await waitForFile(fixture.runPath, worker, 15_000, 'Run identity');
      await waitForFile(fixture.barrierPath, worker, 15_000, 'started Tool barrier');
      await waitForFile(
        fixture.cancelBarrierPath,
        worker,
        15_000,
        'persisted Cancelling barrier',
      );
      const runIdentity = readJson<{ runId: string }>(fixture.runPath);
      const before = new SqliteAgentJournal({ filePath: fixture.journalPath });
      const started = onlyInvocation(await before.listInvocations(runIdentity.runId));
      expect(started).toMatchObject({ state: 'started', recoveryClass: effect });
      expect(started.terminal).toBeUndefined();
      expect(await before.getRunProjection(runIdentity.runId)).toMatchObject({
        state: 'Cancelling',
      });
      expect(await before.countEvents('tool.started', fixture.projectId)).toBe(1);
      expect(await before.countEvents('run.cancel_requested', fixture.projectId)).toBe(1);
      expect(await before.countEvents('tool.cancelled', fixture.projectId)).toBe(0);
      expect(await before.countEvents('tool.unknown', fixture.projectId)).toBe(0);
      expect(await before.countEvents('tool.observed', fixture.projectId)).toBe(0);
      expect(await before.countEvents('run.cancelled', fixture.projectId)).toBe(0);

      worker.child.kill('SIGKILL');
      await waitForExit(worker.child, 5_000);
      liveChildren.delete(worker.child);
      await delay(fixture.leaseTtlMs + 100);

      let freshHandlerCalls = 0;
      let freshRecoveryCalls = 0;
      const session = await authenticModelSession({
        cacheDirectory: fixture.freshModelCachePath,
        modelId: fixture.modelId,
        toolName: fixture.toolName,
      });
      const toolCatalog = cancellationToolCatalog(effect, {
        execute: () => {
          freshHandlerCalls += 1;
          return toolResult('fresh execute must not run while cancelling');
        },
        recover: () => {
          freshRecoveryCalls += 1;
          return toolResult('fresh recover must not run while cancelling');
        },
      });
      const journal = new SqliteAgentJournal({ filePath: fixture.journalPath });
      const kernel = createJournalAgentKernel(kernelOptions({
        journal,
        session,
        toolCatalog,
        ownerId: `fresh-canceller-${effect}`,
      }));

      await expect(kernel.cancel({
        runId: runIdentity.runId,
        reason: `cancel orphaned ${effect}`,
      })).resolves.toMatchObject({ state: 'Cancelled' });
      expect(freshHandlerCalls).toBe(0);
      expect(freshRecoveryCalls).toBe(0);
      expect(onlyInvocation(await journal.listInvocations(runIdentity.runId))).toMatchObject({
        state: 'observed',
        recoveryClass: effect,
        terminal: { kind: terminal, error: { code: 'TOOL_CANCELLED' } },
        observation: { outcome: terminal, errorCode: 'TOOL_CANCELLED' },
      });
      const scope = {
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        runId: runIdentity.runId,
      };
      await expectCancellationFacts(journal, scope, eventType);
      await expectOnlineReopenAndRebuildIdentity({
        journal,
        journalPath: fixture.journalPath,
        kernel,
        runId: runIdentity.runId,
        scope,
        session,
        toolCatalog,
      });
    },
    45_000,
  );
});

async function onlineFixture(
  effect: CancellationEffect,
  handlerOverride?: (
    context: ToolInvocationExecutionContext,
  ) => Promise<ReturnType<typeof toolResult>>,
) {
  const root = temporaryRoot(`kernel-tool-cancel-${effect}-`);
  const journalPath = join(root, 'journal.db');
  const journal = new SqliteAgentJournal({ filePath: journalPath });
  const projectId = `project-online-${effect}`;
  const sessionId = `session-online-${effect}`;
  const toolName = 'cancellable_tool';
  let markHandlerStarted!: () => void;
  const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
  let handlerCalls = 0;
  let recoveryCalls = 0;
  let handlerSawAbort = false;
  const execute = async (
    _arguments: Readonly<Record<string, unknown>>,
    context: ToolInvocationExecutionContext,
  ) => {
    handlerCalls += 1;
    context.signal.addEventListener('abort', () => { handlerSawAbort = true; }, { once: true });
    markHandlerStarted();
    if (handlerOverride !== undefined) return await handlerOverride(context);
    await new Promise<never>(() => undefined);
    throw new Error('Unreachable cancellation Handler continuation.');
  };
  const toolCatalog = cancellationToolCatalog(effect, {
    execute,
    recover: () => {
      recoveryCalls += 1;
      return toolResult('recovery must not execute during explicit cancellation');
    },
  });
  const session = await authenticModelSession({
    cacheDirectory: join(root, 'model-cache'),
    modelId: `cancel-model-${effect}`,
    toolName,
  });
  const kernel = createJournalAgentKernel(kernelOptions({
    journal,
    session,
    toolCatalog,
    ownerId: `online-canceller-${effect}`,
  }));
  const started = await kernel.start({
    projectId,
    sessionId,
    clientRequestId: `request-online-${effect}`,
    input: `Start the ${effect} cancellation Tool.`,
  });
  return {
    root,
    journalPath,
    journal,
    kernel,
    session,
    toolCatalog,
    runId: started.runId,
    scope: { projectId, sessionId, runId: started.runId },
    handlerStarted,
    handlerCalls: () => handlerCalls,
    recoveryCalls: () => recoveryCalls,
    handlerSawAbort: () => handlerSawAbort,
  };
}

function cancellationToolCatalog(
  effect: CancellationEffect,
  handlers: Pick<ToolInvocationHandlerRuntime, 'execute' | 'recover'>,
) {
  const registry = fixedBaselineRegistry();
  const contribution = invocationContribution('cancellable_tool', {}, {
    handlerRevision: `cancellable-tool-${effect}@1`, exposure: 'direct',
    access: effect === 'read' ? 'read' : 'write', recoveryClass: effect,
  });
  registry.registerInvocation({
    ...contribution.definition,
    limits: { ...contribution.definition.limits, timeoutMs: 60_000 },
    description: `Cancellation acceptance Tool with ${effect} recovery semantics.`,
    dangerLevel: effect === 'read' ? 'safe' : 'medium',
    readonly: effect === 'read',
    permission: { actions: ['read'] },
    exposure: 'direct',
    inputSchema: { type: 'object', additionalProperties: false },
    execution: { concurrency: effect === 'read' ? 'read' : 'write', timeoutMs: 60_000 },
  }, {
    ...contribution.runtime,
    prepare: (input, context) => ({
      input,
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
    execute: handlers.execute,
    ...(effect === 'transactional' && handlers.recover !== undefined
      ? { recover: handlers.recover }
      : {}),
  });
  return registry.captureSnapshot();
}

function kernelOptions(input: Readonly<{
  journal: SqliteAgentJournal;
  session: ModelSession;
  toolCatalog: ReturnType<ToolRegistry['captureSnapshot']>;
  ownerId: string;
}>): Parameters<typeof createJournalAgentKernel>[0] {
  return {
    journal: input.journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => input.session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: input.toolCatalog,
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol',
      source: 'runtime',
      scope: 'static',
      priority: 0,
      revision: 'runtime-r1',
      cacheability: 'stable',
      tokenEstimate: 8,
      content: [{ type: 'text', text: 'Use the exact captured Tool once.' }],
    },
    capability: { snapshotId: 'cancel-capability', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    revalidateToolTarget: () => undefined,
    mode: 'full-access',
    ownerId: input.ownerId,
  };
}

async function authenticModelSession(input: Readonly<{
  cacheDirectory: string;
  modelId: string;
  toolName: string;
}>): Promise<ModelSession> {
  let modelCalls = 0;
  const client: ModelClient = {
    execute: (request) => {
      modelCalls += 1;
      return Promise.resolve({
        kind: 'json',
        response: modelResponse(request, input.toolName, modelCalls),
      });
    },
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
    cacheDirectory: input.cacheDirectory,
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

function modelResponse(request: ModelClientRequest, toolName: string, call: number): unknown {
  const model = request.route.modelId;
  const usage = { input_tokens: 4, output_tokens: 2, total_tokens: 6 };
  if (call === 1) {
    return {
      id: 'cancel-tool-response',
      model,
      status: 'completed',
      usage,
      output: [{
        id: 'cancel-tool-call',
        type: 'function_call',
        call_id: 'cancel-call-1',
        name: toolName,
        arguments: '{}',
      }],
    };
  }
  return {
    id: `unexpected-final-response-${call}`,
    model,
    status: 'completed',
    usage,
    output: [{
      id: `unexpected-final-message-${call}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'This response must not complete a cancelled Run.' }],
    }],
  };
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'cancel-provider',
    name: 'cancel-provider',
    mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'unused', toolCalls: [] }),
    listModels: () => Promise.resolve([modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'cancel-provider-plugin',
      name: 'cancel-provider',
      version: '1.0.0',
      protocol: 'openai-responses',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function toolResult(note: string) {
  return { note };
}

async function expectCancellationFacts(
  journal: SqliteAgentJournal,
  scope: RunScope,
  expectedTerminalType: CancellationExpectation['eventType'],
): Promise<void> {
  const events = await allRunEvents(journal, scope);
  expect(events.filter(({ type }) => type === 'tool.started')).toHaveLength(1);
  expect(events.filter(({ type }) => type === expectedTerminalType)).toHaveLength(1);
  expect(events.filter(({ type }) => type === 'tool.succeeded')).toHaveLength(0);
  expect(events.filter(({ type }) => type === 'tool.failed')).toHaveLength(0);
  const otherCancellationTerminal = expectedTerminalType === 'tool.cancelled'
    ? 'tool.unknown'
    : 'tool.cancelled';
  expect(events.filter(({ type }) => type === otherCancellationTerminal)).toHaveLength(0);
  expect(events.filter(({ type }) => type === 'tool.observed')).toHaveLength(1);
  expect(events.filter(({ type }) => type === 'run.cancel_requested')).toHaveLength(1);
  expect(events.filter(({ type }) => type === 'run.cancelled')).toHaveLength(1);
  expect(events.filter(({ type }) => type === 'run.completed')).toHaveLength(0);
  expect(events.filter(({ type }) => type === 'run.failed')).toHaveLength(0);
  expect(events.filter(({ type, payload }) =>
    type === 'turn.closed' && payload.reason === 'cancelled')).toHaveLength(1);

  const sequenceOf = (type: (typeof events)[number]['type']) => {
    const event = events.find((candidate) => candidate.type === type);
    if (event === undefined) throw new Error(`Expected cancellation event ${type}.`);
    return event.sequence;
  };
  const cancelRequestedSequence = sequenceOf('run.cancel_requested');
  const terminalSequence = sequenceOf(expectedTerminalType);
  const observedSequence = sequenceOf('tool.observed');
  const turnClosedSequence = sequenceOf('turn.closed');
  const runCancelledSequence = sequenceOf('run.cancelled');
  expect(cancelRequestedSequence).toBeLessThan(terminalSequence);
  expect(terminalSequence).toBeLessThan(observedSequence);
  expect(observedSequence).toBeLessThan(turnClosedSequence);
  expect(turnClosedSequence).toBeLessThan(runCancelledSequence);
}

async function expectOnlineReopenAndRebuildIdentity(input: Readonly<{
  journal: SqliteAgentJournal;
  journalPath: string;
  kernel: ReturnType<typeof createJournalAgentKernel>;
  runId: string;
  scope: RunScope;
  session: ModelSession;
  toolCatalog: ReturnType<ToolRegistry['captureSnapshot']>;
}>): Promise<void> {
  const onlineRun = await input.kernel.open(input.runId);
  const onlineInvocation = onlyInvocation(await input.journal.listInvocations(input.runId));
  const reopenedJournal = new SqliteAgentJournal({ filePath: input.journalPath });
  const reopenedKernel = createJournalAgentKernel(kernelOptions({
    journal: reopenedJournal,
    session: input.session,
    toolCatalog: input.toolCatalog,
    ownerId: `reopen-${input.scope.projectId}`,
  }));
  expect(await reopenedKernel.open(input.runId)).toEqual(onlineRun);
  expect(onlyInvocation(await reopenedJournal.listInvocations(input.runId))).toEqual(onlineInvocation);

  await reopenedJournal.rebuildProjectProjections(input.scope.projectId);
  expect(await reopenedKernel.open(input.runId)).toEqual(onlineRun);
  expect(onlyInvocation(await reopenedJournal.listInvocations(input.runId))).toEqual(onlineInvocation);
}

type RunScope = Readonly<{ projectId: string; sessionId: string; runId: string }>;

async function advanceUntilToolStarted(
  fixture: Awaited<ReturnType<typeof onlineFixture>>,
) {
  let run = await fixture.kernel.advance(fixture.runId);
  for (let boundary = 0; boundary < 3; boundary += 1) {
    if (await fixture.journal.countEvents('tool.started', fixture.scope.projectId) === 1) return run;
    if (run.state !== 'Preparing') {
      throw new Error(`Expected a Preparing boundary before Tool execution, got ${run.state}.`);
    }
    // Each iteration crosses one durable boundary. Once the Handler's barrier
    // fires, preserve that in-flight advance for the caller to settle by
    // cancellation instead of awaiting the never-ending Handler here.
    const next = fixture.kernel.advance(fixture.runId);
    const boundaryResult = await Promise.race([
      fixture.handlerStarted.then(() => ({ kind: 'started' as const })),
      next.then((nextRun) => ({ kind: 'boundary' as const, run: nextRun })),
    ]);
    if (boundaryResult.kind === 'started') return next;
    run = boundaryResult.run;
  }
  throw new Error('Tool did not reach its persisted started boundary.');
}

async function allRunEvents(journal: SqliteAgentJournal, scope: RunScope) {
  const events = [];
  let afterSequence = 0;
  while (true) {
    const page = await journal.readRunEvents({ ...scope, afterSequence, limit: 500 });
    events.push(...page.events);
    if (page.events.length < 500 || page.nextSequence === null) return events;
    afterSequence = page.nextSequence;
  }
}

function onlyInvocation<T>(invocations: readonly T[]): T {
  expect(invocations).toHaveLength(1);
  const invocation = invocations[0];
  if (invocation === undefined) throw new Error('Expected exactly one Tool Invocation.');
  return invocation;
}

function crashFixture(effect: CancellationEffect) {
  const root = temporaryRoot(`kernel-tool-cancel-crash-${effect}-`);
  const projectId = `project-crash-${effect}`;
  const sessionId = `session-crash-${effect}`;
  // Cross-process worker startup competes with the full fork pool. Keep this
  // comfortably above scheduler jitter; short-TTL expiry semantics are covered
  // by the focused lease/recovery tests.
  const leaseTtlMs = 10_000;
  const journalPath = join(root, 'journal.db');
  const barrierPath = join(root, 'tool-started.txt');
  const cancelBarrierPath = join(root, 'run-cancelling.txt');
  const runPath = join(root, 'run.json');
  const modelId = `cancel-model-${effect}`;
  const toolName = 'cancellable_tool';
  return {
    root,
    projectId,
    sessionId,
    journalPath,
    barrierPath,
    cancelBarrierPath,
    runPath,
    leaseTtlMs,
    modelId,
    toolName,
    freshModelCachePath: join(root, 'fresh-model-cache'),
    worker: {
      effect,
      projectId,
      sessionId,
      journalPath,
      barrierPath,
      cancelBarrierPath,
      runPath,
      leaseTtlMs,
      modelId,
      toolName,
      modelCachePath: join(root, 'worker-model-cache'),
    },
  };
}

type CrashWorkerInput = ReturnType<typeof crashFixture>['worker'];

function startCrashWorker(input: CrashWorkerInput) {
  const child = spawn(process.execPath, [viteNodePath(), crashWorkerPath()], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    env: {
      ...process.env,
      SCHEMANAUT_TOOL_CANCEL_CRASH_INPUT: JSON.stringify(input),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  liveChildren.add(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  return { child, output: () => output };
}

function crashWorkerPath(): string {
  return fileURLToPath(new URL('./fixtures/tool-cancellation-crash-worker.ts', import.meta.url));
}

function viteNodePath(): string {
  return resolveViteNodeEntry();
}

async function waitForFile(
  path: string,
  worker: Readonly<{ child: ChildProcess; output(): string }>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`${label} worker exited early: ${worker.output()}`);
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}: ${worker.output()}`);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for cancellation fixture worker exit.'));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
