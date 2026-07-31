import type { LlmProvider } from '@dbagent/core-llm';
import { request as httpRequest } from 'node:http';
import type { DatabaseAgentRuntimePort } from '../src/server.js';
import type {
  CapabilityDescriptor,
  AgentContextCheckpoint,
  AgentApprovalRequest,
  AgentRunRecord,
  AgentSessionListInput,
  AgentSessionListItem,
  AgentSessionView,
  AgentSkillCatalogEntry,
  AgentSkillRefreshResult,
  AiSqlAgentRun,
  CompactAiSqlAgentSessionInput,
  CompactAiSqlAgentSessionResult,
  DatabaseConnector,
  ExecutedSqlRun,
  GeneratedSqlRun,
  IndexSchemaOptions,
  PostgresConnectionInput,
  QueryJob,
  RunAiSqlAgentInput,
  McpServerRegistrationInput,
  McpServerStartSummary,
  McpServerStopSummary,
  McpServerSummary,
  RuntimeStatus,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
} from '@dbagent/sdk';
import {
  DATABASE_CAPABILITIES,
  DatabaseAgentError,
  DatabaseAgentRuntime,
  createStableRelationId,
  createStableResourceId,
  toAgentSessionView,
} from '@dbagent/sdk';
import type { SavedConnection } from '@dbagent/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startDatabaseAgentServer, type StartedDatabaseAgentServer } from '../src/index.js';

describe('SchemaNaut local server', () => {
  let started: StartedDatabaseAgentServer | undefined;

  afterEach(async () => {
    if (!started) return;
    await started.close();
    started = undefined;
  });

  it('serves the WebUI and the complete setup, index, generate, execute flow', async () => {
    const runtime = new FakeRuntime();
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const page = await fetch(started.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<h1>SchemaNaut</h1>');
    expect(html).toContain('数据库接入管理');
    expect(html).toContain('/v1/database/connectors');

    const health = await getJson(started.url, '/health');
    expect(health).toMatchObject({ status: 'ok', service: 'schemanaut-server' });

    const setupResponse = await fetch(`${started.url}/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llm: {
          baseUrl: 'https://llm.example.test/v1',
          apiKey: 'secret-llm-key',
          model: 'test-model',
        },
        database: {
          host: '127.0.0.1',
          port: 5432,
          database: 'dbagent_demo',
          username: 'postgres',
          password: 'secret-db-password',
        },
      }),
    });
    expect(setupResponse.status).toBe(200);
    const setupText = await setupResponse.text();
    expect(setupText).not.toContain('secret-llm-key');
    expect(setupText).not.toContain('secret-db-password');
    expect(JSON.parse(setupText)).toMatchObject({
      provider: { model: 'test-model' },
      connection: { readOnly: true, status: 'connected' },
    });

    const indexed = await postJson(started.url, '/v1/schema/index', {});
    expect(indexed).toMatchObject({ ready: true, tableCount: 2 });

    const chunkedIndex = await postChunkedJson(
      started.url,
      '/v1/schema/index',
      '{"max',
      'Tables":7}',
    );
    expect(chunkedIndex).toMatchObject({ ready: true, tableCount: 2 });
    expect(runtime.lastIndexOptions).toEqual({ maxTables: 7 });

    const generated = await postJson(started.url, '/v1/query/generate', {
      question: '每个城市的订单金额是多少？',
    });
    expect(generated).toMatchObject({ runId: 'run-1', status: 'awaiting_execution' });

    const executed = await postJson(started.url, '/v1/query/execute', { runId: 'run-1' });
    expect(executed).toMatchObject({
      status: 'completed',
      execution: { rowCount: 1, rows: [{ city: 'Shanghai', total: 188 }] },
    });

    const run = await getJson(started.url, '/v1/runs/run-1');
    expect(run).toMatchObject({ status: 'completed' });

    const reexecuted = await postJson(started.url, '/v1/query/reexecute', {
      runId: 'run-1',
    });
    expect(reexecuted).toMatchObject({
      status: 'completed',
      executionResultAvailable: true,
      execution: { rowCount: 1, rows: [{ city: 'Shanghai', total: 188 }] },
    });

    const agent = await postJson(started.url, '/v1/agent/run', {
      message: '继续分析订单',
      mode: 'read',
      sessionId: 'api-session',
    });
    expect(agent).toMatchObject({
      activatedSkills: ['query-and-answer'],
      result: {
        runId: 'agent-run-1',
        status: 'done',
        session: { id: 'api-session' },
      },
    });
    expect(JSON.stringify(agent)).not.toMatch(
      /toolExecutions|knowledgeSnapshot|catalogRootHash|internalNodeId|instructions/,
    );
    expect(runtime.lastAgentInput).toMatchObject({
      message: '继续分析订单',
      mode: 'read',
      sessionId: 'api-session',
    });

    const agentRuns = await getJson(
      started.url,
      '/v1/agent/runs?sessionId=api-session&limit=10',
    );
    expect(agentRuns).toMatchObject([
      {
        runId: 'agent-run-1',
        sessionId: 'api-session',
        status: 'done',
        phase: 'done',
      },
    ]);
    const agentRun = await getJson(started.url, '/v1/agent/runs/agent-run-1');
    expect(agentRun).toMatchObject({
      runId: 'agent-run-1',
      sessionId: 'api-session',
      status: 'done',
      completion: { verified: true, phase: 'done' },
    });

    const compacted = await postJson(started.url, '/v1/agent/sessions/api-session/compact', {
      focus: '保留 SQL 和精确结果',
    });
    expect(compacted).toMatchObject({
      status: 'compacted',
      session: {
        id: 'api-session',
        messages: [{ role: 'user' }, { role: 'assistant' }],
      },
      report: {
        phase: 'compacted',
        trigger: 'manual',
        originalTokenEstimate: 20_000,
        finalTokenEstimate: 2_000,
      },
      checkpoint: {
        sequence: 1,
        trigger: 'manual',
        focus: '保留 SQL 和精确结果',
      },
    });
    expect(JSON.stringify(compacted)).not.toMatch(
      /role":"tool|toolCalls|knowledgeSnapshot|catalogRootHash|internalNodeId|instructions|modelContextTokens|availablePromptTokens|toolCount|maskedToolResultCount|steps/,
    );
    const checkpoints = await getJson(
      started.url,
      '/v1/agent/sessions/api-session/context-checkpoints',
    );
    expect(checkpoints).toMatchObject([{ sequence: 1, trigger: 'manual' }]);
    expect(JSON.stringify(checkpoints)).not.toMatch(
      /method|modelContextTokens|knowledgeSnapshot|hash/i,
    );
  });

  it('provides public Agent management, semantic SSE, Skills, approvals and MCP lifecycle APIs', async () => {
    const runtime = new FakeRuntime();
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const capabilities = await getJson(started.url, '/v1/capabilities');
    expect(capabilities).toMatchObject({
      safety: {
        permissionModes: ['read', 'edit', 'full'],
        oneTimeApproval: true,
      },
    });

    await expect(
      getJson(started.url, '/v1/agent/sessions?limit=20&offset=0'),
    ).resolves.toMatchObject([
      {
        id: 'api-session',
        mode: 'read',
        conversationMessageCount: 2,
      },
    ]);
    const session = await getJson(started.url, '/v1/agent/sessions/api-session');
    expect(session).toMatchObject({
      id: 'api-session',
      messages: [
        { role: 'user', content: '继续分析订单' },
        { role: 'assistant', content: '已继续分析。' },
      ],
      taskPlan: {
        goal: '完成订单分析',
        tasks: [{ id: 'query', title: '执行查询', status: 'in_progress' }],
      },
      activeSkills: [{ name: 'query-and-answer', scope: 'system' }],
    });
    expect(JSON.stringify(session)).not.toMatch(
      /role":"tool|toolCalls|activeTools|knowledgeSnapshot|private-root-hash|instructions|让我继续验证|acceptanceCriteria|dependsOn|evidence|result-handle/,
    );

    const steered = await postJson(
      started.url,
      '/v1/agent/sessions/api-session/steer',
      { message: '补充按地区分组' },
      202,
    );
    expect(steered).toEqual({ accepted: true });

    await expect(getJson(started.url, '/v1/agent/skills')).resolves.toMatchObject([
      { name: 'query-and-answer', scope: 'system' },
    ]);
    await expect(postJson(started.url, '/v1/agent/skills/refresh', {})).resolves.toMatchObject({
      changed: true,
      revision: 2,
      issueCount: 0,
      conflictCount: 0,
    });

    await expect(getJson(started.url, '/v1/agent/approvals')).resolves.toMatchObject([
      { id: 'approval-1', status: 'pending', toolName: 'sql_execute' },
    ]);
    await expect(
      postJson(started.url, '/v1/agent/approvals/approval-1/resolve', {
        approved: true,
        resolvedBy: 'api-user',
      }),
    ).resolves.toEqual({ resolved: true, approved: true });

    const createdMcp = await postJson(
      started.url,
      '/v1/agent/mcp',
      {
        id: 'company-tools',
        name: 'Company Tools',
        transport: 'streamable-http',
        url: 'https://mcp.example.test',
        headers: {
          Authorization: { ref: 'mcp:company-tools:authorization' },
        },
      },
      201,
    );
    expect(createdMcp).toMatchObject({
      id: 'company-tools',
      transport: 'streamable-http',
      status: 'stopped',
    });
    expect(JSON.stringify(createdMcp)).not.toMatch(
      /Authorization|mcp:company-tools:authorization|headers/,
    );
    await expect(
      postJson(started.url, '/v1/agent/mcp/company-tools/start', {}),
    ).resolves.toMatchObject({
      server: { id: 'company-tools', status: 'healthy', running: true },
      tools: ['mcp__company-tools__lookup'],
    });
    await expect(getJson(started.url, '/v1/agent/mcp')).resolves.toMatchObject([
      { id: 'company-tools', status: 'healthy', running: true },
    ]);
    await expect(
      postJson(started.url, '/v1/agent/mcp/company-tools/stop', {}),
    ).resolves.toMatchObject({
      serverId: 'company-tools',
      status: 'stopped',
    });

    const streamResponse = await fetch(`${started.url}/v1/agent/run/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '继续分析订单',
        sessionId: 'api-session',
      }),
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    const streamText = await streamResponse.text();
    expect(streamText).toContain('event: plan-updated');
    expect(streamText).toContain('event: result');
    expect(streamText).not.toMatch(
      /toolExecutions|knowledgeSnapshot|catalogRootHash|internalNodeId/,
    );

    const removedMcp = await fetch(`${started.url}/v1/agent/mcp/company-tools`, {
      method: 'DELETE',
    });
    expect(removedMcp.status).toBe(200);
    expect(await removedMcp.json()).toEqual({ removed: true });

    const deletedSession = await fetch(`${started.url}/v1/agent/sessions/api-session`, {
      method: 'DELETE',
    });
    expect(deletedSession.status).toBe(200);
    expect(await deletedSession.json()).toEqual({ deleted: true });
  });

  it('awaits runtime cleanup through the public server close lifecycle', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupFinished = false;
    const runtime = Object.assign(new FakeRuntime(), {
      async close(): Promise<void> {
        await cleanupGate;
        cleanupFinished = true;
      },
    });
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const closing = started.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);

    releaseCleanup?.();
    await closing;
    expect(cleanupFinished).toBe(true);
    started = undefined;
  });

  it('aborts active Agent requests before waiting for the HTTP server to close', async () => {
    const runtime = new FakeRuntime();
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.runAgent = async (input): Promise<AiSqlAgentRun> => {
      observedSignal = input.signal;
      markStarted?.();
      return await new Promise<AiSqlAgentRun>((_, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => reject(new DatabaseAgentError('ABORTED', 'shutdown', false)),
          { once: true },
        );
      });
    };
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const url = new URL(started.url);
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/agent/run',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ message: 'abort during shutdown' }));
    await runStarted;

    const closing = started.close();
    let closedPromptly = false;
    try {
      closedPromptly = await Promise.race([
        closing.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(closedPromptly).toBe(true);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      if (!closedPromptly) request.destroy();
      await closing;
      started = undefined;
    }
  });

  it('starts shutdown before a low-level Node server.close waits on active requests', async () => {
    const runtime = new FakeRuntime();
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.runAgent = async (input): Promise<AiSqlAgentRun> => {
      observedSignal = input.signal;
      markStarted?.();
      return await new Promise<AiSqlAgentRun>((_, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => reject(new DatabaseAgentError('ABORTED', 'shutdown', false)),
          { once: true },
        );
      });
    };
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const url = new URL(started.url);
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/agent/run',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ message: 'low-level shutdown' }));
    await runStarted;

    const rawClosed = new Promise<void>((resolve, reject) => {
      started?.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const closedPromptly = await Promise.race([
      rawClosed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);

    expect(closedPromptly).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    await started.close();
    started = undefined;
  });

  it('cancels non-streaming Agent work when the HTTP client disconnects', async () => {
    const runtime = new FakeRuntime();
    const originalRunAgent = runtime.runAgent.bind(runtime);
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    runtime.runAgent = async (input) => {
      observedSignal = input.signal;
      markStarted?.();
      await runGate;
      return originalRunAgent(input);
    };
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const url = new URL(started.url);
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/agent/run',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ message: 'cancel on disconnect' }));
    await runStarted;
    expect(observedSignal).toBeDefined();
    const abortObserved = new Promise<void>((resolve) => {
      if (observedSignal?.aborted) resolve();
      else observedSignal?.addEventListener('abort', () => resolve(), { once: true });
    });
    request.destroy();
    await Promise.race([
      abortObserved,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HTTP disconnect did not abort Agent work.')), 1_000),
      ),
    ]);
    releaseRun?.();

    expect(observedSignal?.aborted).toBe(true);
  });

  it('cancels non-streaming LLM work when the HTTP client disconnects', async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseCall: (() => void) | undefined;
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const runtime = Object.assign(new FakeRuntime(), {
      async llmChat(
        request: Parameters<NonNullable<DatabaseAgentRuntimePort['llmChat']>>[0],
      ) {
        observedSignal = request.signal;
        markStarted?.();
        await callGate;
        return { text: 'done', toolCalls: [] };
      },
    });
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const url = new URL(started.url);
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/llm/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ messages: [{ role: 'user', content: 'cancel me' }] }));
    await callStarted;
    expect(observedSignal).toBeDefined();
    const abortObserved = new Promise<void>((resolve) => {
      if (observedSignal?.aborted) resolve();
      else observedSignal?.addEventListener('abort', () => resolve(), { once: true });
    });
    request.destroy();
    await Promise.race([
      abortObserved,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HTTP disconnect did not abort LLM work.')), 1_000),
      ),
    ]);
    releaseCall?.();

    expect(observedSignal?.aborted).toBe(true);
  });

  it('keeps process-backed stdio MCP management disabled by default and supports explicit opt-in', async () => {
    const runtime = new FakeRuntime();
    await runtime.upsertMcpServer({
      id: 'persisted-stdio',
      name: 'Persisted stdio',
      transport: 'stdio',
      command: 'node',
    });
    runtime.mcpUpsertCalls = 0;
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const createBlocked = await fetch(`${started.url}/v1/agent/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'new-stdio',
        name: 'New stdio',
        transport: 'stdio',
        command: 'node',
      }),
    });
    expect(createBlocked.status).toBe(403);
    await expect(createBlocked.json()).resolves.toMatchObject({
      error: { code: 'PROCESS_MCP_DISABLED' },
    });
    expect(runtime.mcpUpsertCalls).toBe(0);

    const startBlocked = await fetch(`${started.url}/v1/agent/mcp/persisted-stdio/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(startBlocked.status).toBe(403);
    await expect(startBlocked.json()).resolves.toMatchObject({
      error: { code: 'PROCESS_MCP_DISABLED' },
    });
    expect(runtime.mcpStartCalls).toBe(0);

    const capabilities = await getJson(started.url, '/v1/capabilities');
    expect(capabilities).toMatchObject({
      safety: { restProcessMcpManagement: false },
    });

    await started.close();
    started = undefined;

    const optedInRuntime = new FakeRuntime();
    started = await startDatabaseAgentServer({
      port: 0,
      runtime: optedInRuntime,
      createProvider: fakeProviderFactory,
      allowProcessMcpManagement: true,
    });
    await expect(
      postJson(
        started.url,
        '/v1/agent/mcp',
        {
          id: 'opted-in-stdio',
          name: 'Opted-in stdio',
          transport: 'stdio',
          command: 'node',
        },
        201,
      ),
    ).resolves.toMatchObject({ id: 'opted-in-stdio', transport: 'stdio' });
    await expect(
      postJson(started.url, '/v1/agent/mcp/opted-in-stdio/start', {}),
    ).resolves.toMatchObject({
      server: { id: 'opted-in-stdio', running: true },
    });
    expect(optedInRuntime.mcpUpsertCalls).toBe(1);
    expect(optedInRuntime.mcpStartCalls).toBe(1);
  });

  it('accepts only loopback Host, same-origin browser requests, and JSON request bodies', async () => {
    started = await startDatabaseAgentServer({
      port: 0,
      runtime: new FakeRuntime(),
      createProvider: fakeProviderFactory,
    });

    const hostileHost = await rawHttpRequest(started.url, {
      path: '/health',
      headers: { host: 'attacker.example' },
    });
    expect(hostileHost.status).toBe(403);
    expect(hostileHost.json).toMatchObject({ error: { code: 'LOCAL_ACCESS_ONLY' } });

    const crossOrigin = await fetch(`${started.url}/health`, {
      headers: { origin: 'https://attacker.example' },
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      error: { code: 'ORIGIN_FORBIDDEN' },
    });

    const sameOrigin = await fetch(`${started.url}/health`, {
      headers: { origin: started.url },
    });
    expect(sameOrigin.status).toBe(200);

    const wrongContentType = await fetch(`${started.url}/v1/schema/index`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(415);
    await expect(wrongContentType.json()).resolves.toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });

    const emptyBody = await fetch(`${started.url}/v1/schema/index`, { method: 'POST' });
    expect(emptyBody.status).toBe(200);
  });

  it('bounds REST Agent execution settings before invoking the runtime', async () => {
    const runtime = new FakeRuntime();
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const capabilities = await getJson(started.url, '/v1/capabilities');
    expect(capabilities).toMatchObject({
      limits: {
        maxAgentIterations: 64,
        maxToolExecutionMs: 300_000,
      },
    });

    for (const body of [
      { message: 'too many rounds', maxIterations: 65 },
      { message: 'no rounds', maxIterations: 0 },
      { message: 'tool timeout too large', maxToolExecutionMs: 300_001 },
      { message: 'tool timeout must be positive', maxToolExecutionMs: 0 },
    ]) {
      const response = await fetch(`${started.url}/v1/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_INPUT' },
      });
    }
    expect(runtime.lastAgentInput).toBeUndefined();
  });

  it('redacts credentials and local paths from public errors', async () => {
    const runtime = new FakeRuntime();
    runtime.generateError = new DatabaseAgentError(
      'QUERY_FAILED',
      'Failed at C:\\Users\\alice\\.config\\provider.json with apiKey=sk-test-secret-123456 and postgresql://admin:db-password@127.0.0.1/demo',
      false,
    );
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: fakeProviderFactory,
    });

    const response = await fetch(`${started.url}/v1/query/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'trigger the provider failure' }),
    });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[LOCAL_PATH]');
    expect(text).not.toMatch(
      /alice|provider\.json|sk-test-secret-123456|db-password|postgresql:\/\/admin:/,
    );

    runtime.generateError = new Error(
      'unexpected failure at /home/service/config.json token=raw-secret-value',
    );
    const internal = await postJson(
      started.url,
      '/v1/query/generate',
      { question: 'trigger an internal failure' },
      500,
    );
    expect(internal).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        retryable: false,
      },
    });
  });

  it('returns stable errors for invalid JSON, missing runs, and unknown routes', async () => {
    started = await startDatabaseAgentServer({
      port: 0,
      runtime: new FakeRuntime(),
      createProvider: fakeProviderFactory,
    });

    const invalid = await fetch(`${started.url}/v1/query/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });

    const missing = await fetch(`${started.url}/v1/runs/not-found`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });

    const unknown = await fetch(`${started.url}/not-found`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('configures native Anthropic and private-provider presets without calling the network', async () => {
    started = await startDatabaseAgentServer({ port: 0, runtime: new FakeRuntime() });

    const anthropic = await postJson(started.url, '/v1/llm/setup', {
      protocol: 'anthropic-messages',
      apiKey: 'test-anthropic-key',
      model: 'claude-test',
    });
    expect(anthropic).toMatchObject({
      providerId: 'default-anthropic',
      protocol: 'anthropic-messages',
      model: 'claude-test',
    });

    const ollama = await postJson(started.url, '/v1/llm/setup', {
      presetId: 'ollama',
      model: 'local-model',
    });
    expect(ollama).toMatchObject({ providerId: 'ollama', protocol: 'openai-compatible' });

    const invalid = await fetch(`${started.url}/v1/llm/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'missing', model: 'test' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('discovers model metadata during setup without generating model output', async () => {
    let chatCalls = 0;
    const runtime = new DatabaseAgentRuntime({ sessionDatabasePath: ':memory:' });
    started = await startDatabaseAgentServer({
      port: 0,
      runtime,
      createProvider: () => ({
        id: 'metadata-provider',
        name: 'Metadata Provider',
        mode: 'private',
        capabilities: { chat: 'supported', toolCalling: 'unknown' },
        chat() {
          chatCalls += 1;
          return Promise.resolve({ text: 'unexpected', toolCalls: [] });
        },
        listModels() {
          return Promise.resolve(['metadata-model']);
        },
        getModelMetadata(model) {
          return Promise.resolve({
            model,
            source: 'provider-api',
            capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
            contextTokens: 16_384,
          });
        },
        isAvailable() {
          return Promise.resolve({ available: true });
        },
      }),
    });

    const configured = await postJson(started.url, '/v1/llm/setup', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowUnauthenticated: true,
      model: 'metadata-model',
    });

    expect(chatCalls).toBe(0);
    expect(configured).toMatchObject({
      providerId: 'metadata-provider',
      models: [
        {
          model: 'metadata-model',
          capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
          limits: { contextTokens: 16_384 },
          discovery: { source: 'provider-api' },
        },
      ],
    });
  });

  it('refuses non-loopback listening addresses', async () => {
    await expect(startDatabaseAgentServer({ host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('applies one resource scope to details, state, observations, relations, and events', async () => {
    const runtime = new DatabaseAgentRuntime({ sessionDatabasePath: ':memory:' });
    const observedAt = '2026-07-26T00:00:00.000Z';
    const source = {
      sourceId: 'scope-test',
      sourceType: 'manual' as const,
      observedAt,
    };
    runtime.resources.upsertResource({
      id: 'resource-team-a',
      kind: 'database',
      nativeId: 'team-a-db',
      canonicalName: 'team-a-db',
      scope: { tenantId: 'team-a' },
      version: 1,
      firstSeenAt: observedAt,
      updatedAt: observedAt,
      sources: [source],
    });
    runtime.resources.upsertResource({
      id: 'resource-team-b',
      kind: 'database',
      nativeId: 'team-b-db',
      canonicalName: 'team-b-db',
      scope: { tenantId: 'team-b' },
      version: 1,
      firstSeenAt: observedAt,
      updatedAt: observedAt,
      sources: [source],
    });
    runtime.resources.addObservation({
      id: 'observation-team-b',
      resourceId: 'resource-team-b',
      category: 'health',
      status: 'healthy',
      observedAt,
      expiresAt: '2026-07-27T00:00:00.000Z',
      source,
    });
    started = await startDatabaseAgentServer({ port: 0, runtime });

    expect(
      await getJson(started.url, '/v1/resources/resource-team-a?tenantId=team-a'),
    ).toMatchObject({ id: 'resource-team-a' });
    for (const suffix of ['', '/state', '/observations', '/relations']) {
      const response = await fetch(
        `${started.url}/v1/resources/resource-team-b${suffix}?tenantId=team-a`,
      );
      expect(response.status, suffix || '/detail').toBe(404);
    }
    const events = await getJson(started.url, '/v1/resource-events?tenantId=team-a&limit=20');
    expect(events.items).toEqual([
      expect.objectContaining({ resourceId: 'resource-team-a' }),
    ]);
  });

  it('exposes the complete connector, profile, resource, query, transaction and operation API', async () => {
    let submittedParams: readonly unknown[] | undefined;
    const connector = createApiTestConnector((params) => {
      submittedParams = params;
    });
    const runtime = new DatabaseAgentRuntime({
      connectors: [connector],
      sessionDatabasePath: ':memory:',
    });
    started = await startDatabaseAgentServer({ port: 0, runtime });

    const connectors = (await getJson(started.url, '/v1/database/connectors')) as unknown as Array<{
      id: string;
    }>;
    expect(connectors.map((item) => item.id)).toEqual(
      expect.arrayContaining(['postgres-native', 'api-test']),
    );

    const createdResponse = await fetch(`${started.url}/v1/database/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'api-profile',
        name: 'API test database',
        connectorId: 'api-test',
        engine: 'api-mock',
        endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 9999, database: 'demo' }],
        principal: 'tester',
        purpose: 'admin',
        readOnly: false,
        scope: { tenantId: 'api-tenant', projectId: 'api-project' },
      }),
    });
    expect(createdResponse.status).toBe(201);
    expect(await createdResponse.json()).toMatchObject({
      id: 'api-profile',
      principal: 'tester',
      scope: { tenantId: 'api-tenant', projectId: 'api-project' },
    });
    expect(await getJson(started.url, '/v1/database/profiles')).toEqual([
      expect.objectContaining({ id: 'api-profile' }),
    ]);
    expect(await getJson(started.url, '/v1/database/profiles/api-profile')).toMatchObject({
      name: 'API test database',
    });

    const patched = await fetch(`${started.url}/v1/database/profiles/api-profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated API database' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: 'Updated API database' });

    const tested = await postJson(started.url, '/v1/database/profiles/api-profile/test', {
      credential: { username: 'tester', password: 'never-return-this' },
    });
    expect(tested).toMatchObject({ status: 'healthy' });
    expect(JSON.stringify(tested)).not.toContain('never-return-this');
    expect(
      await postJson(started.url, '/v1/database/profiles/api-profile/connect', {
        credential: { username: 'tester', password: 'never-return-this' },
      }),
    ).toMatchObject({ status: 'connected' });
    expect(await getJson(started.url, '/v1/database/profiles/api-profile/health')).toMatchObject({
      status: 'healthy',
    });
    expect(
      await getJson(started.url, '/v1/database/profiles/api-profile/capabilities'),
    ).toMatchObject({ connectorId: 'api-test' });
    expect(
      await postJson(started.url, '/v1/database/profiles/api-profile/discover', {}),
    ).toMatchObject({ pages: 1, resources: 2, relations: 1 });

    const resources = await getJson(started.url, '/v1/database/resources?kinds=table&limit=10');
    const tableId = (resources.items as Array<{ id: string }>)[0]!.id;
    expect(resources.items).toEqual([expect.objectContaining({ kind: 'table' })]);
    expect(
      await getJson(
        started.url,
        '/v1/database/resources?kinds=table&tenantId=api-tenant&projectId=api-project&limit=10',
      ),
    ).toMatchObject({ items: [expect.objectContaining({ id: tableId })] });
    expect(
      await getJson(
        started.url,
        '/v1/database/resources?kinds=table&tenantId=other-tenant&limit=10',
      ),
    ).toMatchObject({ items: [] });
    expect(
      await getJson(started.url, `/v1/database/resources/${encodeURIComponent(tableId)}`),
    ).toMatchObject({ canonicalName: 'orders' });
    expect(
      await getJson(started.url, `/v1/database/resources/${encodeURIComponent(tableId)}/relations`),
    ).toEqual([expect.objectContaining({ kind: 'contains' })]);
    expect(
      await getJson(started.url, '/v1/resources?kinds=table&engine=api-mock&limit=10'),
    ).toMatchObject({
      items: [expect.objectContaining({ id: tableId, kind: 'table' })],
    });
    expect(
      await getJson(started.url, `/v1/resources/${encodeURIComponent(tableId)}`),
    ).toMatchObject({ canonicalName: 'orders' });
    expect(
      await getJson(
        started.url,
        `/v1/resources/${encodeURIComponent(tableId)}/relations?direction=incoming`,
      ),
    ).toEqual([expect.objectContaining({ kind: 'contains' })]);
    const traversal = await postJson(started.url, '/v1/resources/traverse', {
      startResourceIds: [tableId],
      direction: 'incoming',
      relationKinds: ['contains'],
      maxDepth: 1,
      maxResources: 10,
    });
    const traversalNodes = requireTestArray(traversal.nodes, 'traversal.nodes');
    const firstNode = requireTestRecord(traversalNodes[0], 'traversal.nodes[0]');
    const secondNode = requireTestRecord(traversalNodes[1], 'traversal.nodes[1]');
    expect(requireTestRecord(firstNode.resource, 'firstNode.resource').id).toBe(tableId);
    expect(firstNode.depth).toBe(0);
    expect(requireTestRecord(secondNode.resource, 'secondNode.resource').kind).toBe('database');
    expect(secondNode.depth).toBe(1);
    const traversalRelations = requireTestArray(traversal.relations, 'traversal.relations');
    expect(requireTestRecord(traversalRelations[0], 'traversal.relations[0]').kind).toBe(
      'contains',
    );
    expect(traversal.truncated).toBe(false);
    expect(
      await getJson(started.url, `/v1/resources/${encodeURIComponent(tableId)}/state`),
    ).toMatchObject({
      resourceId: tableId,
      status: 'unknown',
      freshness: 'unknown',
    });
    const events = await getJson(
      started.url,
      `/v1/resource-events?resourceId=${encodeURIComponent(tableId)}&limit=10`,
    );
    expect(
      requireTestArray(events.items, 'events.items').some(
        (item) => requireTestRecord(item, 'events.items[]').type === 'resource-created',
      ),
    ).toBe(true);
    const invalidTraversal = await fetch(`${started.url}/v1/resources/traverse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        startResourceIds: [tableId],
        maxDepth: 33,
        maxResources: 10,
      }),
    });
    expect(invalidTraversal.status).toBe(400);
    expect(await invalidTraversal.json()).toMatchObject({
      error: { code: 'TRAVERSAL_LIMIT_INVALID' },
    });

    const query = await postJson(started.url, '/v1/database/queries', {
      profileId: 'api-profile',
      sql: 'select 1',
      executionMode: 'sync',
      timeoutMs: 1_000,
      params: [
        { $schemanautType: 'bigint', value: '9007199254740993' },
        { $schemanautType: 'datetime', value: '2026-07-23T00:00:00.000Z' },
        { $schemanautType: 'binary', encoding: 'base64', value: 'AP8=' },
      ],
    });
    expect(query).toMatchObject({ state: 'succeeded' });
    expect(submittedParams?.[0]).toBe(9_007_199_254_740_993n);
    expect(submittedParams?.[1]).toEqual(new Date('2026-07-23T00:00:00.000Z'));
    expect(submittedParams?.[2]).toEqual(Uint8Array.from([0, 255]));
    const jobId = query.id as string;
    const handleId = (query.result as { id: string }).id;
    expect(await getJson(started.url, `/v1/database/queries/${jobId}`)).toMatchObject({
      id: jobId,
    });
    expect(await getJson(started.url, `/v1/database/results/${handleId}?limit=1`)).toMatchObject({
      rows: [
        {
          value: 1,
          big: {
            $schemanautType: 'bigint',
            value: '9007199254740993',
          },
          at: {
            $schemanautType: 'datetime',
            value: '2026-07-23T00:00:00.000Z',
          },
          binary: {
            $schemanautType: 'binary',
            encoding: 'base64',
            value: 'AP8=',
          },
        },
      ],
      complete: true,
    });

    const invalidTimeout = await fetch(`${started.url}/v1/database/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'api-profile',
        sql: 'select 1',
        executionMode: 'sync',
        timeoutMs: 0,
      }),
    });
    expect(invalidTimeout.status).toBe(400);
    expect(await invalidTimeout.json()).toMatchObject({
      error: { category: 'validation' },
    });

    const queuedResponse = await fetch(`${started.url}/v1/database/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'api-profile',
        sql: 'select 1 /* queued */',
        executionMode: 'async',
      }),
    });
    expect(queuedResponse.status).toBe(202);
    const queued = (await queuedResponse.json()) as { id: string };
    const cancelResponse = await fetch(`${started.url}/v1/database/queries/${queued.id}`, {
      method: 'DELETE',
    });
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({ state: 'cancelled' });

    const transactionResponse = await fetch(`${started.url}/v1/database/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'api-profile',
        isolationLevel: 'serializable',
      }),
    });
    expect(transactionResponse.status).toBe(201);
    const transaction = (await transactionResponse.json()) as { id: string };
    expect(
      await postJson(started.url, `/v1/database/transactions/${transaction.id}/savepoints`, {
        name: 'before_change',
      }),
    ).toMatchObject({ savepoints: ['before_change'] });
    expect(
      await postJson(
        started.url,
        `/v1/database/transactions/${transaction.id}/rollback-to-savepoint`,
        { name: 'before_change' },
      ),
    ).toMatchObject({ state: 'active' });
    expect(
      await postJson(started.url, `/v1/database/transactions/${transaction.id}/commit`, {}),
    ).toMatchObject({ state: 'committed' });

    expect(
      await postJson(started.url, '/v1/database/observations', {
        profileId: 'api-profile',
        categories: ['capacity'],
      }),
    ).toEqual([expect.objectContaining({ category: 'capacity' })]);
    expect(
      await getJson(
        started.url,
        `/v1/resources/${encodeURIComponent(
          createStableResourceId({
            sourceNamespace: 'api-test',
            kind: 'database',
            nativeId: 'demo',
          }),
        )}/state`,
      ),
    ).toMatchObject({ status: 'healthy', freshness: 'fresh' });
    expect(
      await getJson(
        started.url,
        `/v1/resources/${encodeURIComponent(
          createStableResourceId({
            sourceNamespace: 'api-test',
            kind: 'database',
            nativeId: 'demo',
          }),
        )}/observations?category=capacity`,
      ),
    ).toEqual([expect.objectContaining({ id: 'api-observation' })]);

    const unauthorized = await fetch(`${started.url}/v1/database/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'api-profile', operation: 'analyze' }),
    });
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: 'OPERATION_APPROVAL_REQUIRED' },
    });
    expect(
      await postJson(started.url, '/v1/database/operations', {
        profileId: 'api-profile',
        operation: 'analyze',
        authorization: { approvalId: 'approval-1' },
      }),
    ).toMatchObject({ status: 'succeeded' });
    expect(await getJson(started.url, '/v1/database/metrics')).toMatchObject({
      profiles: 1,
      connectedSessions: 1,
      resources: 2,
    });
    expect(await getJson(started.url, '/v1/database/audit?profileId=api-profile')).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'database.operation.analyze' })]),
    );

    expect(await postJson(started.url, '/v1/database/profiles/api-profile/disconnect', {})).toEqual(
      { disconnected: true },
    );
    const deleted = await fetch(`${started.url}/v1/database/profiles/api-profile`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
  });
});

async function getJson(baseUrl: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as Record<string, unknown>;
}

async function postChunkedJson(
  baseUrl: string,
  path: string,
  firstChunk: string,
  secondChunk: string,
): Promise<Record<string, unknown>> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (rawChunk: unknown) => {
          const chunk =
            typeof rawChunk === 'string'
              ? Buffer.from(rawChunk)
              : rawChunk instanceof Uint8Array
                ? Buffer.from(rawChunk)
                : Buffer.from(String(rawChunk));
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            expect(response.statusCode).toBe(200);
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on('error', reject);
    request.write(firstChunk);
    request.end(secondChunk);
  });
}

async function rawHttpRequest(
  baseUrl: string,
  options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (rawChunk: unknown) => {
          const chunk =
            typeof rawChunk === 'string'
              ? Buffer.from(rawChunk)
              : rawChunk instanceof Uint8Array
                ? Buffer.from(rawChunk)
                : Buffer.from(String(rawChunk));
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode ?? 0,
              text,
              json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

function requireTestRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireTestArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  return value;
}

function fakeProviderFactory(): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake',
    mode: 'byok',
    chat() {
      return Promise.resolve({ text: '', toolCalls: [] });
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

class FakeRuntime implements DatabaseAgentRuntimePort {
  private configured = false;
  private connected = false;
  private indexed = false;
  private readonly runs = new Map<string, SqlRunSnapshot>();
  private sessionDeleted = false;
  private readonly mcpServers = new Map<string, McpServerSummary>();
  private readonly pendingApprovals = new Map<string, AgentApprovalRequest>([
    [
      'approval-1',
      {
        id: 'approval-1',
        status: 'pending',
        mode: 'read',
        sessionId: 'api-session',
        toolCallId: 'tool-call-1',
        toolName: 'sql_execute',
        dangerLevel: 'medium',
        readonly: false,
        argumentPreview: '{"sql":"UPDATE orders SET status = \\"paid\\""}',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      },
    ],
  ]);
  lastIndexOptions: IndexSchemaOptions | undefined;
  lastAgentInput?: RunAiSqlAgentInput;
  generateError?: Error;
  mcpUpsertCalls = 0;
  mcpStartCalls = 0;

  configureProvider(): void {
    this.configured = true;
  }

  connect(input: PostgresConnectionInput): Promise<SavedConnection> {
    this.connected = true;
    return Promise.resolve({
      id: 'connection-1',
      name: input.name ?? 'demo',
      engine: 'postgres',
      host: input.host,
      port: input.port ?? 5432,
      database: input.database,
      username: input.username,
      readOnly: true,
      status: 'connected',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
  }

  disconnect(): Promise<void> {
    this.connected = false;
    this.indexed = false;
    return Promise.resolve();
  }

  indexSchema(options?: IndexSchemaOptions): Promise<SchemaIndexSnapshot> {
    this.lastIndexOptions = options;
    this.indexed = true;
    return Promise.resolve(this.schemaStatus());
  }

  schemaStatus(): SchemaIndexSnapshot {
    return this.indexed
      ? {
          connectionId: 'connection-1',
          stage: 'ready',
          ready: true,
          tableCount: 2,
          columnCount: 5,
          relationCount: 1,
          documentCount: 8,
          truncated: false,
          indexedAt: '2026-07-21T00:00:00.000Z',
        }
      : {
          ...(this.connected ? { connectionId: 'connection-1' } : {}),
          stage: this.connected ? 'not_indexed' : 'not_connected',
          ready: false,
          tableCount: 0,
          columnCount: 0,
          relationCount: 0,
          documentCount: 0,
          truncated: false,
        };
  }

  status(): RuntimeStatus {
    return {
      providerConfigured: this.configured,
      connected: this.connected,
      schema: this.schemaStatus(),
      runCount: this.runs.size,
      llm: {
        modelCount: 0,
        metrics: {
          requests: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          cacheHits: 0,
          retries: 0,
          fallbacks: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCost: 0,
          latencyMs: { p50: 0, p95: 0, p99: 0, max: 0 },
          byModel: {},
        },
      },
    };
  }

  async runAgent(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun> {
    this.lastAgentInput = input;
    await input.onEvent?.({
      id: 'event-1',
      sessionId: 'api-session',
      type: 'plan-updated',
      message: '已制定查询计划。',
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    return {
      activatedSkills: ['query-and-answer'],
      queryResults: [],
      result: {
        runId: 'agent-run-1',
        status: 'done',
        session: fakeAgentSession(),
        finalText: '已继续分析。',
        iterations: 1,
        toolExecutions: [],
        completion: {
          verified: true,
          deliveryReady: true,
          finalResponseReady: true,
          phase: 'done',
          unresolvedTaskIds: [],
          missing: [],
          evidenceKinds: [],
        },
      },
    };
  }

  getAgentRun(runId: string): Promise<AgentRunRecord | undefined> {
    return Promise.resolve(runId === 'agent-run-1' ? fakeAgentRunRecord() : undefined);
  }

  listAgentRuns(sessionId?: string, limit?: number): Promise<AgentRunRecord[]> {
    void limit;
    return Promise.resolve(
      sessionId === undefined || sessionId === 'api-session' ? [fakeAgentRunRecord()] : [],
    );
  }

  steerAgentSession(sessionId: string, message: string): boolean {
    return sessionId === 'api-session' && message.length > 0;
  }

  listAgentSessions(input: AgentSessionListInput = {}): Promise<AgentSessionListItem[]> {
    void input;
    if (this.sessionDeleted) return Promise.resolve([]);
    return Promise.resolve([
      {
        id: 'api-session',
        title: 'API Agent Session',
        mode: 'read',
        archived: false,
        conversationMessageCount: 2,
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:01.000Z',
        lastMessageAt: '2026-07-24T00:00:01.000Z',
      },
    ]);
  }

  getAgentSession(sessionId: string): Promise<AgentSessionView | undefined> {
    const publicView = toAgentSessionView(fakeAgentSession());
    return Promise.resolve(
      sessionId === 'api-session' && !this.sessionDeleted
        ? Object.assign(publicView, {
            knowledgeSnapshot: { catalogRootHash: 'must-not-leak' },
            activeTools: ['internal-tool'],
          })
        : undefined,
    );
  }

  deleteAgentSession(sessionId: string): Promise<boolean> {
    if (sessionId !== 'api-session' || this.sessionDeleted) {
      return Promise.resolve(false);
    }
    this.sessionDeleted = true;
    return Promise.resolve(true);
  }

  listAgentSkills(): Promise<AgentSkillCatalogEntry[]> {
    return Promise.resolve([
      {
        name: 'query-and-answer',
        description: 'Generate and run a database query.',
        scope: 'system',
      },
    ]);
  }

  refreshSkills(): Promise<AgentSkillRefreshResult> {
    return Promise.resolve({
      changed: true,
      revision: 2,
      skills: [
        {
          name: 'query-and-answer',
          description: 'Generate and run a database query.',
          scope: 'system',
        },
      ],
      issues: [],
      conflicts: [],
    });
  }

  listAgentApprovals(): AgentApprovalRequest[] {
    return [...this.pendingApprovals.values()];
  }

  resolveAgentApproval(requestId: string, approved: boolean): boolean {
    void approved;
    return this.pendingApprovals.delete(requestId);
  }

  listMcpServers(): Promise<McpServerSummary[]> {
    return Promise.resolve([...this.mcpServers.values()]);
  }

  upsertMcpServer(input: McpServerRegistrationInput): Promise<McpServerSummary> {
    this.mcpUpsertCalls += 1;
    const server: McpServerSummary = {
      id: input.id ?? 'company-tools',
      name: input.name,
      source: input.source ?? 'user',
      transport: input.transport ?? 'stdio',
      enabled: input.enabled ?? true,
      autoStart: input.autoStart ?? false,
      running: false,
      status: 'stopped',
      healthy: false,
      warnings: [],
    };
    this.mcpServers.set(server.id, server);
    return Promise.resolve(server);
  }

  removeMcpServer(serverId: string): Promise<boolean> {
    return Promise.resolve(this.mcpServers.delete(serverId));
  }

  startMcpServer(serverId: string): Promise<McpServerStartSummary> {
    this.mcpStartCalls += 1;
    const current = this.mcpServers.get(serverId)!;
    const server = {
      ...current,
      running: true,
      status: 'healthy' as const,
      healthy: true,
    };
    this.mcpServers.set(serverId, server);
    return Promise.resolve({
      server,
      tools: [`mcp__${serverId}__lookup`],
    });
  }

  stopMcpServer(serverId: string): Promise<McpServerStopSummary> {
    const current = this.mcpServers.get(serverId);
    if (current) {
      this.mcpServers.set(serverId, {
        ...current,
        running: false,
        status: 'stopped',
        healthy: false,
      });
    }
    return Promise.resolve({
      serverId,
      removedTools: [`mcp__${serverId}__lookup`],
      status: 'stopped',
    });
  }

  compactAgentSession(
    input: CompactAiSqlAgentSessionInput,
  ): Promise<CompactAiSqlAgentSessionResult> {
    const checkpoint = fakeContextCheckpoint(input.focus);
    return Promise.resolve({
      status: 'compacted',
      session: fakeAgentSession(checkpoint),
      report: {
        phase: 'compacted',
        level: 'conversation-checkpoint',
        trigger: 'manual',
        originalTokenEstimate: 20_000,
        finalTokenEstimate: 2_000,
        modelContextTokens: 32_768,
        reservedOutputTokens: 4_096,
        availablePromptTokens: 28_672,
        warningThresholdTokens: 20_070,
        compactionThresholdTokens: 24_371,
        retainedMessageCount: 4,
        toolCount: 6,
        coveredConversationMessageCount: 12,
        maskedToolResultCount: 2,
        activeCheckpointSequence: 1,
        summaryTokenEstimate: 300,
        steps: [
          {
            type: 'conversation-checkpoint',
            beforeTokenEstimate: 20_000,
            afterTokenEstimate: 2_000,
            affectedMessageCount: 12,
          },
        ],
        warnings: [],
      },
      checkpoint,
    });
  }

  agentContextCheckpoints(): Promise<AgentContextCheckpoint[]> {
    return Promise.resolve([fakeContextCheckpoint('保留 SQL 和精确结果')]);
  }

  generate(): Promise<GeneratedSqlRun> {
    if (this.generateError) return Promise.reject(this.generateError);
    const run: GeneratedSqlRun = {
      runId: 'run-1',
      connectionId: 'connection-1',
      executionResultAvailable: false,
      status: 'awaiting_execution',
      question: '每个城市的订单金额是多少？',
      sql: 'select city, sum(amount) as total from orders group by city',
      explanation: '按城市汇总订单金额',
      assumptions: [],
      evidence: [{ title: 'public.orders', kind: 'table', reasons: ['keyword'] }],
      safety: {
        statementKind: 'SELECT',
        riskLevel: 'safe',
        requiresConfirmation: false,
        blocked: false,
        reasons: [],
      },
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    this.runs.set(run.runId, run);
    return Promise.resolve(run);
  }

  executeGenerated(runId: string): Promise<ExecutedSqlRun> {
    const generated = this.runs.get(runId)!;
    const executed: ExecutedSqlRun = {
      runId: generated.runId,
      connectionId: generated.connectionId,
      executionResultAvailable: true,
      status: 'completed',
      question: generated.question,
      sql: generated.sql,
      explanation: generated.explanation,
      assumptions: generated.assumptions,
      evidence: generated.evidence,
      safety: generated.safety,
      createdAt: generated.createdAt,
      execution: {
        queryId: 'query-1',
        columns: [
          { name: 'city', dataType: 'text' },
          { name: 'total', dataType: 'numeric' },
        ],
        rows: [{ city: 'Shanghai', total: 188 }],
        rowCount: 1,
        returnedRowCount: 1,
        elapsedMs: 4,
        safety: generated.safety,
      },
      updatedAt: '2026-07-21T00:00:01.000Z',
    };
    this.runs.set(runId, executed);
    return Promise.resolve(executed);
  }

  reexecuteGenerated(runId: string): Promise<ExecutedSqlRun> {
    return this.executeGenerated(runId);
  }

  getRun(runId: string): SqlRunSnapshot | undefined {
    return this.runs.get(runId);
  }
}

function fakeAgentRunRecord(): AgentRunRecord {
  return {
    runId: 'agent-run-1',
    sessionId: 'api-session',
    status: 'done',
    phase: 'done',
    iteration: 1,
    finalText: '已继续分析。',
    toolExecutions: [
      {
        toolName: 'sql_execute',
        status: 'success',
        completionEvidence: { kind: 'database-result', deliveryReady: true },
      },
    ],
    completion: {
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'done',
      unresolvedTaskIds: [],
      missing: [],
      evidenceKinds: ['database-result'],
    },
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:01.000Z',
  };
}

function fakeAgentSession(
  contextCheckpoint?: AgentContextCheckpoint,
): AiSqlAgentRun['result']['session'] {
  return {
    id: 'api-session',
    title: 'API Agent Session',
    mode: 'read',
    messages: [
      {
        role: 'user',
        content: '继续分析订单',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'sql_execute',
            arguments: { sql: 'SELECT * FROM orders' },
          },
        ],
        createdAt: '2026-07-24T00:00:00.500Z',
      },
      {
        role: 'tool',
        toolCallId: 'tool-call-1',
        toolName: 'sql_execute',
        content: '{"internalNodeId":"node-1","rows":[{"id":1}]}',
        createdAt: '2026-07-24T00:00:00.750Z',
      },
      {
        role: 'assistant',
        content: '让我继续验证查询结果。',
        createdAt: '2026-07-24T00:00:00.900Z',
      },
      {
        role: 'assistant',
        content: '已继续分析。',
        createdAt: '2026-07-24T00:00:01.000Z',
      },
    ],
    tokenUsage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    },
    activeTools: ['sql_execute', 'tool_search'],
    activeSkills: [
      {
        name: 'query-and-answer',
        description: 'Generate and run a database query.',
        scope: 'system',
        instructions: 'Internal Skill workflow that must not be returned.',
      },
    ],
    knowledgeSnapshot: {
      connectionId: 'connection-1',
      knowledgeSnapshotId: 'snapshot-internal',
      catalogRootHash: 'private-root-hash',
      retrievalProfileId: 'profile-internal',
      indexVersion: 'version-internal',
    },
    taskPlan: {
      version: 1,
      goal: '完成订单分析',
      tasks: [
        {
          id: 'query',
          title: '执行查询',
          status: 'in_progress',
          acceptanceCriteria: ['返回数据库结果'],
          dependsOn: [],
          evidence: [
            {
              kind: 'database-result',
              summary: 'internal evidence',
              reference: 'result-handle-must-not-leak',
              createdAt: '2026-07-24T00:00:00.000Z',
            },
          ],
          createdAt: '2026-07-24T00:00:00.000Z',
          updatedAt: '2026-07-24T00:00:01.000Z',
        },
      ],
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:01.000Z',
    },
    ...(contextCheckpoint === undefined ? {} : { contextCheckpoint }),
    aborted: false,
  };
}

function fakeContextCheckpoint(focus?: string): AgentContextCheckpoint {
  return {
    version: 1,
    sequence: 1,
    trigger: 'manual',
    method: 'model',
    summary: '已完成订单分析。',
    coveredConversationMessageCount: 12,
    sourceTokenEstimate: 20_000,
    summaryTokenEstimate: 300,
    modelContextTokens: 32_768,
    createdAt: '2026-07-24T00:00:00.000Z',
    ...(focus === undefined ? {} : { focus }),
  };
}

function createApiTestConnector(
  onSubmit?: (params: readonly unknown[] | undefined) => void,
): DatabaseConnector {
  const observedAt = '2026-07-23T00:00:00.000Z';
  const databaseId = createStableResourceId({
    sourceNamespace: 'api-test',
    kind: 'database',
    nativeId: 'demo',
  });
  const tableId = createStableResourceId({
    sourceNamespace: 'api-test',
    kind: 'table',
    nativeId: 'demo.orders',
  });
  const source = {
    sourceId: 'api-test',
    sourceType: 'connector' as const,
    connectorId: 'api-test',
    observedAt,
  };
  const capabilityKeys = [
    DATABASE_CAPABILITIES.SQL_QUERY,
    DATABASE_CAPABILITIES.QUERY_ASYNC,
    DATABASE_CAPABILITIES.TRANSACTION,
    DATABASE_CAPABILITIES.OPERATE_ANALYZE,
  ];
  const capabilities = Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      {
        key,
        status: 'supported',
        source: 'api-test',
        observedAt,
      } satisfies CapabilityDescriptor,
    ]),
  );
  const jobs = new Map<string, QueryJob>();
  return {
    manifest: {
      id: 'api-test',
      displayName: 'API Test Connector',
      version: '1',
      engine: 'api-mock',
      transports: ['tcp'],
      execution: 'hybrid',
      capabilities,
      operations: [
        {
          key: 'analyze',
          title: 'Analyze',
          description: 'Test operation',
          risk: 'write',
          idempotent: true,
          requiredCapability: DATABASE_CAPABILITIES.OPERATE_ANALYZE,
        },
      ],
    },
    test() {
      return Promise.resolve({
        connectorId: 'api-test',
        engine: 'api-mock',
        status: 'healthy',
        checkedAt: observedAt,
        latencyMs: 1,
      });
    },
    connect(context) {
      return Promise.resolve({
        id: 'api-session',
        connectionId: 'api-connection',
        profileId: context.profile.id,
        connectorId: 'api-test',
        status: 'connected',
        endpointIndex: 0,
        connectedAt: observedAt,
        generation: 1,
      });
    },
    disconnect() {
      return Promise.resolve();
    },
    health() {
      return Promise.resolve({ status: 'healthy', checkedAt: observedAt, latencyMs: 1 });
    },
    capabilities(context) {
      return Promise.resolve({
        connectorId: 'api-test',
        engine: 'api-mock',
        connectionProfileId: context.profile.id,
        resolvedAt: observedAt,
        capabilities,
      });
    },
    discover() {
      return Promise.resolve({
        resources: [
          {
            id: databaseId,
            kind: 'database',
            nativeId: 'demo',
            canonicalName: 'demo',
            engine: 'api-mock',
            version: 1,
            firstSeenAt: observedAt,
            updatedAt: observedAt,
            sources: [source],
          },
          {
            id: tableId,
            kind: 'table',
            nativeId: 'demo.orders',
            canonicalName: 'orders',
            engine: 'api-mock',
            version: 1,
            firstSeenAt: observedAt,
            updatedAt: observedAt,
            sources: [source],
          },
        ],
        relations: [
          {
            id: createStableRelationId({
              kind: 'contains',
              fromResourceId: databaseId,
              toResourceId: tableId,
            }),
            kind: 'contains',
            fromResourceId: databaseId,
            toResourceId: tableId,
            version: 1,
            firstSeenAt: observedAt,
            updatedAt: observedAt,
            sources: [source],
          },
        ],
        complete: true,
      });
    },
    submit(context, submission) {
      onSubmit?.(submission.params);
      const id = `job-${jobs.size + 1}`;
      const queued = submission.sql === 'select 1 /* queued */';
      const job: QueryJob = {
        id,
        profileId: context.profile.id,
        connectorId: 'api-test',
        state: queued ? 'queued' : 'succeeded',
        submittedAt: observedAt,
        ...(queued
          ? {}
          : {
              completedAt: observedAt,
              result: {
                id: `result-${id}`,
                jobId: id,
                format: 'rows',
                columns: [
                  { name: 'value', dataType: 'integer' },
                  { name: 'big', dataType: 'bigint' },
                  { name: 'at', dataType: 'timestamptz' },
                  { name: 'binary', dataType: 'bytea' },
                ],
                rowCount: 1,
              },
            }),
      };
      jobs.set(id, job);
      return Promise.resolve(job);
    },
    getJob(_context, jobId) {
      return Promise.resolve(jobs.get(jobId)!);
    },
    cancel(_context, jobId) {
      const job = { ...jobs.get(jobId)!, state: 'cancelled' as const, completedAt: observedAt };
      jobs.set(jobId, job);
      return Promise.resolve(job);
    },
    readResult(_context, handleId) {
      return Promise.resolve({
        handleId,
        rows: [
          {
            value: 1,
            big: 9_007_199_254_740_993n,
            at: new Date(observedAt),
            binary: Uint8Array.from([0, 255]),
          },
        ],
        rowOffset: 0,
        complete: true,
      });
    },
    beginTransaction(context) {
      return Promise.resolve({
        id: 'api-tx',
        profileId: context.profile.id,
        sessionId: context.session?.id ?? 'api-session',
        state: 'active',
        readOnly: false,
        startedAt: observedAt,
        savepoints: [],
      });
    },
    createSavepoint(context, transactionId, name) {
      return Promise.resolve({
        id: transactionId,
        profileId: context.profile.id,
        sessionId: 'api-session',
        state: 'active',
        readOnly: false,
        startedAt: observedAt,
        savepoints: [name],
      });
    },
    rollbackToSavepoint(context, transactionId, name) {
      return Promise.resolve({
        id: transactionId,
        profileId: context.profile.id,
        sessionId: 'api-session',
        state: 'active',
        readOnly: false,
        startedAt: observedAt,
        savepoints: [name],
      });
    },
    commitTransaction(context, transactionId) {
      return Promise.resolve({
        id: transactionId,
        profileId: context.profile.id,
        sessionId: 'api-session',
        state: 'committed',
        readOnly: false,
        startedAt: observedAt,
        completedAt: observedAt,
        savepoints: [],
      });
    },
    rollbackTransaction(context, transactionId) {
      return Promise.resolve({
        id: transactionId,
        profileId: context.profile.id,
        sessionId: 'api-session',
        state: 'rolled-back',
        readOnly: false,
        startedAt: observedAt,
        completedAt: observedAt,
        savepoints: [],
      });
    },
    observe() {
      return Promise.resolve([
        {
          id: 'api-observation',
          resourceId: databaseId,
          category: 'capacity',
          status: 'healthy',
          observedAt,
          expiresAt: '2099-01-01T00:00:00.000Z',
          source,
        },
      ]);
    },
    operate(_context, request) {
      return Promise.resolve({
        operationId: 'api-operation',
        operation: request.operation,
        status: 'succeeded',
        startedAt: observedAt,
        completedAt: observedAt,
      });
    },
  };
}
