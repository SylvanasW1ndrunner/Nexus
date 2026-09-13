import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { RunController, type KernelRunProjection } from '../src/kernel/run-controller.js';
import { PermissionManager } from '../src/permission-manager.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};
const PROJECT_ID = 'context-scale-project';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent Kernel context reserve and scale boundaries', () => {
  it('prefers session generation.maxOutputTokens over the larger route default', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'session-reserve-model',
      maxInputTokens: 1_500,
      routeMaxOutputTokens: 800,
      generationMaxOutputTokens: 100,
    });
    expect(session.route).toMatchObject({ maxInputTokens: 1_500, maxOutputTokens: 800 });
    expect(session.generation.maxOutputTokens).toBe(100);
    const gateway = new PurposeRecordingGateway();
    const kernel = createKernel({
      journal,
      session,
      gateway,
      runtimeTokenEstimate: 450,
    });
    const started = await kernel.start(startInput('session-reserve'));

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(gateway.purposes).toEqual(['agent-turn']);
    expect(await journal.countEvents('context.compaction_started', PROJECT_ID)).toBe(0);
  });

  it('falls back to route.maxOutputTokens and compacts before an agent-turn model call', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'route-reserve-model',
      maxInputTokens: 1_000,
      routeMaxOutputTokens: 300,
    });
    expect(session.generation.maxOutputTokens).toBeUndefined();
    const gateway = new PurposeRecordingGateway();
    const kernel = createKernel({
      journal,
      session,
      gateway,
      runtimeTokenEstimate: 450,
    });
    const started = await kernel.start(startInput('route-reserve'));

    await kernel.advance(started.runId);
    expect(gateway.purposes[0]).toBe('context-compaction');
    expect(gateway.purposes).not.toContain('agent-turn');
    expect(await journal.countEvents('context.compaction_started', PROJECT_ID)).toBe(1);
  });

  it('continues a production Run after more than 10,000 durable non-prompt events', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'large-journal-model',
      maxInputTokens: 32_000,
      routeMaxOutputTokens: 2_000,
      generationMaxOutputTokens: 1_000,
    });
    const gateway = new PurposeRecordingGateway();
    const kernel = createKernel({ journal, session, gateway, runtimeTokenEstimate: 8 });
    const started = await kernel.start(startInput('large-journal'));
    appendNonPromptEvents(journal, started, 10_050);
    expect(countRunEvents(journal, started)).toBeGreaterThan(10_000);

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(gateway.purposes).toEqual(['agent-turn']);
  });

  it('continues from a compacted checkpoint whose covered sequence is above 10,000', async () => {
    const journal = createJournal();
    const session = await authenticModelSession({
      modelId: 'large-checkpoint-model',
      maxInputTokens: 32_000,
      routeMaxOutputTokens: 2_000,
      generationMaxOutputTokens: 1_000,
    });
    const gateway = new PurposeRecordingGateway();
    const kernel = createKernel({ journal, session, gateway, runtimeTokenEstimate: 8 });
    const started = await kernel.start(startInput('large-checkpoint'));
    const preparing = await captureTurn({
      journal,
      run: started,
      session,
      ownerId: 'large-checkpoint-preparer',
    });
    appendNonPromptEvents(journal, preparing, 10_050);
    const coveredSequence = latestSequence(journal, preparing);
    expect(coveredSequence).toBeGreaterThan(10_000);
    const controller = controllerFor({
      journal,
      run: preparing,
      ownerId: 'large-checkpoint-committer',
    });
    await controller.acquire();
    const compacting = await controller.startContextCompaction({
      commandId: 'large-checkpoint-start',
      expectedRunRevision: preparing.revision,
      checkpointId: 'checkpoint-over-10000',
      decisionId: 'decision-over-10000',
      reason: 'automatic',
      coveredSequence,
    });
    const compacted = await controller.completeContextCompaction({
      commandId: 'large-checkpoint-complete',
      expectedRunRevision: compacting.run.revision,
      checkpointId: 'checkpoint-over-10000',
      decisionId: 'decision-over-10000',
      summaryRef: 'context:checkpoint-over-10000',
      summary: 'Keep the active request and continue from this durable checkpoint.',
      coveredSequence,
      attemptId: 'compaction-attempt-over-10000',
    });
    await controller.release();
    expect(compacted.run).toMatchObject({ state: 'Preparing' });
    expect((await journal.getLatestContextCheckpoint({
      projectId: preparing.projectId,
      sessionId: preparing.sessionId,
      runId: preparing.runId,
      status: 'compacted',
    }))?.coveredSequence).toBe(coveredSequence);

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(gateway.purposes).toEqual(['agent-turn']);
  });
});

type CreateKernelOptions = Readonly<{
  journal: SqliteAgentJournal;
  session: ModelSession;
  gateway: ModelExecutionGateway;
  runtimeTokenEstimate: number;
}>;

function createKernel(options: CreateKernelOptions) {
  return createJournalAgentKernel({
    journal: options.journal,
    gateway: options.gateway,
    resolveModelSession: () => options.session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: fixedBaselineRegistry().captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol',
      source: 'runtime',
      scope: 'static',
      priority: 0,
      revision: 'runtime-r1',
      cacheability: 'stable',
      tokenEstimate: options.runtimeTokenEstimate,
      content: [{ type: 'text', text: 'Use the captured runtime capabilities.' }],
    },
    capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    protocolReserveTokens: 10,
    ownerId: 'context-scale-owner',
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

async function captureTurn(input: Readonly<{
  journal: SqliteAgentJournal;
  run: KernelRunProjection;
  session: ModelSession;
  ownerId: string;
}>): Promise<KernelRunProjection> {
  const controller = controllerFor(input);
  await controller.acquire();
  const environment = await requiredEnvironment(input.journal, input.run);
  const captured = await controller.captureTurn({
    commandId: 'capture-large-checkpoint-turn',
    expectedRunRevision: input.run.revision,
    turnId: 'turn-large-checkpoint',
    environment: environment.payload,
    snapshot: {
      turnSnapshotId: 'snapshot-large-checkpoint',
      capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
      promptRevision: 'prompt-r1',
      tools: [],
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

function appendNonPromptEvents(
  journal: SqliteAgentJournal,
  run: KernelRunProjection,
  count: number,
): void {
  const database = new DatabaseSync(journal.filePath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const current = database.prepare(
      'SELECT current_sequence FROM agent_project_sequences WHERE project_id = ?',
    ).get(run.projectId) as { current_sequence: number } | undefined;
    if (current === undefined) throw new Error('Missing project sequence.');
    const insert = database.prepare(`
      INSERT INTO agent_events (
        project_id, sequence, event_id, schema_version, session_id, run_id,
        turn_id, parent_event_id, invocation_id, attempt_id, event_type,
        occurred_at, payload_json, audience_json, persistence
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, 'skill.activated', ?, ?, '[]', 'durable')
    `);
    let sequence = Number(current.current_sequence);
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      insert.run(
        run.projectId,
        sequence,
        `scale-event-${run.runId}-${index}`,
        run.sessionId,
        run.runId,
        '2026-01-01T00:00:00.000Z',
        JSON.stringify({ skillId: `scale-skill-${index}`, revision: 'r1' }),
      );
    }
    database.prepare(
      'UPDATE agent_project_sequences SET current_sequence = ? WHERE project_id = ?',
    ).run(sequence, run.projectId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function countRunEvents(journal: SqliteAgentJournal, run: KernelRunProjection): number {
  const database = new DatabaseSync(journal.filePath);
  try {
    const row = database.prepare(
      'SELECT COUNT(*) AS count FROM agent_events WHERE run_id = ?',
    ).get(run.runId) as { count: number };
    return Number(row.count);
  } finally {
    database.close();
  }
}

function latestSequence(journal: SqliteAgentJournal, run: KernelRunProjection): number {
  const database = new DatabaseSync(journal.filePath);
  try {
    const row = database.prepare(
      'SELECT MAX(sequence) AS sequence FROM agent_events WHERE run_id = ?',
    ).get(run.runId) as { sequence: number };
    return Number(row.sequence);
  } finally {
    database.close();
  }
}

class PurposeRecordingGateway extends ModelExecutionGateway {
  readonly purposes: string[] = [];

  override async executeAttempt(
    session: Parameters<ModelExecutionGateway['executeAttempt']>[0],
    request: Parameters<ModelExecutionGateway['executeAttempt']>[1],
    options: Parameters<ModelExecutionGateway['executeAttempt']>[2] = {},
  ): Promise<Awaited<ReturnType<ModelExecutionGateway['executeAttempt']>>> {
    this.purposes.push(options.purpose ?? 'agent-turn');
    return await super.executeAttempt(session, request, options);
  }
}

type SessionOptions = Readonly<{
  modelId: string;
  maxInputTokens: number;
  routeMaxOutputTokens: number;
  generationMaxOutputTokens?: number;
}>;

async function authenticModelSession(options: SessionOptions): Promise<ModelSession> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'context-scale-model-'));
  roots.push(cacheDirectory);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: modelClient(options.modelId),
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory,
    plugins: [providerPlugin(options)],
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
    generation: {
      temperature: 0,
      ...(options.generationMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.generationMaxOutputTokens }),
    },
  });
}

function modelClient(modelId: string): ModelClient {
  return {
    execute: () => Promise.resolve({
      kind: 'json',
      response: {
        id: `response-${modelId}`,
        model: modelId,
        status: 'completed',
        output: [{
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Durable compact summary or final answer.' }],
        }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    }),
  };
}

function providerPlugin(options: SessionOptions): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'context-scale-provider',
    name: 'context-scale-provider',
    mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'completed', toolCalls: [] }),
    listModels: () => Promise.resolve([options.modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      contextTokens: options.maxInputTokens + options.routeMaxOutputTokens,
      maxInputTokens: options.maxInputTokens,
      maxOutputTokens: options.routeMaxOutputTokens,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported', maxOutputTokens: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: `context-scale-${options.modelId}`,
      name: 'context-scale-provider',
      version: '1.0.0',
      protocol: 'openai-responses',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({
      score: 100,
      models: [options.modelId],
      evidence: [],
    }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function createJournal(): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), 'agent-context-scale-'));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}
