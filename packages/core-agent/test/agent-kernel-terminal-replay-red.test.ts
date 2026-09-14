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
  type ModelProtocol,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { PermissionManager } from '../src/permission-manager.js';
import { UserActivityProjector } from '../src/session/session-projection.js';
import type { ToolRegistry } from '../src/tool-registry.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Agent terminal delivery invariant', () => {
  it('completes stop plus non-empty text and resolves finalContentRef to that visible text', async () => {
    const fixture = await runOneResponse('valid-final', chatResponse('Delivered answer.', 'stop'));

    expect(fixture.run.state).toBe('Completed');
    const events = await readAllRunEvents(fixture);
    const completed = events.find((event) => event.type === 'run.completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'run.completed') throw new Error('Expected a completed Run.');
    expect(completed.payload.finalContentRef).toMatch(/^turn:[^:]+:content$/u);

    const projected = new UserActivityProjector().project(events, {
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      afterSequence: 0,
      limit: 1_000,
    });
    const final = projected.items.find((item) => item.kind === 'final');
    expect(final?.summary).toBe('Delivered answer.');
    expect(final?.summary.trim().length).toBeGreaterThan(0);
  });

  it.each([
    {
      label: 'provider-opaque-only',
      response: chatResponse([{
        type: 'future_native_part',
        id: 'opaque-item-id-sentinel',
        raw: 'opaque-raw-value-sentinel',
      }], 'stop'),
    },
    { label: 'empty-text', response: chatResponse([{ type: 'text', text: '' }], 'stop') },
    { label: 'no-blocks', response: chatResponse(null, 'stop') },
    { label: 'oversized-final-text', response: chatResponse('x'.repeat(65_537), 'stop') },
    {
      label: 'pure-tool-protocol-envelope',
      response: chatResponse(
        '<tool_calls><tool_call name="inspect_project">{"path":"."}</tool_call></tool_calls>',
        'stop',
      ),
    },
    { label: 'length', response: chatResponse('Partial but visible.', 'length') },
    { label: 'content-filter', response: chatResponse('Filtered but visible.', 'content_filter') },
    { label: 'error', response: chatResponse('Failed but visible.', 'error') },
    { label: 'unknown', response: chatResponse('Unknown terminal.', 'invented_reason') },
  ])('does not complete a terminal attempt with invalid delivery: $label', async ({ label, response }) => {
    const fixture = await runOneResponse(`invalid-${label}`, response);
    const events = await readAllRunEvents(fixture);

    expect(fixture.run.state).not.toBe('Completed');
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(0);
  });

  it('keeps embedded tool protocol text as user content and never executes it', async () => {
    const fixture = await runOneResponse(
      'embedded-tool-protocol-text',
      chatResponse(
        'The literal example <tool_calls>{"name":"inspect_project"}</tool_calls> is documentation.',
        'stop',
      ),
    );
    const events = await readAllRunEvents(fixture);

    expect(fixture.run.state).toBe('Completed');
    expect(events.filter((event) => event.type === 'tool.proposed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(0);
  });

  it('binds final delivery to the globally latest delivery-ready capability evidence instead of all Run history', async () => {
    let call = 0;
    const client: ModelClient = {
      execute: () => {
        call += 1;
        return Promise.resolve({
          kind: 'json',
          response: call === 1
            ? manyEvidenceToolCallsResponse(33)
            : chatResponse('The latest result contains value 32.', 'stop'),
        });
      },
    };
    const session = await authenticSession('bounded-final-evidence', 'openai-chat', client);
    const journal = createJournal('bounded-final-evidence');
    const kernel = productionKernel(journal, session, evidenceToolRegistry());
    const started = await kernel.start({
      projectId: 'project-bounded-final-evidence',
      sessionId: 'session-bounded-final-evidence',
      clientRequestId: 'request-bounded-final-evidence',
      input: 'Inspect every item, then deliver the latest result.',
    });

    let completed = await kernel.advance(started.runId);
    for (let iteration = 0; iteration < 3 && completed.state === 'Preparing'; iteration += 1) {
      completed = await kernel.advance(started.runId);
    }
    const events = await readAllRunEvents({
      journal,
      projectId: 'project-bounded-final-evidence',
      sessionId: 'session-bounded-final-evidence',
      runId: started.runId,
    });
    const terminal = events.find((event) => event.type === 'run.completed');

    expect(completed.state).toBe('Completed');
    expect(terminal?.type === 'run.completed' ? terminal.payload.evidenceRefs : []).toEqual([]);
  });

  it('checkpoints the production Run lease throughout a multi-tool batch', async () => {
    let call = 0;
    const client: ModelClient = {
      execute: () => {
        call += 1;
        return Promise.resolve({
          kind: 'json',
          response: call === 1
            ? manyEvidenceToolCallsResponse(5)
            : chatResponse('All long-batch results were observed.', 'stop'),
        });
      },
    };
    const session = await authenticSession('long-tool-batch-lease', 'openai-chat', client);
    const journal = createJournal('long-tool-batch-lease');
    const acquireRunLease = journal.acquireRunLease.bind(journal);
    const renewRunLease = journal.renewRunLease.bind(journal);
    let renewals = 0;
    let toolWindowRenewals = 0;
    const forceNearExpiry = <T extends { expiresAt: string }>(lease: T): T => ({
      ...lease,
      expiresAt: new Date(Date.now() + 1).toISOString(),
    });
    journal.acquireRunLease = async (input) =>
      forceNearExpiry(await acquireRunLease(input));
    journal.renewRunLease = async (input) => {
      renewals += 1;
      const lease = await renewRunLease(input);
      const invocations = await journal.listInvocations(input.runId);
      const toolWindowActive = invocations.some((invocation) =>
        invocation.state === 'prepared' || invocation.state === 'authorized' ||
        invocation.state === 'started');
      if (toolWindowActive) toolWindowRenewals += 1;
      return toolWindowRenewals >= 3 ? lease : forceNearExpiry(lease);
    };
    const kernel = productionKernel(journal, session, evidenceToolRegistry(), {
      leaseTtlMs: 60_000,
      maxToolConcurrency: 5,
    });
    const started = await kernel.start({
      projectId: 'project-long-tool-batch-lease',
      sessionId: 'session-long-tool-batch-lease',
      clientRequestId: 'request-long-tool-batch-lease',
      input: 'Inspect every item, then deliver the result.',
    });

    let completed = await kernel.advance(started.runId);
    for (let iteration = 0; iteration < 3 && completed.state === 'Preparing'; iteration += 1) {
      completed = await kernel.advance(started.runId);
    }
    const invocations = await journal.listInvocations(started.runId);

    expect(completed.state).toBe('Completed');
    expect(invocations).toHaveLength(5);
    expect(invocations.every((invocation) => invocation.state === 'observed')).toBe(true);
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(toolWindowRenewals).toBeGreaterThanOrEqual(3);
  });

  it('yields at a verifier revision boundary and supplies its structured observation once', async () => {
    const seen: ModelClientRequest[] = [];
    let modelCalls = 0;
    const client: ModelClient = {
      execute: (request) => {
        seen.push(request);
        modelCalls += 1;
        return Promise.resolve({
          kind: 'json',
          response: chatResponse(
            modelCalls === 1 ? 'Initial delivery.' : 'Revised delivery.',
            'stop',
          ),
        });
      },
    };
    let verifierCalls = 0;
    const session = await authenticSession('delivery-revision-boundary', 'openai-chat', client);
    const journal = createJournal('delivery-revision-boundary');
    const kernel = productionKernel(journal, session, fixedBaselineRegistry(), {
      verifier: {
        verifierId: 'semantic-delivery', revision: 'v1', mode: 'required',
        verify: () => {
          verifierCalls += 1;
          return verifierCalls === 1
            ? { status: 'revise', observation: { code: 'DELIVERY_FACT_MISSING' } }
            : { status: 'accepted' };
        },
      },
    });
    const started = await kernel.start({
      projectId: 'project-delivery-revision-boundary',
      sessionId: 'session-delivery-revision-boundary',
      clientRequestId: 'request-delivery-revision-boundary',
      input: 'Deliver a verified response.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });

    expect(modelCalls).toBe(2);
    expect(JSON.stringify(seen[1]?.wireRequest)).toContain('DELIVERY_FACT_MISSING');
    const decisions = (await readAllRunEvents({
      journal,
      projectId: 'project-delivery-revision-boundary',
      sessionId: 'session-delivery-revision-boundary',
      runId: started.runId,
    })).filter((event) => event.type === 'delivery.decided');
    expect(decisions.map((event) => event.payload.outcome)).toEqual([
      'revision-requested',
      'accepted',
    ]);
  });
});

describe('production Agent provider-opaque continuation invariant', () => {
  it('replays the exact committed Responses envelope on the second same-connection turn', async () => {
    const sentinel = 'opaque-raw-value-sentinel';
    const seen: ModelClientRequest[] = [];
    let call = 0;
    const client: ModelClient = {
      execute: (request) => {
        seen.push(request);
        call += 1;
        return Promise.resolve({
          kind: 'json',
          response: call === 1
            ? responsesToolTurn(sentinel)
            : responsesFinalTurn('Continuation completed.'),
        });
      },
    };
    const session = await authenticSession('opaque-same', 'openai-responses', client, {
      replay: { mode: 'same-connection', envelopes: [] },
    });
    const journal = createJournal('opaque-same');
    const kernel = productionKernel(journal, session, inspectToolRegistry());
    const started = await kernel.start({
      projectId: 'project-opaque-same', sessionId: 'session-opaque-same',
      clientRequestId: 'request-opaque-same', input: 'Inspect and continue.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    const continued = await kernel.advance(started.runId);
    const continuationWire = seen[1] === undefined ? '<no-second-wire-request>'
      : JSON.stringify(seen[1].wireRequest);
    const events = await readAllRunEvents({
      journal, projectId: 'project-opaque-same', sessionId: 'session-opaque-same',
      runId: started.runId,
    });
    const interruption = [...events].reverse().find((event) => event.type === 'run.interrupted');
    expect(continued.state).toBe('Completed');
    expect(continuationWire).toContain(sentinel);
    expect(interruption).toBeUndefined();
    expect(continuationWire).toContain('reasoning-item-native');
    expect(continuationWire).toContain('wire-call-native');
    expect(continuationWire).toContain('wire-item-native');
    // Same-connection replay emits the native reasoning item once; it must not
    // also duplicate the derived public summary as a second wire message.
    expect(continuationWire.match(/Inspect before answering\./gu)).toHaveLength(1);

    const firstCommit = events.find((event) => event.type === 'model_attempt_committed');
    expect(firstCommit?.type === 'model_attempt_committed'
      ? firstCommit.payload.validatedAttempt.opaqueBlockRefs
      : []).toHaveLength(1);
  });

  it('drops provider opaque state but preserves its public reasoning summary on compatible fallback', async () => {
    const sentinel = 'opaque-cross-provider-sentinel';
    const primaryRequests: ModelClientRequest[] = [];
    const fallbackRequests: ModelClientRequest[] = [];
    let primaryCall = 0;
    const primary: ModelClient = {
      execute: (request) => {
        primaryRequests.push(request);
        primaryCall += 1;
        if (primaryCall === 1) {
          return Promise.resolve({ kind: 'json', response: responsesToolTurn(sentinel) });
        }
        return Promise.reject(new ModelClientError(
          'CONNECT_FAILED', 'primary unavailable', { retryable: true },
        ));
      },
    };
    const fallback: ModelClient = {
      execute: (request) => {
        fallbackRequests.push(request);
        return Promise.resolve({ kind: 'json', response: chatResponse('Fallback completed.', 'stop') });
      },
    };
    const session = await authenticBundle('opaque-fallback', primary, fallback);
    const journal = createJournal('opaque-fallback');
    const kernel = productionKernel(journal, session, inspectToolRegistry());
    const started = await kernel.start({
      projectId: 'project-opaque-fallback', sessionId: 'session-opaque-fallback',
      clientRequestId: 'request-opaque-fallback', input: 'Inspect with fallback.',
    });

    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    const continued = await kernel.advance(started.runId);
    const fallbackWire = fallbackRequests[0] === undefined ? '<no-fallback-wire-request>'
      : JSON.stringify(fallbackRequests[0].wireRequest);
    const events = await readAllRunEvents({
      journal, projectId: 'project-opaque-fallback', sessionId: 'session-opaque-fallback',
      runId: started.runId,
    });
    const interruption = [...events].reverse().find((event) => event.type === 'run.interrupted');
    expect(continued.state).toBe('Completed');
    expect(fallbackWire).toContain('Inspect before answering.');
    expect(interruption).toBeUndefined();
    expect(primaryRequests.length).toBeGreaterThanOrEqual(2);
    expect(fallbackWire).not.toContain(sentinel);
    expect(fallbackWire).not.toContain('reasoning-item-native');
    expect(fallbackWire).not.toContain('wire-item-native');
  });

  it('never sends provider opaque values or native item identities to the compaction summarizer', async () => {
    const sentinel = 'opaque-compaction-sentinel';
    const seen: ModelClientRequest[] = [];
    let call = 0;
    const client: ModelClient = {
      execute: (request) => {
        seen.push(request);
        call += 1;
        return Promise.resolve({
          kind: 'json',
          response: call === 1
            ? responsesToolTurn(sentinel)
            : call === 2
              ? responsesFinalTurn('Safe compacted semantic history.')
              : responsesFinalTurn('Answer after compaction.'),
        });
      },
    };
    const session = await authenticSession('opaque-compaction', 'openai-responses', client, {
      replay: { mode: 'same-connection', envelopes: [] },
    });
    const journal = createJournal('opaque-compaction');
    let verifierCalls = 0;
    const kernel = productionKernel(journal, session, inspectToolRegistry(), {
      verifier: {
        verifierId: 'force-next-turn', revision: 'v1', mode: 'required',
        verify: () => {
          verifierCalls += 1;
          return verifierCalls === 1
            ? { status: 'revise', observation: 'Continue once.' }
            : { status: 'accepted' };
        },
      },
    });
    const started = await kernel.start({
      projectId: 'project-opaque-compaction', sessionId: 'session-opaque-compaction',
      clientRequestId: 'request-opaque-compaction', input: 'Inspect and compact.',
    });
    const limited = await kernel.advance(started.runId, { limits: { maxTurns: 1 } });
    expect(limited.state).toBe('LimitReached');
    await kernel.resume({ runId: started.runId, reason: 'force compaction' });
    await kernel.requestManualCompaction({ runId: started.runId });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(kernel.advance(started.runId)).resolves.toMatchObject({ state: 'Completed' });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    const compactionWire = JSON.stringify(seen[1]?.wireRequest);
    expect(compactionWire).toContain('Inspect before answering.');
    expect(compactionWire).not.toContain(sentinel);
    expect(compactionWire).not.toContain('reasoning-item-native');
    expect(compactionWire).not.toContain('wire-item-native');
    expect(compactionWire).not.toContain('wire-call-native');
  });
});

describe('production Agent provider diagnostic persistence invariant', () => {
  it('redacts endpoint credentials, auth headers and response bodies and closes the active Attempt', async () => {
    const secrets = [
      'diagnostic-api-key-sentinel',
      'diagnostic-bearer-token-sentinel',
      'diagnostic-body-sentinel',
      'secret.internal.example/v1',
    ];
    const diagnostic = [
      'POST https://secret.internal.example/v1?api_key=diagnostic-api-key-sentinel',
      'Authorization: Bearer diagnostic-bearer-token-sentinel',
      'response_body={"raw":"diagnostic-body-sentinel"}',
    ].join(' ');
    const client: ModelClient = {
      execute: () => Promise.reject(new ModelClientError(
        'HTTP_ERROR', diagnostic, { retryable: false, statusCode: 401 },
      )),
    };
    const session = await authenticSession('provider-diagnostic', 'openai-chat', client);
    const journal = createJournal('provider-diagnostic');
    const kernel = productionKernel(journal, session, fixedBaselineRegistry());
    const started = await kernel.start({
      projectId: 'project-provider-diagnostic', sessionId: 'session-provider-diagnostic',
      clientRequestId: 'request-provider-diagnostic', input: 'Call the provider.',
    });

    let thrown: unknown;
    try {
      await kernel.advance(started.runId);
    } catch (error) {
      thrown = error;
    }
    const run = await kernel.open(started.runId);
    expect(thrown).toBeUndefined();
    expect(run.state).toBe('Failed');
    expect(run.currentAttemptId).toBeNull();
    const events = await readAllRunEvents({
      journal, projectId: 'project-provider-diagnostic', sessionId: 'session-provider-diagnostic',
      runId: started.runId,
    });
    const database = new DatabaseSync(journal.filePath, { readOnly: true });
    let commandJson = '';
    try {
      commandJson = JSON.stringify(database.prepare(
        'SELECT command_kind, result_json FROM agent_commands ORDER BY committed_at',
      ).all());
    } finally {
      database.close();
    }
    expect(events.filter((event) => event.type === 'model_attempt_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'model_attempt_discarded')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'model_attempt_committed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(0);
    const closed = events.find((event) => event.type === 'turn.closed');
    expect(closed?.type === 'turn.closed' ? closed.payload.reason : undefined).toBe('failed');
    const failed = events.find((event) => event.type === 'run.failed');
    if (failed?.type !== 'run.failed') throw new Error('Expected a failed Run event.');
    expect(failed.payload.code).toBe('MODEL_TRANSPORT_FAILED');
    expect(failed.payload.detail).toMatchObject({
      category: 'model-gateway', code: 'MODEL_TRANSPORT_FAILED', statusCode: 401,
    });

    const durableJson = `${JSON.stringify(events)}\n${commandJson}`;
    for (const secret of secrets) expect(durableJson).not.toContain(secret);
    expect(durableJson).not.toContain('Authorization: Bearer');
    expect(durableJson).not.toContain('response_body');
  });
});

type RunFixture = Readonly<{
  journal: SqliteAgentJournal;
  projectId: string;
  sessionId: string;
  runId: string;
  run: Awaited<ReturnType<ReturnType<typeof createJournalAgentKernel>['advance']>>;
}>;

async function runOneResponse(label: string, response: unknown): Promise<RunFixture> {
  const client: ModelClient = {
    execute: () => Promise.resolve({ kind: 'json', response }),
  };
  const session = await authenticSession(`terminal-${label}`, 'openai-chat', client);
  const journal = createJournal(`terminal-${label}`);
  const projectId = `project-${label}`;
  const sessionId = `session-${label}`;
  const kernel = productionKernel(journal, session, fixedBaselineRegistry());
  const started = await kernel.start({
    projectId,
    sessionId,
    clientRequestId: `request-${label}`,
    input: 'Return the final answer.',
  });
  const run = await kernel.advance(started.runId);
  return { journal, projectId, sessionId, runId: started.runId, run };
}

function chatResponse(content: unknown, finishReason: string): unknown {
  return {
    id: `response-${finishReason}`,
    model: 'model-a',
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function productionKernel(
  journal: SqliteAgentJournal,
  session: ModelSession | Awaited<ReturnType<typeof authenticBundle>>,
  tools: ToolRegistry,
  overrides: Partial<Parameters<typeof createJournalAgentKernel>[0]> = {},
) {
  let id = 0;
  return createJournalAgentKernel({
    journal,
    gateway: new ModelExecutionGateway({ createAttemptId: () => `attempt-${++id}` }),
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: tools.captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol',
      source: 'runtime',
      scope: 'static',
      priority: 0,
      revision: 'runtime-r1',
      cacheability: 'stable',
      content: [{ type: 'text', text: 'Complete the user request.' }],
      tokenEstimate: 8,
    },
    capability: { snapshotId: 'capability-1', revision: 'capability-r1' },
    promptRevision: 'prompt-r1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    ownerId: `owner-${Date.now()}-${id}`,
    ...overrides,
  });
}

async function authenticSession(
  label: string,
  protocol: ModelProtocol,
  client: ModelClient,
  options: Readonly<{ replay?: ModelSession['replay'] }> = {},
): Promise<ModelSession> {
  const cacheDirectory = mkdtempSync(join(tmpdir(), `kernel-red-model-${label}-`));
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
    plugins: [providerPlugin(protocol, `plugin-${label}`)],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: `connection-${label}`,
    endpoint: 'http://127.0.0.1:8999',
    apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1',
    credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing test Model connection.');
  await manager.discover(connection.id);
  return await manager.prepareModelSessionBundle(
    { connectionId: connection.id, modelId: 'model-a' },
    options.replay === undefined ? {} : { replay: options.replay },
  ).then((bundle) => bundle.primary);
}

async function authenticBundle(
  label: string,
  primaryClient: ModelClient,
  fallbackClient: ModelClient,
) {
  const cacheDirectory = mkdtempSync(join(tmpdir(), `kernel-red-bundle-${label}-`));
  roots.push(cacheDirectory);
  const clients = new Map([['primary-red', primaryClient], ['fallback-red', fallbackClient]]);
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
    plugins: [
      providerPlugin('openai-responses', 'primary-red', 100),
      providerPlugin('openai-chat', 'fallback-red', 90),
    ],
    trustedModelClientFactory,
  });
  manager.replaceConnections([{
    name: `connection-${label}`, endpoint: 'http://127.0.0.1:8999', apiKey: 'test-only',
    connectionConfigurationRevision: 'config-r1', credentialRevision: 'credential-r1',
  }]);
  const connection = manager.connections()[0];
  if (connection === undefined) throw new Error('Missing fallback connection.');
  const discovery = await manager.discover(connection.id);
  const fallbackResolution = discovery.alternatives[0];
  if (fallbackResolution === undefined) throw new Error('Missing compatible fallback route.');
  const fallbackRouteId = [
    connection.id, 'model-a', fallbackResolution.pluginId, fallbackResolution.revision,
  ].join(':');
  return await manager.prepareModelSessionBundle(
    { connectionId: connection.id, modelId: 'model-a' },
    {
      replay: { mode: 'same-connection', envelopes: [] },
      allowedFallbackRouteIds: [fallbackRouteId],
    },
  );
}

function providerPlugin(
  protocol: ModelProtocol,
  id: string,
  priority = 100,
): LlmProviderPlugin {
  const provider: LlmProvider = {
    id,
    name: id,
    mode: 'private',
    protocol,
    chat: () => Promise.resolve({ text: 'unused', toolCalls: [] }),
    listModels: () => Promise.resolve(['model-a']),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: {},
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: { id, name: id, version: '1.0.0', protocol, priority },
    match: () => ({ score: priority, evidence: [] }),
    discover: () => Promise.resolve({ score: priority, models: ['model-a'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function createJournal(label: string): SqliteAgentJournal {
  const root = mkdtempSync(join(tmpdir(), `kernel-red-journal-${label}-`));
  roots.push(root);
  return new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
}

function inspectToolRegistry(): ToolRegistry {
  const tools = fixedBaselineRegistry();
  const contribution = invocationContribution('inspect_project', { inspected: true }, { handlerRevision: 'inspect-project-r1', exposure: 'direct' });
  tools.registerInvocation({ ...contribution.definition, description: 'Read one project fact.', permission: { actions: ['read'] } }, contribution.runtime);
  return tools;
}

function evidenceToolRegistry(): ToolRegistry {
  const tools = fixedBaselineRegistry();
  const contribution = invocationContribution('inspect_evidence', {}, { handlerRevision: 'inspect-evidence-r1', exposure: 'direct' });
  tools.registerInvocation({
    ...contribution.definition, description: 'Read one evidence item.', permission: { actions: ['read'] },
    inputSchema: {
      type: 'object', properties: { index: { type: 'integer' } },
      required: ['index'], additionalProperties: false,
    },
  }, {
    ...contribution.runtime,
    execute: (arguments_) => {
      const index = Number(arguments_.index);
      return { value: index };
    },
  });
  return tools;
}

function manyEvidenceToolCallsResponse(count: number, toolName = 'inspect_evidence'): unknown {
  return {
    id: 'response-many-evidence-tools',
    model: 'model-a',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: Array.from({ length: count }, (_, index) => ({
          id: `evidence-call-${index}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ index }) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
  };
}

function responsesToolTurn(sentinel: string): unknown {
  return {
    id: 'response-tool-turn', model: 'model-a', status: 'completed',
    output: [
      {
        id: 'reasoning-item-native', type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Inspect before answering.' }],
        encrypted_content: sentinel,
      },
      {
        id: 'wire-item-native', type: 'function_call', call_id: 'wire-call-native',
        name: 'inspect_project', arguments: '{}',
      },
    ],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
  };
}

function responsesFinalTurn(text: string): unknown {
  return {
    id: 'response-final-turn', model: 'model-a', status: 'completed',
    output: [{
      id: 'message-final', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
  };
}

async function readAllRunEvents(fixture: Pick<RunFixture, 'journal' | 'projectId' | 'sessionId' | 'runId'>) {
  const events: Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'][number][] = [];
  let cursor = 0;
  while (true) {
    const page = await fixture.journal.readRunEvents({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      afterSequence: cursor,
      limit: 100,
    });
    events.push(...page.events);
    if (page.nextSequence === null) return events;
    cursor = page.nextSequence;
  }
}
