import type { LlmProvider } from '@dbagent/core-llm';
import { request as httpRequest } from 'node:http';
import type { DatabaseAgentRuntimePort } from '../src/server.js';
import type {
  ExecutedSqlRun,
  GeneratedSqlRun,
  IndexSchemaOptions,
  PostgresConnectionInput,
  RuntimeStatus,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
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
    expect(await page.text()).toContain('DBAgent Headless MVP');

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

  it('refuses non-loopback listening addresses in the MVP', async () => {
    await expect(startDatabaseAgentServer({ host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
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
