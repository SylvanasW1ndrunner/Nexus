import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import {
  JournalAgentModelResolutionError,
  type JournalAgentPermissionPolicyLease,
  type JournalAgentPromptSnapshotLease,
  type JournalAgentToolCatalogLease,
  type JournalAgentTurnRuntimeLease,
  type JournalAgentVerifierLease,
} from '../src/kernel/journal-agent-kernel-port.js';
import { RunController } from '../src/kernel/run-controller.js';
import { SessionModelBindingStore } from '../src/kernel/session-model-binding.js';
import { PermissionManager } from '../src/permission-manager.js';
import { type ToolCatalogSnapshot, type ToolInvocationHandlerRuntime, type ToolRegistry } from '../src/tool-registry.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';
import { createRuntimeCommandToolResult } from '../src/runtime-command-tool-result.js';
import { UserActivityProjector } from '../src/session/session-projection.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent Kernel factory recovery boundaries', () => {
  it('persists an executor interruption before the first Turn and resumes the same Run', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'executor-interruption-model' });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
    }));
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'executor-interruption-session',
      clientRequestId: 'executor-interruption-request', input: 'Recover this exact Run.',
    });

    await expect(kernel.interruptExecution({
      runId: started.runId,
      code: 'RUNTIME_DRIVER_FAILED',
      detail: { category: 'runtime-driver' },
    })).resolves.toMatchObject({ state: 'Interrupted' });
    await expect(kernel.interruptExecution({
      runId: started.runId,
      code: 'RUNTIME_DRIVER_FAILED',
      detail: { category: 'runtime-driver' },
    })).resolves.toMatchObject({ state: 'Interrupted' });

    const interruptedEvents = (await readAllRunEvents(
      journal, started.runId, started.sessionId,
    )).filter((event) => event.type === 'run.interrupted');
    expect(interruptedEvents).toHaveLength(1);
    expect(interruptedEvents[0]?.payload).toEqual({
      code: 'RUNTIME_DRIVER_FAILED',
      detail: { category: 'runtime-driver' },
      resumeState: 'created',
    });

    await expect(kernel.resume({ runId: started.runId })).resolves.toMatchObject({
      runId: started.runId,
      state: 'created',
    });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({
      runId: started.runId,
      state: 'Completed',
    });
  });

  it('persists steering idempotency by client request identity', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'steer-model' });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session,
    }));
    const started = await captureRun(journal, session, 'steer-idempotency');
    const steering = {
      runId: started.runId, clientRequestId: 'steer-request-1', input: 'New direction.',
    };

    const first = await kernel.steer(steering);
    const replay = await kernel.steer(steering);
    expect(replay).toEqual(first);
    await expect(kernel.steer({ ...steering, input: 'Conflicting direction.' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const events = await readAllRunEvents(journal, started.runId, started.sessionId);
    expect(events.filter((event) => event.type === 'run.steered')).toHaveLength(1);
  });

  it('queues steering during Model work and consumes it only at the next safe boundary', async () => {
    const journal = createJournal();
    let calls = 0;
    const session = await authenticModelSession({
      modelId: 'queued-steer-model', delayMs: 450, onExecute: () => { calls += 1; },
    });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session,
    }));
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'queued-steer-session',
      clientRequestId: 'queued-steer-start', input: 'Initial request.',
    });
    const advancing = kernel.advance(started.runId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await journal.getRunProjection(started.runId))?.state === 'ReceivingModel') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await journal.getRunProjection(started.runId))?.state).toBe('ReceivingModel');
    const steering = {
      runId: started.runId, clientRequestId: 'queued-steer-request',
      input: 'Apply this direction after the in-flight response.',
    };
    await expect(kernel.steer(steering)).resolves.toMatchObject({ state: 'ReceivingModel' });
    await expect(kernel.steer(steering)).resolves.toMatchObject({ state: 'ReceivingModel' });
    await expect(kernel.steer({ ...steering, input: 'Conflicting queued direction.' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(journal.getPendingSteering({
      projectId: 'project-1', sessionId: started.sessionId, runId: started.runId,
    })).resolves.toMatchObject({ clientRequestId: steering.clientRequestId, input: steering.input });

    await expect(advancing).resolves.toMatchObject({ state: 'Completed' });
    expect(calls).toBe(2);
    await expect(journal.getPendingSteering({
      projectId: 'project-1', sessionId: started.sessionId, runId: started.runId,
    })).resolves.toBeNull();
    const events = await readAllRunEvents(journal, started.runId, started.sessionId);
    expect(events.filter((event) => event.type === 'run.steered')).toHaveLength(1);
  });

  it('recovers a queued in-flight steering request after restart', async () => {
    const journal = createJournal();
    let calls = 0;
    const session = await authenticModelSession({
      modelId: 'restart-steer-model', onExecute: () => { calls += 1; },
    });
    const started = await captureRun(journal, session, 'restart-queued-steer');
    const firstKernel = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session, ownerId: 'queued-steer-first-owner',
    }));
    const current = await firstKernel.open(started.runId);
    if (current?.currentTurnId === null || current?.currentTurnId === undefined) {
      throw new Error('Captured fixture Turn is missing.');
    }
    const lifecycle = await journal.getTurnLifecycle({
      projectId: 'project-1', sessionId: started.sessionId,
      runId: started.runId, turnId: current.currentTurnId,
    });
    if (lifecycle === null) throw new Error('Captured fixture lifecycle is missing.');
    const setup = new RunController({
      journal, projectId: 'project-1', sessionId: started.sessionId, runId: started.runId,
      ownerId: 'queued-steer-setup', leaseTtlMs: 60_000,
    });
    await setup.acquire();
    await setup.commitContextReady({
      commandId: 'queued-steer-context-ready', expectedRunRevision: current.revision,
      turnId: current.currentTurnId, expectedTurnRevision: lifecycle.revision,
    });
    await setup.release();
    const steering = {
      runId: started.runId, clientRequestId: 'restart-steering',
      input: 'Persist this direction across restart.',
    };
    await expect(firstKernel.steer(steering)).resolves.toMatchObject({ state: 'CallingModel' });
    await firstKernel.releaseExecution(started.runId);

    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    const restarted = createJournalAgentKernel(factoryOptions({
      journal: reopened, resolveModelSession: () => session,
      ownerId: 'queued-steer-restart-owner',
    }));
    await expect(restarted.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    await expect(restarted.steer(steering)).resolves.toMatchObject({ state: 'Completed' });
    await expect(restarted.steer({ ...steering, input: 'Conflicting after restart.' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(calls).toBe(2);
    await expect(reopened.getPendingSteering({
      projectId: 'project-1', sessionId: started.sessionId, runId: started.runId,
    })).resolves.toBeNull();
  });

  it('exports only the production factory from the package root', async () => {
    const publicApi = await import('../src/index.js');

    expect(publicApi).toHaveProperty('createJournalAgentKernel');
    expect(publicApi).not.toHaveProperty('JournalAgentKernelPort');
    expect(publicApi).not.toHaveProperty('RunController');
  });

  it('waits for the exact missing Model secret without substituting another Session', async () => {
    const journal = createJournal();
    const original = await authenticModelSession({ modelId: 'model-a' });
    const run = await captureRun(journal, original, 'missing-secret');
    let resolverCalls = 0;
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: ({ binding }) => {
        resolverCalls += 1;
        expect(binding?.source).toBe('run-environment');
        throw new JournalAgentModelResolutionError(
          'MODEL_CONNECTION_REQUIRED',
          'The exact connection credential must be configured.',
          { connectionId: original.route.connectionId },
        );
      },
    }));

    await expect(kernel.advance(run.runId)).resolves.toMatchObject({
      state: 'AwaitingUser',
      waitReason: 'model_connection_required',
    });
    expect(resolverCalls).toBe(1);
    expect(await journal.countEvents('model_attempt_started')).toBe(0);
  });

  it('interrupts when the exact persisted Model binding is unavailable and never falls back', async () => {
    const journal = createJournal();
    let originalCalls = 0;
    let substituteCalls = 0;
    const original = await authenticModelSession({
      modelId: 'model-a',
      onExecute: () => { originalCalls += 1; },
    });
    const substitute = await authenticModelSession({
      modelId: 'model-b',
      onExecute: () => { substituteCalls += 1; },
    });
    const run = await captureRun(journal, original, 'binding-unavailable');
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => substitute,
    }));

    await expect(kernel.advance(run.runId)).resolves.toMatchObject({ state: 'Interrupted' });
    expect(originalCalls).toBe(0);
    expect(substituteCalls).toBe(0);
    const events = await readAllRunEvents(journal, run.runId, run.sessionId);
    expect(events.some((event) =>
      event.type === 'run.interrupted' &&
      event.payload.code === 'MODEL_BINDING_UNAVAILABLE')).toBe(true);
  });

  it('renews its lease throughout a long Model call and releases it at terminal completion', async () => {
    const journal = createJournal();
    let calls = 0;
    let signalModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => { signalModelStarted = resolve; });
    const session = await authenticModelSession({
      modelId: 'slow-model',
      delayMs: 1_100,
      onExecute: () => {
        calls += 1;
        signalModelStarted?.();
      },
    });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      leaseTtlMs: 500,
    }));
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'slow-session',
      clientRequestId: 'slow-request', input: 'Wait for the real Model response.',
    });

    vi.useFakeTimers();
    try {
      const completion = kernel.advance(started.runId);
      await Promise.race([
        modelStarted,
        completion.then(() => {
          throw new Error('Run completed before Model work started.');
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(completion).resolves.toMatchObject({ state: 'Completed' });
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(1);
    expect(await journal.getRunLease('project-1', started.runId)).toBeNull();
    let restartResolverCalls = 0;
    const restarted = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => {
        restartResolverCalls += 1;
        return session;
      },
      ownerId: 'completed-restart-owner',
    }));
    await expect(restarted.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(restartResolverCalls).toBe(0);
    expect(calls).toBe(1);
  });

  it('aborts in-flight Model work when lease renewal is lost', async () => {
    const journal = createRenewalFailingJournal();
    let startedModelWork = false;
    let observedAbort = false;
    const session = await authenticModelSession({
      modelId: 'lease-loss-model',
      delayMs: 10_000,
      onExecute: (request) => {
        startedModelWork = true;
        journal.armRenewalFailure();
        request.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
      },
    });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      leaseTtlMs: 3_000,
    }));
    const run = await kernel.start({
      projectId: 'project-1', sessionId: 'lease-loss-session',
      clientRequestId: 'lease-loss-request', input: 'Keep this operation fenced.',
    });

    await expect(kernel.advance(run.runId)).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' });
    expect(startedModelWork).toBe(true);
    expect(observedAbort).toBe(true);
    expect(await journal.countEvents('model_attempt_committed')).toBe(0);

    const eventsAfterLoss = await readAllRunEvents(journal, run.runId, run.sessionId);
    await wait(350);
    expect(await readAllRunEvents(journal, run.runId, run.sessionId)).toHaveLength(
      eventsAfterLoss.length,
    );

    journal.disarmRenewalFailure();
    let recoveryCalls = 0;
    const recoverySession = await authenticModelSession({
      modelId: 'lease-loss-model',
      onExecute: () => { recoveryCalls += 1; },
    });
    const recoveredKernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => recoverySession,
      ownerId: 'factory-recovery-owner-2',
    }));
    await expect(recoveredKernel.advance(run.runId)).resolves.toMatchObject({ state: 'Completed' });
    const recoveredEvents = (await readAllRunEvents(journal, run.runId, run.sessionId))
      .slice(eventsAfterLoss.length);
    expect(recoveredEvents.filter((event) => event.type === 'model_attempt_discarded'))
      .toHaveLength(1);
    expect(recoveredEvents).toContainEqual(expect.objectContaining({
      type: 'model_attempt_discarded',
      payload: { reason: 'executor-lease-recovered' },
    }));
    expect(recoveryCalls).toBe(1);
    expect(await journal.countEvents('model_attempt_committed')).toBe(1);
  }, 15_000);

  it('aborts a real in-flight Model call before durably settling cancellation', async () => {
    const journal = createJournal();
    let modelStarted!: () => void;
    const startedModel = new Promise<void>((resolve) => { modelStarted = resolve; });
    let observedAbort = false;
    const session = await authenticModelSession({
      modelId: 'cancel-model',
      delayMs: 30_000,
      onExecute: (request) => {
        request.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
        modelStarted();
      },
    });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      ownerId: 'cancel-model-owner',
    }));
    const run = await kernel.start({
      projectId: 'project-1', sessionId: 'cancel-model-session',
      clientRequestId: 'cancel-model-request', input: 'Start cancellable model work.',
    });

    const advancing = kernel.advance(run.runId);
    await startedModel;
    await expect(kernel.cancel({ runId: run.runId, reason: 'user cancelled' }))
      .resolves.toMatchObject({ state: 'Cancelled' });
    await expect(advancing).resolves.toMatchObject({ state: 'Cancelled' });
    expect(observedAbort).toBe(true);
    expect(await journal.countEvents('model_attempt_discarded')).toBe(1);
    expect(await journal.countEvents('model_attempt_committed')).toBe(0);
  });

  it('consumes prior verifier decisions from durable Journal facts after restart', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'verifier-model' });
    const verifier = {
      verifierId: 'delivery-verifier', revision: 'v1', mode: 'required' as const,
      verify: () => ({ status: 'revise' as const, observation: 'add durable evidence' }),
    };
    const first = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session, verifier,
    }));
    const started = await first.start({
      projectId: 'project-1', sessionId: 'verifier-session',
      clientRequestId: 'verifier-request', input: 'Deliver a verified answer.',
    });
    const limited = await first.advance(started.runId, { limits: { maxTurns: 1 } });
    expect(limited.state).toBe('LimitReached');

    const restarted = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session, verifier,
    }));
    await restarted.resume({ runId: started.runId, reason: 'continue verification' });
    await expect(restarted.advance(started.runId, { limits: { maxTurns: 3 } }))
      .resolves.toMatchObject({ state: 'Preparing' });
    await expect(restarted.advance(started.runId, { limits: { maxTurns: 3 } }))
      .resolves.toMatchObject({ state: 'Failed' });

    const decisions = (await readAllRunEvents(journal, started.runId, 'verifier-session'))
      .filter((event) => event.type === 'delivery.decided');
    expect(decisions.filter((event) => event.payload.outcome === 'revision-requested')).toHaveLength(1);
    expect(decisions.at(-1)?.payload.outcome).toBe('failed');
  });

  it('resolves the exact immutable Tool Catalog generation captured by an old Turn', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'tool-snapshot-model' });
    const oldCatalog = invocationCatalog('old-handler');
    const oldSnapshot = oldCatalog.captureSnapshot();
    const captured = await captureRun(journal, session, 'old-tool-snapshot', oldSnapshot);
    const newSnapshot = invocationCatalog('new-handler').captureSnapshot();
    let resolverCalls = 0;
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      toolCatalog: newSnapshot,
      resolveToolCatalogSnapshot: ({ tools }): JournalAgentToolCatalogLease => {
        resolverCalls += 1;
        expect(tools).toEqual(oldSnapshot.llmTools().map(({ name }) => ({
          name,
          revision: requiredToolRevision(oldSnapshot, name),
        })));
        return { snapshot: oldSnapshot, release: () => undefined };
      },
    }));

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(resolverCalls).toBeGreaterThan(0);
  });

  it('wires the production post-commit Runtime Command executor into Tool execution', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'runtime-command-executor-model',
      toolName: 'subagent_spawn',
    });
    const catalog = childCommandCatalog().captureSnapshot();
    let observedChildRunId: string | undefined;
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      toolCatalog: catalog,
      runtimeCommandExecutor: ({ command, application }) => {
        expect(command.kind).toBe('child.start');
        observedChildRunId = application.projection.children[0]?.childRunId;
        return { state: 'completed', childRunId: observedChildRunId ?? null };
      },
    }));
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'runtime-command-executor-session',
      clientRequestId: 'runtime-command-executor-request',
      input: 'Start the child task.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    expect(observedChildRunId).toMatch(/^child_[a-f0-9]{32}$/u);
    expect(await journal.countEvents('runtime.command_applied', 'project-1')).toBe(1);
    expect(await journal.countEvents('tool.succeeded', 'project-1')).toBe(1);
  });

  it('interrupts instead of executing a same-name Tool with a different revision', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'missing-tool-model' });
    const oldSnapshot = invocationCatalog('old-handler').captureSnapshot();
    const captured = await captureRun(journal, session, 'missing-old-tool', oldSnapshot);
    const newSnapshot = invocationCatalog('new-handler').captureSnapshot();
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      toolCatalog: newSnapshot,
      resolveToolCatalogSnapshot: () => {
        throw new Error('old catalog generation was retired');
      },
    }));

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({ state: 'Interrupted' });
    const events = await readAllRunEvents(journal, captured.runId, captured.sessionId);
    expect(events.some((event) =>
      event.type === 'run.interrupted' &&
      event.payload.code === 'TOOL_CATALOG_REVISION_UNAVAILABLE')).toBe(true);
    expect(await journal.countEvents('model_attempt_started')).toBe(0);
  });

  it('rehydrates the exact prompt snapshot instead of using a newer factory prompt', async () => {
    const journal = createJournal();
    let observedSystemText = '';
    const session = await authenticModelSession({
      modelId: 'prompt-snapshot-model',
      onExecute: (request) => {
        const wireRequest = JSON.stringify(request.wireRequest);
        observedSystemText = wireRequest.includes('captured prompt A')
          ? 'captured prompt A'
          : wireRequest.includes('current prompt B') ? 'current prompt B' : wireRequest;
      },
    });
    const captured = await captureRun(journal, session, 'prompt-snapshot');
    let resolverCalls = 0;
    const options = factoryOptions({ journal, resolveModelSession: () => session });
    const kernel = createJournalAgentKernel({
      ...options,
      promptRevision: 'prompt-r2',
      runtimeProtocol: promptSection('runtime-r2', 'current prompt B'),
      resolvePromptSnapshot: ({ promptRevision }): JournalAgentPromptSnapshotLease => {
        resolverCalls += 1;
        expect(promptRevision).toBe('prompt-r1');
        return {
          revision: 'prompt-r1',
          runtimeProtocol: promptSection('runtime-r1', 'captured prompt A'),
          sections: [],
          release: () => undefined,
        };
      },
    });

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(resolverCalls).toBeGreaterThan(0);
    expect(observedSystemText).toBe('captured prompt A');
  });

  it('waits for an unavailable exact prompt revision without calling the model', async () => {
    const journal = createJournal();
    let modelCalls = 0;
    const session = await authenticModelSession({
      modelId: 'prompt-missing-model', onExecute: () => { modelCalls += 1; },
    });
    const captured = await captureRun(journal, session, 'prompt-missing');
    const options = factoryOptions({ journal, resolveModelSession: () => session });
    const kernel = createJournalAgentKernel({
      ...options,
      promptRevision: 'prompt-r2',
      runtimeProtocol: promptSection('runtime-r2', 'current prompt B'),
    });

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({
      state: 'AwaitingUser', waitReason: 'capability_revision_required',
    });
    expect(modelCalls).toBe(0);
  });

  it('uses the captured permission policy after restart instead of a newer permissive policy', async () => {
    const journal = createJournal();
    const catalog = writeCatalog(() => ({ ok: true }));
    const session = await authenticModelSession({
      modelId: 'permission-snapshot-model',
      toolName: 'write_project_file',
    });
    const captured = await captureRun(
      journal,
      session,
      'permission-snapshot',
      catalog.captureSnapshot(),
    );
    let resolverCalls = 0;
    let executions = 0;
    const executingCatalog = writeCatalog(() => {
      executions += 1;
      return { ok: true };
    }).captureSnapshot();
    const options = factoryOptions({
      journal,
      resolveModelSession: () => session,
      toolCatalog: executingCatalog,
    });
    const kernel = createJournalAgentKernel({
      ...options,
      permissionPolicyRevision: 'permission-r2',
      mode: 'full-access',
      resolvePermissionPolicy: ({ permissionPolicyRevision }): JournalAgentPermissionPolicyLease => {
        resolverCalls += 1;
        expect(permissionPolicyRevision).toBe('permission-r1');
        return {
          revision: 'permission-r1',
          permissionManager: new PermissionManager(),
          mode: 'default',
          release: () => undefined,
        };
      },
    });

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({
      state: 'AwaitingUser', waitReason: 'approval',
    });
    expect(resolverCalls).toBeGreaterThan(0);
    expect(executions).toBe(0);
    const pending = await journal.listApprovals({
      projectId: 'project-1', sessionId: captured.sessionId,
      runId: captured.runId, status: 'pending', limit: 10,
    });
    expect(pending.items).toHaveLength(1);
  });

  it('uses the exact captured verifier revision after restart', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'verifier-snapshot-model' });
    const captured = await captureRun(
      journal,
      session,
      'verifier-snapshot',
      undefined,
      [{ id: 'delivery-verifier', revision: 'v1', required: true }],
    );
    let oldVerifierCalls = 0;
    let newVerifierCalls = 0;
    let resolverCalls = 0;
    const options = factoryOptions({ journal, resolveModelSession: () => session });
    const kernel = createJournalAgentKernel({
      ...options,
      verifier: {
        verifierId: 'delivery-verifier', revision: 'v2', mode: 'required',
        verify: () => { newVerifierCalls += 1; return { status: 'accepted' }; },
      },
      resolveVerifier: ({ verifier }): JournalAgentVerifierLease => {
        resolverCalls += 1;
        expect(verifier).toEqual({ id: 'delivery-verifier', revision: 'v1', required: true });
        return {
          verifier: {
            verifierId: 'delivery-verifier', revision: 'v1', mode: 'required',
            verify: () => { oldVerifierCalls += 1; return { status: 'accepted' }; },
          },
          release: () => undefined,
        };
      },
    });

    await expect(kernel.advance(captured.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(resolverCalls).toBeGreaterThan(0);
    expect(oldVerifierCalls).toBe(1);
    expect(newVerifierCalls).toBe(0);
  });

  it('captures and releases one immutable runtime dependency generation per Turn', async () => {
    const journal = createJournal();
    const observedPrompts: string[] = [];
    const session = await authenticModelSession({
      modelId: 'dynamic-runtime-model',
      onExecute: (request) => {
        const rendered = JSON.stringify(request.wireRequest);
        observedPrompts.push(
          rendered.includes('runtime generation 1')
            ? 'runtime generation 1'
            : rendered.includes('runtime generation 2')
              ? 'runtime generation 2'
              : rendered,
        );
      },
    });
    let captures = 0;
    let verifierCalls = 0;
    const released: number[] = [];
    const kernel = createJournalAgentKernel({
      ...factoryOptions({ journal, resolveModelSession: () => session }),
      captureTurnRuntime: () => {
        captures += 1;
        const generation = captures;
        const tools = fixedBaselineRegistry().captureSnapshot();
        return {
          capability: {
            snapshotId: `capability-${generation}`,
            revision: `capability-r${generation}`,
          },
          toolCatalog: tools,
          promptRevision: `prompt-r${generation}`,
          runtimeProtocol: promptSection(
            `runtime-r${generation}`,
            `runtime generation ${generation}`,
          ),
          promptSections: [],
          skills: [],
          verifier: {
            verifierId: 'dynamic-runtime-verifier',
            revision: `verifier-r${generation}`,
            mode: 'required' as const,
            verify: () => {
              verifierCalls += 1;
              return verifierCalls === 1
                ? { status: 'revise' as const, observation: 'one more turn' }
                : { status: 'accepted' as const };
            },
          },
          release: () => {
            tools.release();
            released.push(generation);
          },
        };
      },
    });
    const started = await kernel.start({
      projectId: 'project-1',
      sessionId: 'dynamic-runtime-session',
      clientRequestId: 'dynamic-runtime-request',
      input: 'Use a fresh capability generation for every Turn.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(captures).toBe(2);
    expect(observedPrompts).toEqual(['runtime generation 1', 'runtime generation 2']);
    expect(released).toEqual([1, 2]);
  });

  it.each([
    ['runtime protocol', { runtimeProtocol: null }],
    ['prompt section', { promptSections: [null] }],
    ['Skill Tool allowlist', {
      skills: [{ id: 'skill-a', revision: 'skill@1', allowedTools: [42] }],
    }],
    ['Invocation Hook phase', {
      invocationHooks: [{ id: 'audit', revision: 'audit@1', before: 'not-a-function' }],
    }],
  ] as const)('rejects a malformed captured Turn %s before model execution', async (_label, patch) => {
    const journal = createJournal();
    let modelCalls = 0;
    let releases = 0;
    const session = await authenticModelSession({
      modelId: 'malformed-runtime-model', onExecute: () => { modelCalls += 1; },
    });
    const catalog = fixedBaselineRegistry().captureSnapshot();
    const runtime = {
      capability: { snapshotId: 'capability-malformed', revision: 'capability-malformed@1' },
      toolCatalog: catalog,
      promptRevision: 'prompt-malformed@1',
      runtimeProtocol: promptSection('runtime-malformed@1', 'runtime'),
      promptSections: [],
      skills: [],
      release: () => {
        releases += 1;
        catalog.release();
      },
      ...patch,
    } as unknown as JournalAgentTurnRuntimeLease;
    let currentRuntime = runtime;
    const kernel = createJournalAgentKernel({
      ...factoryOptions({ journal, resolveModelSession: () => session }),
      captureTurnRuntime: () => currentRuntime,
    });
    const sessionId = `malformed-${_label.replaceAll(' ', '-')}`;
    const started = await kernel.start({
      projectId: 'project-1', sessionId,
      clientRequestId: `malformed-${_label.replaceAll(' ', '-')}`,
      input: 'Do not execute with malformed dependencies.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Interrupted' });
    expect(modelCalls).toBe(0);
    expect(releases).toBe(1);
    const interrupted = (await readAllRunEvents(journal, started.runId, sessionId))
      .find((event) => event.type === 'run.interrupted');
    expect(interrupted?.payload).toEqual({
      code: 'CAPABILITY_REVISION_UNAVAILABLE',
      detail: { reason: 'TURN_RUNTIME_INVALID' },
      resumeState: 'created',
    });

    if (_label === 'runtime protocol') {
      const recoveredCatalog = fixedBaselineRegistry().captureSnapshot();
      currentRuntime = {
        capability: { snapshotId: 'capability-recovered', revision: 'capability-recovered@1' },
        toolCatalog: recoveredCatalog,
        promptRevision: 'prompt-recovered@1',
        runtimeProtocol: promptSection('runtime-recovered@1', 'runtime'),
        promptSections: [],
        skills: [],
        release: () => {
          releases += 1;
          recoveredCatalog.release();
        },
      };
      await expect(kernel.resume({ runId: started.runId })).resolves.toMatchObject({ state: 'created' });
      await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
      expect(modelCalls).toBe(1);
      expect(releases).toBe(2);
    }
  });

  it('retains a captured Turn runtime while approval is pending and releases it after close', async () => {
    const journal = createJournal();
    let executions = 0;
    let releases = 0;
    const firstCatalog = writeCatalog(() => {
      executions += 1;
      return { written: true };
    }, 60_000).captureSnapshot();
    let runtimeGeneration = 0;
    const session = await authenticModelSession({
      modelId: 'approval-runtime-model',
      toolName: 'write_project_file',
    });
    const kernel = createJournalAgentKernel({
      ...factoryOptions({ journal, resolveModelSession: () => session }),
      captureTurnRuntime: () => {
        runtimeGeneration += 1;
        const catalog = runtimeGeneration === 1
          ? firstCatalog
          : fixedBaselineRegistry().captureSnapshot();
        return {
          capability: {
            snapshotId: `approval-capability-${runtimeGeneration}`,
            revision: `approval-r${runtimeGeneration}`,
          },
          toolCatalog: catalog,
          promptRevision: `approval-prompt-r${runtimeGeneration}`,
          runtimeProtocol: promptSection(
            `approval-runtime-r${runtimeGeneration}`,
            'approval runtime',
          ),
          promptSections: [],
          skills: [],
          release: () => {
            releases += 1;
            catalog.release();
          },
        };
      },
      mode: 'default',
    });
    const started = await kernel.start({
      projectId: 'project-1',
      sessionId: 'approval-runtime-session',
      clientRequestId: 'approval-runtime-request',
      input: 'Write only after approval.',
    });

    const waiting = await kernel.advance(started.runId);
    expect(waiting).toMatchObject({ state: 'AwaitingUser', waitReason: 'approval' });
    expect(releases).toBe(0);
    expect(executions).toBe(0);
    const [approval] = await kernel.pending(started.runId);
    if (approval?.kind !== 'approval') throw new Error('Expected a pending Tool approval.');
    await kernel.approve({
      runId: started.runId,
      approvalId: approval.requestId,
      decision: 'approve',
    });
    const approvalEvents = await journal.countEvents('tool.authorized', 'project-1');
    await expect(kernel.approve({
      runId: started.runId,
      approvalId: approval.requestId,
      decision: 'approve',
    })).resolves.toMatchObject({ state: 'ExecutingTools' });
    expect(await journal.countEvents('tool.authorized', 'project-1')).toBe(approvalEvents);
    await expect(kernel.approve({
      runId: started.runId,
      approvalId: approval.requestId,
      decision: 'deny',
    })).rejects.toMatchObject({ code: 'APPROVAL_DECISION_CONFLICT' });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    expect(executions).toBe(1);
    expect(releases).toBe(1);
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(releases).toBe(2);
  });

  it('rejects maxCostMicrounits when no durable cost meter is configured', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({ modelId: 'cost-model' });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal, resolveModelSession: () => session,
    }));
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'cost-session',
      clientRequestId: 'cost-request', input: 'Do not silently ignore cost limits.',
    });

    await expect(kernel.advance(started.runId, {
      limits: { maxCostMicrounits: 1 },
    })).rejects.toThrow(/cost meter/iu);
    expect((await kernel.open(started.runId)).state).toBe('created');
  });

  it('persists a queued manual compaction and consumes it at the next Preparing boundary', async () => {
    const journal = createJournal();
    let modelCalls = 0;
    let verificationCalls = 0;
    const session = await authenticModelSession({
      modelId: 'manual-compaction-model',
      onExecute: () => { modelCalls += 1; },
    });
    const kernel = createJournalAgentKernel(factoryOptions({
      journal,
      resolveModelSession: () => session,
      verifier: {
        verifierId: 'manual-compaction-verifier',
        revision: 'v1',
        mode: 'required',
        verify: () => {
          verificationCalls += 1;
          return verificationCalls === 1
            ? { status: 'revise', observation: 'continue after the queued compaction' }
            : { status: 'accepted' };
        },
      },
    }));
    const run = await captureRun(
      journal,
      session,
      'manual-compaction',
      undefined,
      [{ id: 'manual-compaction-verifier', revision: 'v1', required: true }],
    );
    const preparing = await journal.getKernelRunProjection({
      projectId: 'project-1', sessionId: run.sessionId, runId: run.runId,
    });
    if (preparing === null || preparing.currentTurnId === null) {
      throw new Error('Expected a captured manual-compaction Turn.');
    }
    const controller = new RunController({
      journal, projectId: 'project-1', sessionId: run.sessionId, runId: run.runId,
      ownerId: 'manual-compaction-preparer', leaseTtlMs: 60_000,
    });
    await controller.acquire();
    const turn = await journal.getTurnLifecycle({
      projectId: 'project-1', sessionId: run.sessionId, runId: run.runId,
      turnId: preparing.currentTurnId,
    });
    if (turn === null) throw new Error('Expected a manual-compaction Turn lifecycle.');
    await controller.commitContextReady({
      commandId: 'manual-compaction-context-ready',
      expectedRunRevision: preparing.revision,
      turnId: preparing.currentTurnId,
      expectedTurnRevision: turn.revision,
    });
    await controller.release();

    await expect(kernel.requestManualCompaction({ runId: run.runId }))
      .resolves.toMatchObject({ state: 'CallingModel' });
    expect(await journal.getPendingContextCompaction({
      projectId: 'project-1', sessionId: run.sessionId, runId: run.runId,
    })).not.toBeNull();
    await expect(kernel.advance(run.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(kernel.advance(run.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(await journal.getPendingContextCompaction({
      projectId: 'project-1', sessionId: run.sessionId, runId: run.runId,
    })).toBeNull();
    const events = await readAllRunEvents(journal, run.runId, run.sessionId);
    expect(events.filter((event) => event.type === 'context.compaction_requested')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'context.compaction_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'context.compacted')).toHaveLength(1);
    expect(modelCalls).toBe(3);
  });

  it('atomically closes an outcome-unknown Turn and exposes an invocation-bound decision', async () => {
    const journal = createJournal();
    const catalog = unknownOutcomeCatalog();
    const session = await authenticModelSession({
      modelId: 'outcome-resolution-model',
      toolName: 'publish_external_change',
    });
    const kernel = createJournalAgentKernel({
      ...factoryOptions({
        journal,
        resolveModelSession: () => session,
        toolCatalog: catalog.captureSnapshot(),
      }),
      mode: 'full-access',
    });
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'outcome-resolution-session',
      clientRequestId: 'outcome-resolution-request', input: 'Publish the external change.',
    });

    const waiting = await kernel.advance(started.runId);
    expect(waiting).toMatchObject({
      state: 'AwaitingUser', waitReason: 'outcome_resolution',
    });
    const events = await readAllRunEvents(
      journal, started.runId, 'outcome-resolution-session',
    );
    const unknown = events.find((event) => event.type === 'tool.unknown');
    if (unknown?.invocationId === undefined) throw new Error('Expected an unknown outcome.');
    const activities = new UserActivityProjector().project(events, {
      projectId: 'project-1', sessionId: 'outcome-resolution-session',
      afterSequence: 0, limit: 1_000,
    });
    expect(activities.items.find((activity) =>
      activity.kind === 'result' && activity.phase === 'waiting')).toMatchObject({
      detail: { invocationId: unknown.invocationId },
    });
    const requestedIndex = events.findIndex((event) =>
      event.type === 'tool.outcome_resolution_requested' &&
      event.invocationId === unknown.invocationId);
    const closedIndex = events.findIndex((event) =>
      event.type === 'turn.closed' && event.payload.reason === 'blocked_by_outcome');
    const inputIndex = events.findIndex((event) =>
      event.type === 'run.input_requested' && event.payload.reason === 'outcome_resolution');
    expect(requestedIndex).toBeGreaterThan(-1);
    expect(closedIndex).toBeGreaterThan(requestedIndex);
    expect(inputIndex).toBeGreaterThan(closedIndex);
    const pending = await kernel.pending(started.runId);
    expect(pending).toHaveLength(1);
    const pendingResolution = pending[0];
    if (pendingResolution?.kind !== 'outcome-resolution') {
      throw new Error('Expected one pending outcome-resolution request.');
    }
    expect(pendingResolution.requestId).toBe(`outcome:${unknown.invocationId}`);
    expect(pendingResolution.invocationId).toBe(unknown.invocationId);
    expect(typeof pendingResolution.summary).toBe('string');

    const outcomeKernel = kernel as typeof kernel & {
      resolveOutcome(input: Readonly<{
        runId: string;
        invocationId: string;
        outcome: 'succeeded' | 'failed';
        summary: string;
      }>): Promise<unknown>;
    };
    expect(typeof outcomeKernel.resolveOutcome).toBe('function');
    const decision = {
      runId: started.runId,
      invocationId: unknown.invocationId,
      outcome: 'succeeded',
      summary: 'The external system confirms that the change succeeded.',
    } as const;
    await expect(outcomeKernel.resolveOutcome(decision))
      .resolves.toMatchObject({ state: 'Preparing', waitReason: null });
    const resolvedEvents = await journal.countEvents('tool.outcome_resolved', 'project-1');
    await expect(outcomeKernel.resolveOutcome(decision))
      .resolves.toMatchObject({ state: 'Preparing', waitReason: null });
    expect(await journal.countEvents('tool.outcome_resolved', 'project-1')).toBe(resolvedEvents);
    await expect(outcomeKernel.resolveOutcome({
      ...decision,
      outcome: 'failed',
    })).rejects.toMatchObject({ code: 'OUTCOME_RESOLUTION_CONFLICT' });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect((await readAllRunEvents(
      journal, started.runId, 'outcome-resolution-session',
    )).filter((event) => event.type === 'tool.outcome_resolved')).toHaveLength(1);
  });

  it('settles an unknown outcome and authorizes one exact risky retry as one public choice', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'risky-retry-model', toolName: 'publish_external_change',
    });
    const kernel = createJournalAgentKernel({
      ...factoryOptions({
        journal,
        resolveModelSession: () => session,
        toolCatalog: unknownOutcomeCatalog().captureSnapshot(),
      }),
      mode: 'full-access',
    });
    const started = await kernel.start({
      projectId: 'project-1', sessionId: 'risky-retry-session',
      clientRequestId: 'risky-retry-run', input: 'Publish the external change.',
    });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({
      state: 'AwaitingUser', waitReason: 'outcome_resolution',
    });
    const unknown = (await readAllRunEvents(journal, started.runId, 'risky-retry-session'))
      .find((event) => event.type === 'tool.unknown');
    if (unknown?.invocationId === undefined) throw new Error('Expected an unknown outcome.');
    const retryAuthorization = {
      runId: started.runId,
      invocationId: unknown.invocationId,
      reason: 'The user accepts the duplicate-effect risk.',
      clientRequestId: 'authorize-retry-request',
    };

    await expect(kernel.authorizeRiskyRetry(retryAuthorization)).resolves.toMatchObject({
      state: 'Preparing', waitReason: null,
    });
    const retryEvents = await journal.countEvents('tool.retry_authorized', 'project-1');
    const resolutionEvents = await journal.countEvents('tool.outcome_resolved', 'project-1');
    await expect(kernel.authorizeRiskyRetry(retryAuthorization)).resolves.toMatchObject({
      state: 'Preparing', waitReason: null,
    });
    expect(await journal.countEvents('tool.retry_authorized', 'project-1')).toBe(retryEvents);
    expect(await journal.countEvents('tool.outcome_resolved', 'project-1')).toBe(resolutionEvents);
    await expect(kernel.authorizeRiskyRetry({
      ...retryAuthorization,
      reason: 'A conflicting authorization reason.',
    })).rejects.toMatchObject({ code: 'RISKY_RETRY_AUTHORIZATION_CONFLICT' });
    const invocation = await journal.getInvocation(unknown.invocationId);
    expect(invocation).toMatchObject({
      outcomeResolution: { outcome: 'failed' },
      retryPermit: { reason: retryAuthorization.reason },
    });
  });
});

type Resolver = Parameters<typeof createJournalAgentKernel>[0]['resolveModelSession'];

type FactoryOverrides = Readonly<{
  journal: SqliteAgentJournal;
  resolveModelSession: Resolver;
  toolCatalog?: ToolCatalogSnapshot;
  resolveToolCatalogSnapshot?: Parameters<typeof createJournalAgentKernel>[0]['resolveToolCatalogSnapshot'];
  verifier?: Parameters<typeof createJournalAgentKernel>[0]['verifier'];
  leaseTtlMs?: number;
  ownerId?: string;
  runtimeCommandExecutor?: Parameters<typeof createJournalAgentKernel>[0]['runtimeCommandExecutor'];
}>;

function factoryOptions(overrides: FactoryOverrides): Parameters<typeof createJournalAgentKernel>[0] {
  return {
    journal: overrides.journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: overrides.resolveModelSession,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: overrides.toolCatalog ?? fixedBaselineRegistry().captureSnapshot(),
    ...(overrides.resolveToolCatalogSnapshot === undefined
      ? {}
      : { resolveToolCatalogSnapshot: overrides.resolveToolCatalogSnapshot }),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 8,
      content: [{ type: 'text', text: 'Use the exact captured runtime capabilities.' }],
    },
    capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
    promptRevision: 'prompt-r1', settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    revalidateToolTarget: () => undefined,
    ownerId: overrides.ownerId ?? 'factory-recovery-owner',
    ...(overrides.verifier === undefined ? {} : { verifier: overrides.verifier }),
    ...(overrides.leaseTtlMs === undefined ? {} : { leaseTtlMs: overrides.leaseTtlMs }),
    ...(overrides.runtimeCommandExecutor === undefined
      ? {}
      : { runtimeCommandExecutor: overrides.runtimeCommandExecutor }),
};
}

function promptSection(revision: string, text: string) {
  return {
    id: 'runtime-protocol', source: 'runtime' as const, scope: 'static' as const, priority: 0,
    revision, cacheability: 'stable' as const, tokenEstimate: 8,
    content: [{ type: 'text' as const, text }],
  };
}

async function captureRun(
  journal: SqliteAgentJournal,
  session: ModelSession,
  suffix: string,
  toolCatalog = fixedBaselineRegistry().captureSnapshot(),
  verifiers: readonly Readonly<{ id: string; revision: string; required: boolean }>[] = [],
): Promise<Readonly<{ runId: string; sessionId: string }>> {
  const sessionId = `session-${suffix}`;
  const binding = await new SessionModelBindingStore(journal).bind({
    projectId: 'project-1', sessionId, commandId: `bind-${suffix}`,
    expectedRevision: 0, session,
  });
  const created = await journal.createRun({
    projectId: 'project-1', sessionId, clientRequestId: `request-${suffix}`,
    input: `continue ${suffix}`,
  });
  const controller = new RunController({
    journal, projectId: 'project-1', sessionId, runId: created.runId,
    ownerId: 'factory-recovery-owner', leaseTtlMs: 60_000,
  });
  await controller.acquire();
  const tools = toolCatalog.llmTools().map((tool) => ({
    name: tool.name,
    revision: requiredToolRevision(toolCatalog, tool.name),
  }));
  await controller.captureTurn({
    commandId: `capture-${suffix}`, expectedRunRevision: 1, turnId: `turn-${suffix}`,
    environment: {
      environmentBindingId: `environment_${binding.model.bindingDigest}`,
      settingsRevision: 'settings-r1', permissionPolicyRevision: 'permission-r1',
      modelSession: binding.model.descriptor,
    },
    snapshot: {
      turnSnapshotId: `snapshot-${suffix}`,
      capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
      promptRevision: 'prompt-r1', tools, skills: [], verifiers,
    },
  });
  await controller.release();
  return { runId: created.runId, sessionId };
}

type TestModelOptions = Readonly<{
  modelId: string;
  delayMs?: number;
  onExecute?: (request: ModelClientRequest) => void;
  toolName?: string;
}>;

async function authenticModelSession(options: TestModelOptions): Promise<ModelSession> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'factory-recovery-model-'));
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
    endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: `config-${options.modelId}`,
    credentialRevision: `credential-${options.modelId}`,
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing test connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSession({
    connectionId: connection.id,
    modelId: options.modelId,
  }, { generation: { temperature: 0 } });
}

function modelClient(options: TestModelOptions): ModelClient {
  let calls = 0;
  return {
    execute: async (request) => {
      calls += 1;
      options.onExecute?.(request);
      if (options.delayMs !== undefined) await abortableDelay(options.delayMs, request.signal);
      if (options.toolName !== undefined && calls === 1) {
        return {
          kind: 'json',
          response: {
            id: `response-${options.modelId}`, model: options.modelId, status: 'completed',
            output: [{
              id: 'tool-call-1', type: 'function_call', call_id: 'call-1',
              name: options.toolName, arguments: '{}',
            }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        };
      }
      return {
        kind: 'json',
        response: {
          id: `response-${options.modelId}`, model: options.modelId, status: 'completed',
          output: [{
            id: 'message-1', type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'completed' }],
          }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      };
    },
  };
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'factory-provider', name: 'factory-provider', mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'provider', toolCalls: [] }),
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
      id: `factory-${modelId}`, name: 'factory-provider', version: '1.0.0',
      protocol: 'openai-responses', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function invocationCatalog(handlerRevision: string): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const contribution = invocationContribution('inspect_project', { ok: true }, { handlerRevision, exposure: 'direct' });
  registry.registerInvocation({ ...contribution.definition, description: handlerRevision, permission: { actions: ['read'] } }, { ...contribution.runtime, prepare: prepareFixtureIntent });
  return registry;
}

function writeCatalog(execute: () => unknown, timeoutMs = 1_000): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const contribution = invocationContribution('write_project_file', {}, { handlerRevision: 'write-project-r1', exposure: 'direct', access: 'write', recoveryClass: 'idempotent' });
  registry.registerInvocation({
    ...contribution.definition,
    description: 'write project fixture',
    permission: { actions: ['write'], externalWrite: true },
    limits: { ...contribution.definition.limits, timeoutMs },
    execution: { ...contribution.definition.execution, timeoutMs },
  }, { ...contribution.runtime, prepare: prepareFixtureIntent, execute });
  return registry;
}

function unknownOutcomeCatalog(): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const contribution = invocationContribution('publish_external_change', {}, { handlerRevision: 'publish-external-change-r1', exposure: 'direct', access: 'external', recoveryClass: 'non_idempotent' });
  registry.registerInvocation({ ...contribution.definition, description: 'publish an external change', dangerLevel: 'high', readonly: false, permission: { actions: ['execute'] } }, {
    ...contribution.runtime, prepare: prepareFixtureIntent,
    execute: () => { throw new Error('external acknowledgement was lost'); },
  });
  return registry;
}

function childCommandCatalog(): ToolRegistry {
  const registry = fixedBaselineRegistry();
  const contribution = invocationContribution('subagent_spawn', {}, { handlerRevision: 'subagent-spawn-r1', exposure: 'direct', access: 'write', recoveryClass: 'idempotent' });
  registry.registerInvocation({ ...contribution.definition, description: 'start a child Run fixture', permission: { actions: ['read'] }, execution: { concurrency: 'write', timeoutMs: 1_000 } }, {
    ...contribution.runtime, prepare: prepareFixtureIntent,
    execute: () => createRuntimeCommandToolResult({
      command: {
        kind: 'child.start',
        payload: { task: 'Inspect the exact project snapshot.', context: { source: 'kernel-test' } },
      },
      result: { state: 'scheduled' },
    }),
  });
  return registry;
}

function requiredToolRevision(snapshot: ToolCatalogSnapshot, name: string): string {
  const revision = snapshot.invocationRevision(name) ?? snapshot.get(name)?.descriptor.toolRevision;
  if (revision === undefined) throw new Error(`Missing Tool revision: ${name}`);
  return revision;
}

const prepareFixtureIntent: ToolInvocationHandlerRuntime['prepare'] = (input, context) => ({
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
    actions: context.descriptor.permission?.actions ?? [], paths: context.descriptor.permission?.paths ?? [],
    hosts: context.descriptor.permission?.hosts ?? [], network: context.descriptor.permission?.network ?? false,
    externalWrite: context.descriptor.permission?.externalWrite ?? false,
    destructive: context.descriptor.permission?.destructive ?? false,
    credentials: context.descriptor.permission?.credentials ?? false,
    admin: context.descriptor.permission?.admin ?? false, unknownRisk: false,
    resolvedAddresses: [], targets: [],
  },
  access: context.descriptor.access, recoveryClass: context.descriptor.recoveryClass,
  concurrency: context.descriptor.execution.concurrency,
  resourceKeys: [`fixture:${context.descriptor.flatName}`],
  limits: context.limits,
});

function createJournal(): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), 'agent-kernel-factory-recovery-'));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}

class RenewalFailingJournal extends SqliteAgentJournal {
  #failRenewal = false;

  armRenewalFailure(): void {
    this.#failRenewal = true;
  }

  disarmRenewalFailure(): void {
    this.#failRenewal = false;
  }

  override renewRunLease(input: Parameters<SqliteAgentJournal['renewRunLease']>[0]) {
    if (this.#failRenewal) {
      return Promise.reject(new Error('forced lease renewal failure'));
    }
    return super.renewRunLease(input);
  }
}

function createRenewalFailingJournal(): RenewalFailingJournal {
  const root = mkdtempSync(join(tmpdir(), 'agent-kernel-lease-loss-'));
  roots.push(root);
  return new RenewalFailingJournal({ filePath: join(root, 'journal.db') });
}

async function readAllRunEvents(
  journal: SqliteAgentJournal,
  runId: string,
  sessionId: string,
) {
  const events = [];
  let afterSequence = 0;
  while (true) {
    const page = await journal.readRunEvents({
      projectId: 'project-1', sessionId, runId, afterSequence, limit: 100,
    });
    events.push(...page.events);
    if (page.events.length < 100 || page.nextSequence === null) return events;
    afterSequence = page.nextSequence;
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Model request aborted.');
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
