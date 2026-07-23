import type { LlmProvider } from '@dbagent/core-llm';
import { request as httpRequest } from 'node:http';
import type { DatabaseAgentRuntimePort } from '../src/server.js';
import type {
  CapabilityDescriptor,
  DatabaseConnector,
  ExecutedSqlRun,
  GeneratedSqlRun,
  IndexSchemaOptions,
  PostgresConnectionInput,
  QueryJob,
  RuntimeStatus,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
} from '@dbagent/sdk';
import {
  DATABASE_CAPABILITIES,
  DatabaseAgentRuntime,
  createStableRelationId,
  createStableResourceId,
} from '@dbagent/sdk';
import type { SavedConnection } from '@dbagent/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startDatabaseAgentServer, type StartedDatabaseAgentServer } from '../src/index.js';

describe('DBAgent local server', () => {
  let started: StartedDatabaseAgentServer | undefined;

  afterEach(async () => {
    if (!started) return;
    await new Promise<void>((resolve) => started!.server.close(() => resolve()));
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
    expect(html).toContain('<h1>DBAgent</h1>');
    expect(html).toContain('数据库接入管理');
    expect(html).toContain('/v1/database/connectors');

    const health = await getJson(started.url, '/health');
    expect(health).toMatchObject({ status: 'ok', service: 'dbagent-server' });

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
    started = await startDatabaseAgentServer({
      port: 0,
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

  it('exposes the complete connector, profile, resource, query, transaction and operation API', async () => {
    const connector = createApiTestConnector();
    const runtime = new DatabaseAgentRuntime({ connectors: [connector] });
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
      }),
    });
    expect(createdResponse.status).toBe(201);
    expect(await createdResponse.json()).toMatchObject({ id: 'api-profile', principal: 'tester' });
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
    expect(
      await getJson(started.url, '/v1/database/profiles/api-profile/health'),
    ).toMatchObject({ status: 'healthy' });
    expect(
      await getJson(started.url, '/v1/database/profiles/api-profile/capabilities'),
    ).toMatchObject({ connectorId: 'api-test' });
    expect(
      await postJson(started.url, '/v1/database/profiles/api-profile/discover', {}),
    ).toMatchObject({ pages: 1, resources: 2, relations: 1 });

    const resources = await getJson(
      started.url,
      '/v1/database/resources?kinds=table&limit=10',
    );
    const tableId = (resources.items as Array<{ id: string }>)[0]!.id;
    expect(resources.items).toEqual([expect.objectContaining({ kind: 'table' })]);
    expect(
      await getJson(started.url, `/v1/database/resources/${encodeURIComponent(tableId)}`),
    ).toMatchObject({ canonicalName: 'orders' });
    expect(
      await getJson(
        started.url,
        `/v1/database/resources/${encodeURIComponent(tableId)}/relations`,
      ),
    ).toEqual([expect.objectContaining({ kind: 'contains' })]);
    expect(
      await getJson(
        started.url,
        '/v1/resources?kinds=table&engine=api-mock&limit=10',
      ),
    ).toMatchObject({
      items: [expect.objectContaining({ id: tableId, kind: 'table' })],
    });
    expect(
      await getJson(
        started.url,
        `/v1/resources/${encodeURIComponent(tableId)}`,
      ),
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
    expect(requireTestRecord(secondNode.resource, 'secondNode.resource').kind).toBe(
      'database',
    );
    expect(secondNode.depth).toBe(1);
    const traversalRelations = requireTestArray(
      traversal.relations,
      'traversal.relations',
    );
    expect(
      requireTestRecord(traversalRelations[0], 'traversal.relations[0]').kind,
    ).toBe('contains');
    expect(traversal.truncated).toBe(false);
    expect(
      await getJson(
        started.url,
        `/v1/resources/${encodeURIComponent(tableId)}/state`,
      ),
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
        (item) =>
          requireTestRecord(item, 'events.items[]').type === 'resource-created',
      ),
    ).toBe(true);
    const invalidTraversal = await fetch(
      `${started.url}/v1/resources/traverse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          startResourceIds: [tableId],
          maxDepth: 33,
          maxResources: 10,
        }),
      },
    );
    expect(invalidTraversal.status).toBe(400);
    expect(await invalidTraversal.json()).toMatchObject({
      error: { code: 'TRAVERSAL_LIMIT_INVALID' },
    });

    const query = await postJson(started.url, '/v1/database/queries', {
      profileId: 'api-profile',
      sql: 'select 1',
      executionMode: 'sync',
      timeoutMs: 1_000,
    });
    expect(query).toMatchObject({ state: 'succeeded' });
    const jobId = query.id as string;
    const handleId = (query.result as { id: string }).id;
    expect(await getJson(started.url, `/v1/database/queries/${jobId}`)).toMatchObject({
      id: jobId,
    });
    expect(
      await getJson(started.url, `/v1/database/results/${handleId}?limit=1`),
    ).toMatchObject({
      rows: [
        {
          value: 1,
          big: {
            $dbagentType: 'bigint',
            value: '9007199254740993',
          },
          at: {
            $dbagentType: 'datetime',
            value: '2026-07-23T00:00:00.000Z',
          },
          binary: {
            $dbagentType: 'binary',
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
        sql: 'queued',
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
      await postJson(
        started.url,
        `/v1/database/transactions/${transaction.id}/savepoints`,
        { name: 'before_change' },
      ),
    ).toMatchObject({ savepoints: ['before_change'] });
    expect(
      await postJson(
        started.url,
        `/v1/database/transactions/${transaction.id}/rollback-to-savepoint`,
        { name: 'before_change' },
      ),
    ).toMatchObject({ state: 'active' });
    expect(
      await postJson(
        started.url,
        `/v1/database/transactions/${transaction.id}/commit`,
        {},
      ),
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

    expect(
      await postJson(started.url, '/v1/database/profiles/api-profile/disconnect', {}),
    ).toEqual({ disconnected: true });
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
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
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

function requireTestRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
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
  lastIndexOptions?: IndexSchemaOptions;

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
    };
  }

  generate(): Promise<GeneratedSqlRun> {
    const run: GeneratedSqlRun = {
      runId: 'run-1',
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
      ...generated,
      status: 'completed',
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

  getRun(runId: string): SqlRunSnapshot | undefined {
    return this.runs.get(runId);
  }
}

function createApiTestConnector(): DatabaseConnector {
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
      const id = `job-${jobs.size + 1}`;
      const queued = submission.sql === 'queued';
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
