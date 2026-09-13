import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  LlmConnectionManager,
  ModelClientError,
  ModelExecutionGateway,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelSession,
  type ModelSessionBundle,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { AgentJournalError } from '../src/events/agent-journal.js';
import type { RunEventCommitter } from '../src/events/run-event-committer.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import {
  ModelTurnCoordinator,
  type ModelTurnGateway,
  type ModelTurnLifecycleFact,
} from '../src/kernel/model-turn-coordinator.js';
import { PermissionManager } from '../src/permission-manager.js';
import { UserActivityProjector } from '../src/session/session-projection.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Model lifecycle Journal', () => {
  it('persists batched deltas and completed blocks before projecting a safe user preview', async () => {
    const fixture = await runProductionKernel(
      new ScriptedClient([successfulStream('visible answer', usage(11, 3))]),
      ['attempt-visible'],
      'visible',
    );
    const events = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);

    const diagnostics = events.filter(({ type }) =>
      type === 'model_delta_batch' || type === 'model_block_completed');
    expect(diagnostics.map(({ type }) => type)).toEqual([
      'model_delta_batch',
      'model_block_completed',
    ]);
    expect(diagnostics.map(({ payload }) => payload)).toEqual([
      { blocks: [{ type: 'text', text: 'visible answer' }] },
      { block: { type: 'text', text: 'visible answer' } },
    ]);
    const usageEvents = events.filter(({ type }) => type === 'usage.recorded');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.payload).toMatchObject({ billingMode: 'byok' });
    expect(usageEvents[0]!.sequence).toBeLessThan(
      events.find(({ type }) => type === 'model_attempt_committed')!.sequence,
    );
    for (const event of [...diagnostics, ...usageEvents]) {
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(event.occurredAt).not.toContain('1000');
    }

    const database = new DatabaseSync(fixture.journal.filePath, { readOnly: true });
    try {
      const receipts = database.prepare(
        `SELECT command_kind, result_json FROM agent_commands
         WHERE command_kind LIKE 'model-lifecycle.%' ORDER BY command_kind`,
      ).all() as Array<{ command_kind: string; result_json: string }>;
      expect(receipts.map(({ command_kind }) => command_kind)).toEqual([
        'model-lifecycle.block-completed',
        'model-lifecycle.model-delta-batch',
        'model-lifecycle.usage-observed',
      ]);
      for (const { result_json: resultJson } of receipts) {
        expect(resultJson).not.toMatch(/visible answer|inputTokens|outputTokens|totalTokens/u);
        expect(Object.keys(JSON.parse(resultJson) as object).sort()).toEqual([
          'attemptId', 'commandId', 'eventIds', 'eventSequences', 'factType', 'projectId',
          'receiptType', 'runId', 'runRevision', 'schemaVersion', 'sessionId', 'turnId',
        ].sort());
      }
    } finally {
      database.close();
    }

    const projected = new UserActivityProjector().project(
      await readAllProjectEvents(fixture.journal, fixture.projectId), {
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      afterSequence: 0,
      limit: 100,
      },
    );
    expect(projected.items).toContainEqual(expect.objectContaining({
      kind: 'model-preview',
      phase: 'progress',
      replaceKey: 'attempt-visible',
      summary: 'visible answer',
    }));
    expect(JSON.stringify(projected)).not.toMatch(
      /protocolEnvelope|provider-opaque|encrypted_content|raw chain-of-thought/i,
    );

    const eventCountAtSettlement = events.length;
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId))
      .toHaveLength(eventCountAtSettlement);
  });

  it('persists failed and successful retry usage once per attempt and replays it exactly', async () => {
    const client = new ScriptedClient([
      stream(async function* () {
        yield await Promise.resolve({ choices: [{ delta: { content: 'discard me' } }] });
        yield await Promise.resolve({ choices: [], usage: usage(5, 2) });
        throw new ModelClientError('STREAM_DISCONNECTED', 'cut', { retryable: true });
      }),
      successfulStream('retry answer', usage(7, 3)),
    ]);
    const fixture = await runProductionKernel(client, ['attempt-failed', 'attempt-retry'], 'retry');
    const before = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);
    const lifecycleTypes = new Set([
      'model_attempt_started',
      'model_delta_batch',
      'model_block_completed',
      'model_failed',
      'model_attempt_discarded',
      'model_attempt_committed',
    ]);
    expect.soft(before.filter(({ type }) => lifecycleTypes.has(type)).map((event) =>
      `${event.attemptId ?? 'none'}:${event.type}`)).toEqual([
      'attempt-failed:model_attempt_started',
      'attempt-failed:model_delta_batch',
      'attempt-failed:model_failed',
      'attempt-failed:model_attempt_discarded',
      'attempt-retry:model_attempt_started',
      'attempt-retry:model_delta_batch',
      'attempt-retry:model_block_completed',
      'attempt-retry:model_attempt_committed',
    ]);

    const usageBefore = await fixture.journal.getRunUsage({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    expect(usageBefore.records).toEqual([
      expect.objectContaining({
        scope: 'attempt', purpose: 'agent-turn', attemptId: 'attempt-failed',
        billingMode: 'byok', inputTokens: 5, outputTokens: 2, totalTokens: 7,
      }),
      expect.objectContaining({
        scope: 'attempt', purpose: 'agent-turn', attemptId: 'attempt-retry',
        inputTokens: 7, outputTokens: 3, totalTokens: 10,
      }),
    ]);
    expect(new Set(usageBefore.records.map(({ usageId }) => usageId)).size).toBe(2);
    expect(await fixture.journal.getProjectUsageTotals(fixture.projectId)).toMatchObject([{
      billingMode: 'byok', inputTokens: 12, outputTokens: 5, totalTokens: 17,
    }]);

    await fixture.journal.rebuildProjectProjections(fixture.projectId);
    expect(await fixture.journal.getRunUsage({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    })).toEqual(usageBefore);
    expect(await fixture.journal.getProjectUsageTotals(fixture.projectId)).toMatchObject([{
      billingMode: 'byok', inputTokens: 12, outputTokens: 5, totalTokens: 17,
    }]);
    expect(await fixture.journal.countEvents('usage.recorded', fixture.projectId)).toBe(2);
  });

  it('persists the resolved managed billing mode in the durable fact and project total', async () => {
    const fixture = await runProductionSession(
      await authenticModelSession(new ScriptedClient([successfulStream('managed', usage(4, 2))]), 'managed'),
      ['attempt-managed'],
      'managed',
      false,
      'Completed',
      'managed',
    );
    const records = await fixture.journal.getRunUsage({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    expect(records.records).toEqual([expect.objectContaining({ billingMode: 'managed' })]);
    expect(await fixture.journal.getProjectUsageTotals(fixture.projectId)).toMatchObject([{
      billingMode: 'managed', inputTokens: 4, outputTokens: 2, totalTokens: 6,
    }]);
  });

  it('persists fallback usage under each provider attempt identity instead of folding it into success', async () => {
    const primary = new ScriptedClient([
      failedStream('primary first partial', usage(3, 1)),
      failedStream('primary retry partial', usage(4, 1)),
    ]);
    const fallback = new ScriptedClient([
      successfulStream('fallback answer', usage(8, 2)),
    ]);
    const bundle = await authenticModelSessionBundle(primary, fallback, 'fallback');
    const fixture = await runProductionSession(
      bundle,
      ['attempt-primary', 'attempt-primary-retry', 'attempt-fallback'],
      'fallback',
    );
    const events = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);
    const failureFacts = events.filter(({ type }) =>
      type === 'model_failed' || type === 'model_attempt_discarded');
    expect.soft(failureFacts.map(({ attemptId, type }) => `${attemptId}:${type}`)).toEqual([
      'attempt-primary:model_failed',
      'attempt-primary:model_attempt_discarded',
      'attempt-primary-retry:model_failed',
      'attempt-primary-retry:model_attempt_discarded',
    ]);

    const online = await fixture.journal.getRunUsage({
      projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
    });
    expect(online.records.map((record) => ({
      attemptId: record.attemptId,
      purpose: record.purpose,
      usageId: record.usageId,
      tokens: [record.inputTokens, record.outputTokens, record.totalTokens],
    }))).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-primary', purpose: 'agent-turn', tokens: [3, 1, 4],
      }),
      expect.objectContaining({
        attemptId: 'attempt-primary-retry', purpose: 'agent-turn', tokens: [4, 1, 5],
      }),
      expect.objectContaining({
        attemptId: 'attempt-fallback', purpose: 'agent-turn', tokens: [8, 2, 10],
      }),
    ]);
    expect(new Set(online.records.map(({ usageId }) => usageId)).size).toBe(3);

    await fixture.journal.rebuildProjectProjections(fixture.projectId);
    expect(await fixture.journal.getRunUsage({
      projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
    })).toEqual(online);
  });

  it('keeps context-compaction and agent-turn usage distinct and replay-exact', async () => {
    const session = await authenticModelSession(new ScriptedClient([
      successfulStream('bounded committed summary', usage(13, 4)),
      successfulStream('answer after compaction', usage(9, 3)),
    ]), 'compaction');
    const fixture = await runProductionSession(
      session,
      ['attempt-compaction', 'attempt-after-compaction'],
      'compaction',
      true,
    );
    const online = await fixture.journal.getRunUsage({
      projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
    });

    expect(online.records).toHaveLength(2);
    expect(online.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'attempt', purpose: 'context-compaction', attemptId: 'attempt-compaction',
        inputTokens: 13, outputTokens: 4, totalTokens: 17,
      }),
      expect.objectContaining({
        scope: 'attempt', purpose: 'agent-turn', attemptId: 'attempt-after-compaction',
        inputTokens: 9, outputTokens: 3, totalTokens: 12,
      }),
    ]));
    expect(new Set(online.records.map(({ usageId }) => usageId)).size).toBe(2);

    await fixture.journal.rebuildProjectProjections(fixture.projectId);
    expect(await fixture.journal.getRunUsage({
      projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
    })).toEqual(online);
  });

  it('journals every context-compaction retry and fallback usage through the production Kernel', async () => {
    const primary = new ScriptedClient([
      failedStream('discarded compaction primary', usage(5, 1)),
      failedStream('discarded compaction retry', usage(6, 2)),
      successfulStream('answer after fallback compaction', usage(9, 3)),
    ]);
    const fallback = new ScriptedClient([
      successfulStream('bounded summary from fallback', usage(11, 4)),
    ]);
    const fixture = await runProductionSession(
      await authenticModelSessionBundle(primary, fallback, 'compaction-fallback'),
      [
        'attempt-compact-primary',
        'attempt-compact-retry',
        'attempt-compact-fallback',
        'attempt-agent-after-compact',
      ],
      'compaction-fallback',
      true,
    );
    const scope = {
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    };
    const online = await fixture.journal.getRunUsage(scope);

    expect(online.records).toHaveLength(4);
    expect(online).toMatchObject({
      inputTokens: 31,
      outputTokens: 10,
      totalTokens: 41,
    });
    expect(online.records.map((record) => ({
      attemptId: record.attemptId,
      purpose: record.purpose,
      tokens: [record.inputTokens, record.outputTokens, record.totalTokens],
    }))).toEqual(expect.arrayContaining([
      {
        attemptId: 'attempt-compact-primary',
        purpose: 'context-compaction',
        tokens: [5, 1, 6],
      },
      {
        attemptId: 'attempt-compact-retry',
        purpose: 'context-compaction',
        tokens: [6, 2, 8],
      },
      {
        attemptId: 'attempt-compact-fallback',
        purpose: 'context-compaction',
        tokens: [11, 4, 15],
      },
      {
        attemptId: 'attempt-agent-after-compact',
        purpose: 'agent-turn',
        tokens: [9, 3, 12],
      },
    ]));
    expect(await fixture.journal.countEvents('usage.recorded', fixture.projectId)).toBe(4);

    const completedCheckpoint = await fixture.journal.getLatestContextCheckpoint({
      ...scope,
      status: 'compacted',
    });
    expect(completedCheckpoint).toMatchObject({
      status: 'compacted',
      attemptId: 'attempt-compact-fallback',
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });

    const reopened = new SqliteAgentJournal({ filePath: fixture.journal.filePath });
    expect(await reopened.getRunUsage(scope)).toEqual(online);
    await reopened.rebuildProjectProjections(fixture.projectId);
    expect(await reopened.getRunUsage(scope)).toEqual(online);
    expect(await reopened.countEvents('usage.recorded', fixture.projectId)).toBe(4);
  });

  it('retains provider-native blocks in audit truth without leaking them to the user projection', async () => {
    const privateReasoning = 'PRIVATE_PROVIDER_COT_SENTINEL';
    const fixture = await runProductionKernel(new ScriptedClient([{
      kind: 'json',
      response: {
        id: 'opaque-response',
        choices: [{
          message: {
            content: [
              { type: 'text', text: 'safe final ' },
              { type: 'vendor_reasoning', private_reasoning: privateReasoning },
              { type: 'text', text: 'answer' },
            ],
          },
          finish_reason: 'stop',
        }],
        usage: usage(6, 2),
      },
    }]), ['attempt-opaque'], 'opaque');
    const events = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);
    expect(JSON.stringify(events)).toContain(privateReasoning);
    expect.soft(events.filter(({ type }) => type === 'model_block_completed')).toHaveLength(3);

    const projected = new UserActivityProjector().project(
      await readAllProjectEvents(fixture.journal, fixture.projectId), {
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      afterSequence: 0,
      limit: 100,
      },
    );
    const serialized = JSON.stringify(projected);
    expect(projected.items).toContainEqual(expect.objectContaining({
      kind: 'final',
      summary: 'safe final answer',
    }));
    expect(serialized).not.toContain(privateReasoning);
    expect(serialized).not.toMatch(/provider-opaque|protocolEnvelope|private_reasoning/i);
  });

  it('closes the batching observer when a Coordinator attempt exits without a terminal callback', async () => {
    vi.useFakeTimers();
    const facts: ModelTurnLifecycleFact[] = [];
    const gateway: ModelTurnGateway = {
      async executeAttempt(_session, _request, options) {
        await options.observer?.onEvent({
          type: 'decoded-delta', attemptId: 'attempt-interrupted', routeId: 'route-a',
          occurredAt: 1,
          event: { type: 'text-delta', blockOrdinal: 0, text: 'must not publish later' },
        });
        throw new Error('simulated owner interruption');
      },
    };
    const coordinator = new ModelTurnCoordinator({
      gateway,
      session: null as unknown as ModelSession,
      committer: {} as RunEventCommitter,
      resolveUsageBillingMode: () => 'byok',
      lifecycleSink: {
        publish(fact) {
          facts.push(fact);
          return Promise.resolve();
        },
      },
    });

    await expect(coordinator.execute({
      projectId: 'project-timer', sessionId: 'session-timer', runId: 'run-timer',
      turnId: 'turn-timer', commandId: 'command-timer',
      lease: { ownerId: 'owner-timer', fencingToken: 1 }, expectedTurnRevision: 1,
      prompt: {
        messages: [], tools: [], tokenEstimate: 0,
        request: { model: 'model-a', messages: [] },
      },
    })).rejects.toThrow('simulated owner interruption');
    const writesAtSettlement = facts.length;

    await vi.advanceTimersByTimeAsync(41);

    expect(facts).toHaveLength(writesAtSettlement);
  });

  it('persists only a bounded typed Model failure diagnostic and never a raw provider cause', async () => {
    const leaf = new AgentJournalError('PROJECTION_CORRUPT', 'durable lifecycle leaf');
    const fixture = await runProductionKernel(new ScriptedClient([
      stream(() => failingEvents(new ModelClientError(
        'TRANSPORT_ERROR', 'provider transport failed', {
          retryable: false,
          cause: leaf,
        },
      ))),
    ]), ['attempt-diagnostic'], 'diagnostic', 'Failed');
    const events = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);
    const failed = events.find(({ type }) => type === 'run.failed');
    expect(failed?.type).toBe('run.failed');
    if (failed?.type !== 'run.failed') throw new Error('Missing failed event.');
    expect(failed.payload.code).toBe('MODEL_TRANSPORT_FAILED');
    expect(failed.payload.detail).toEqual({
      category: 'model-gateway', code: 'MODEL_TRANSPORT_FAILED', retryable: false,
    });
    expect(JSON.stringify(failed.payload.detail)).not.toMatch(
      /TRANSPORT_ERROR|PROJECTION_CORRUPT|provider transport failed|durable lifecycle leaf/u,
    );

    const projected = new UserActivityProjector().project(
      await readAllProjectEvents(fixture.journal, fixture.projectId), {
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      afterSequence: 0,
      limit: 100,
      },
    );
    expect(projected.items).toContainEqual(expect.objectContaining({
      kind: 'status', phase: 'failed', summary: 'MODEL_TRANSPORT_FAILED',
    }));
    expect(JSON.stringify(projected)).not.toMatch(/causeChain|durable lifecycle leaf/u);
  });

  it('fails a non-retryable Model protocol error and closes its Turn atomically', async () => {
    const fixture = await runProductionKernel(new ScriptedClient([{
      kind: 'json',
      response: { id: 'malformed-response', choices: 'not-an-array' },
    }]), ['attempt-protocol-failure'], 'protocol-failure', 'Failed');
    const events = await readAllRunEvents(fixture.journal, fixture.runId, fixture.sessionId);
    const closed = events.find((event) => event.type === 'turn.closed');
    const failed = events.find((event) => event.type === 'run.failed');

    expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(0);
    expect(closed).toMatchObject({ type: 'turn.closed', payload: { reason: 'failed' } });
    expect(failed).toMatchObject({
      type: 'run.failed',
      payload: {
        code: 'MODEL_PROTOCOL_FAILED',
        detail: {
          category: 'model-gateway', code: 'MODEL_PROTOCOL_FAILED', retryable: false,
        },
      },
    });
    expect(closed!.sequence).toBeLessThan(failed!.sequence);
    await expect(fixture.journal.getTurnLifecycle({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      turnId: closed!.turnId!,
    })).resolves.toMatchObject({ status: 'closed' });
  });
});

class ScriptedClient implements ModelClient {
  calls = 0;

  constructor(private readonly scripts: readonly ModelClientResponse[]) {}

  execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    void request;
    const script = this.scripts[this.calls];
    this.calls += 1;
    if (script === undefined) return Promise.reject(new Error('Unexpected Model call.'));
    return Promise.resolve(script);
  }
}

async function* failingEvents(error: Error): AsyncGenerator<unknown> {
  yield* [];
  await Promise.resolve();
  throw error;
}

async function runProductionKernel(
  client: ModelClient,
  attemptIds: string[],
  label: string,
  expectedState: 'Completed' | 'Interrupted' | 'Failed' = 'Completed',
) {
  const session = await authenticModelSession(client, label);
  return await runProductionSession(session, attemptIds, label, false, expectedState);
}

async function runProductionSession(
  session: ModelSession | ModelSessionBundle,
  attemptIds: string[],
  label: string,
  manualCompaction = false,
  expectedState: 'Completed' | 'Interrupted' | 'Failed' = 'Completed',
  billingMode: 'byok' | 'managed' = 'byok',
) {
  const projectId = `project-${label}`;
  const sessionId = `session-${label}`;
  const journal = createJournal(label);
  const ids = [...attemptIds];
  let now = 1_000;
  const gateway = new ModelExecutionGateway({
    createAttemptId: () => ids.shift() ?? `unexpected-attempt-${ids.length}`,
    clock: {
      now: () => now++,
      sleep: () => Promise.resolve(),
    },
  });
  const kernel = createJournalAgentKernel({
    journal,
    gateway,
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => billingMode,
    toolCatalog: fixedBaselineRegistry().captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable',
      content: [{ type: 'text', text: 'Complete the user request.' }], tokenEstimate: 8,
    },
    capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
    promptRevision: 'prompt-r1', settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1', ownerId: `owner-${label}`,
  });
  const started = await kernel.start({
    projectId, sessionId, clientRequestId: `request-${label}`, input: 'Answer now.',
  });
  if (manualCompaction) {
    const limited = await kernel.advance(started.runId, { limits: { maxTurns: 1 } });
    expect(limited).toMatchObject({ state: 'LimitReached' });
    const resumed = await kernel.resume({ runId: started.runId, reason: 'test compaction boundary' });
    expect(resumed).toMatchObject({ state: 'Preparing' });
    await kernel.requestManualCompaction({ runId: started.runId });
  }
  const completed = await kernel.advance(started.runId);
  expect(completed).toMatchObject({ state: expectedState });
  return { journal, projectId, sessionId, runId: started.runId };
}

async function authenticModelSessionBundle(
  primaryClient: ModelClient,
  fallbackClient: ModelClient,
  label: string,
): Promise<ModelSessionBundle> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), `model-lifecycle-${label}-`));
  roots.push(cacheDirectory);
  const clients = new Map<string, ModelClient>([
    ['primary-test', primaryClient],
    ['fallback-test', fallbackClient],
  ]);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => {
    const client = clients.get(resolution.pluginId);
    if (client === undefined) return undefined;
    return {
      client,
      bindingEvidence: {
        connectionResolutionRevision: resolution.revision,
        connectionConfigurationRevision: connection.connectionConfigurationRevision,
        credentialRevision: connection.credentialRevision,
      },
    };
  };
  const manager = new LlmConnectionManager({
    cacheDirectory,
    plugins: [providerPlugin('primary-test', 100), providerPlugin('fallback-test', 90)],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: 'formal-fallback', endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1', credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing fallback test connection.');
  const discovery = await manager.discover(connection.id);
  const fallbackResolution = discovery.alternatives[0];
  if (fallbackResolution === undefined) throw new Error('Missing compatible fallback resolution.');
  const fallbackRouteId = [
    connection.id,
    'model-a',
    fallbackResolution.pluginId,
    fallbackResolution.revision,
  ].join(':');
  return await manager.prepareModelSessionBundle(
    { connectionId: connection.id, modelId: 'model-a' },
    { allowedFallbackRouteIds: [fallbackRouteId] },
  );
}

async function authenticModelSession(client: ModelClient, label: string): Promise<ModelSession> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), `model-lifecycle-${label}-`));
  roots.push(cacheDirectory);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client,
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory,
    plugins: [providerPlugin()],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: 'formal', endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1', credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing test connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSession({ connectionId: connection.id, modelId: 'model-a' }, {});
}

function providerPlugin(id = 'formal-test', score = 100): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'formal-provider', name: 'formal', mode: 'private', protocol: 'openai-chat',
    chat: () => Promise.resolve({ text: 'provider', toolCalls: [] }),
    listModels: () => Promise.resolve(['model-a']),
    getModelMetadata: (model) => Promise.resolve({
      model, source: 'provider-api', contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported', streaming: 'supported' },
      generationParameters: {},
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id, name: id, version: '1.0.0', protocol: 'openai-chat', priority: score,
    },
    match: () => ({ score, evidence: [] }),
    discover: () => Promise.resolve({ score, models: ['model-a'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function createJournal(label: string): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), `model-lifecycle-journal-${label}-`));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}

async function readAllRunEvents(
  journal: SqliteAgentJournal,
  runId: string,
  sessionId: string,
) {
  const events: Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'][number][] = [];
  let cursor = 0;
  while (true) {
    const page = await journal.readRunEvents({
      projectId: (await journal.getRunProjection(runId))!.projectId,
      sessionId,
      runId,
      afterSequence: cursor,
      limit: 100,
    });
    events.push(...page.events);
    if (page.nextSequence === null) return events;
    cursor = page.nextSequence;
  }
}

async function readAllProjectEvents(journal: SqliteAgentJournal, projectId: string) {
  const events: Awaited<ReturnType<SqliteAgentJournal['readProject']>> = [];
  let cursor = 0;
  while (true) {
    const page = await journal.readProject(projectId, cursor, 100);
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.sequence;
  }
}

function successfulStream(text: string, modelUsage: ReturnType<typeof usage>): ModelClientResponse {
  return stream(async function* () {
    yield await Promise.resolve({ choices: [{ delta: { content: text } }] });
    yield await Promise.resolve({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    yield await Promise.resolve({ choices: [], usage: modelUsage });
  });
}

function failedStream(text: string, modelUsage: ReturnType<typeof usage>): ModelClientResponse {
  return stream(async function* () {
    yield await Promise.resolve({ choices: [{ delta: { content: text } }] });
    yield await Promise.resolve({ choices: [], usage: modelUsage });
    throw new ModelClientError('STREAM_DISCONNECTED', 'cut', { retryable: true });
  });
}

function stream(factory: () => AsyncGenerator<unknown>): ModelClientResponse {
  return { kind: 'stream', events: factory() };
}

function usage(promptTokens: number, completionTokens: number) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
