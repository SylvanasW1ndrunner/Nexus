import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OpenAICompatibleProvider, type LlmProvider } from '@dbagent/core-llm';
import {
  DatabaseAgentError,
  DatabaseAgentRuntime,
  asDatabaseAgentError,
  type ExecuteGeneratedOptions,
  type GenerateSqlInput,
  type GeneratedSqlRun,
  type IndexSchemaOptions,
  type PostgresConnectionInput,
  type RuntimeStatus,
  type SchemaIndexSnapshot,
  type SqlRunSnapshot,
  type ExecutedSqlRun,
} from '@dbagent/sdk';
import type { SavedConnection } from '@dbagent/shared';
import { WEB_UI_HTML } from './web-ui.js';

const MAX_BODY_BYTES = 1_048_576;
export const DEFAULT_SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 3721;

export type LlmSetupInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type DatabaseAgentRuntimePort = {
  configureProvider(provider: LlmProvider, model: string): void;
  connect(input: PostgresConnectionInput): Promise<SavedConnection>;
  disconnect(): Promise<void>;
  indexSchema(options?: IndexSchemaOptions): Promise<SchemaIndexSnapshot>;
  schemaStatus(): SchemaIndexSnapshot;
  status(): RuntimeStatus;
  generate(input: GenerateSqlInput): Promise<GeneratedSqlRun>;
  executeGenerated(runId: string, options?: ExecuteGeneratedOptions): Promise<ExecutedSqlRun>;
  getRun(runId: string): SqlRunSnapshot | undefined;
};

export type DatabaseAgentServerOptions = {
  runtime?: DatabaseAgentRuntimePort;
  createProvider?: (input: LlmSetupInput) => LlmProvider;
};

export type StartDatabaseAgentServerOptions = DatabaseAgentServerOptions & {
  host?: string;
  port?: number;
};

export type StartedDatabaseAgentServer = {
  server: Server;
  runtime: DatabaseAgentRuntimePort;
  host: string;
  port: number;
  url: string;
};

export function createDatabaseAgentServer(options: DatabaseAgentServerOptions = {}): {
  server: Server;
  runtime: DatabaseAgentRuntimePort;
} {
  const runtime = options.runtime ?? new DatabaseAgentRuntime();
  const createProvider = options.createProvider ?? defaultProviderFactory;
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime, createProvider);
  });
  server.on('close', () => {
    void runtime.disconnect().catch(() => undefined);
  });
  return { server, runtime };
}

export async function startDatabaseAgentServer(
  options: StartDatabaseAgentServerOptions = {},
): Promise<StartedDatabaseAgentServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DatabaseAgentError('INVALID_INPUT', 'port 必须是 0 到 65535 之间的整数。');
  }
  const { server, runtime } = createDatabaseAgentServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  return {
    server,
    runtime,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DatabaseAgentRuntimePort,
  createProvider: (input: LlmSetupInput) => LlmProvider,
): Promise<void> {
  setSecurityHeaders(response);
  try {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (method === 'GET' && url.pathname === '/') {
      sendHtml(response, WEB_UI_HTML);
      return;
    }
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'dbagent-server', version: '0.1.0' });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/capabilities') {
      sendJson(response, 200, {
        databases: ['postgres'],
        llmProtocols: ['openai-compatible'],
        surfaces: ['typescript-sdk', 'rest', 'cli', 'webui'],
        safety: { readOnly: true, generatedSqlOnly: true, explicitExecution: true },
        limits: { defaultRows: 200, maxRows: 1000, maxRequestBytes: MAX_BODY_BYTES },
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/status') {
      sendJson(response, 200, runtime.status());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/setup') {
      const body = requireRecord(await readJson(request), 'request');
      const llm = parseLlmSetup(requireRecord(body.llm, 'llm'));
      const database = parseDatabaseSetup(requireRecord(body.database, 'database'));
      runtime.configureProvider(createProvider(llm), llm.model);
      const connection = await runtime.connect(database);
      sendJson(response, 200, {
        provider: { protocol: 'openai-compatible', model: llm.model },
        connection,
        schema: runtime.schemaStatus(),
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/schema/index') {
      const body = await readOptionalJson(request);
      const maxTables = optionalInteger(body, 'maxTables');
      const result = await runtime.indexSchema(maxTables === undefined ? {} : { maxTables });
      sendJson(response, 200, result);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/schema/status') {
      sendJson(response, 200, runtime.schemaStatus());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query/generate') {
      const body = requireRecord(await readJson(request), 'request');
      const question = requireString(body, 'question');
      const maxContextChars = optionalInteger(body, 'maxContextChars');
      const result = await runtime.generate({
        question,
        ...(maxContextChars === undefined ? {} : { maxContextChars }),
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query/execute') {
      const body = requireRecord(await readJson(request), 'request');
      const runId = requireString(body, 'runId');
      const limit = optionalInteger(body, 'limit');
      const result = await runtime.executeGenerated(runId, limit === undefined ? {} : { limit });
      sendJson(response, 200, result);
      return;
    }
    const runMatch = method === 'GET' ? url.pathname.match(/^\/v1\/runs\/([^/]+)$/) : null;
    if (runMatch?.[1]) {
      const run = runtime.getRun(decodeURIComponent(runMatch[1]));
      if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。');
      sendJson(response, 200, run);
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: '接口不存在。', retryable: false },
    });
  } catch (error) {
    const normalized = asDatabaseAgentError(error);
    sendJson(response, statusForError(normalized), {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    });
  }
}

function defaultProviderFactory(input: LlmSetupInput): LlmProvider {
  return new OpenAICompatibleProvider({
    id: 'mvp-openai-compatible',
    name: 'MVP OpenAI-compatible',
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
}

function parseLlmSetup(input: Record<string, unknown>): LlmSetupInput {
  return {
    baseUrl: requireString(input, 'baseUrl'),
    apiKey: requireString(input, 'apiKey'),
    model: requireString(input, 'model'),
  };
}

function parseDatabaseSetup(input: Record<string, unknown>): PostgresConnectionInput {
  const port = optionalInteger(input, 'port');
  const ssl = optionalBoolean(input, 'ssl');
  const password = optionalString(input, 'password');
  const name = optionalString(input, 'name');
  return {
    host: requireString(input, 'host'),
    database: requireString(input, 'database'),
    username: requireString(input, 'username'),
    ...(name === undefined ? {} : { name }),
    ...(port === undefined ? {} : { port }),
    ...(password === undefined ? {} : { password }),
    ...(ssl === undefined ? {} : { ssl }),
  };
}

async function readOptionalJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (!text.trim()) return {};
  return requireRecord(parseJson(text), 'request');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const text = await readBody(request);
  if (!text.trim()) throw new DatabaseAgentError('INVALID_INPUT', '请求体不能为空。');
  return parseJson(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DatabaseAgentError('INVALID_INPUT', '请求体超过 1 MB 限制。');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DatabaseAgentError('INVALID_INPUT', '请求体不是有效 JSON。');
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 不能为空。`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是字符串。`);
  }
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是整数。`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是布尔值。`);
  }
  return value;
}

function statusForError(error: DatabaseAgentError): number {
  switch (error.code) {
    case 'RUN_NOT_FOUND':
      return 404;
    case 'NOT_CONFIGURED':
    case 'SCHEMA_NOT_INDEXED':
    case 'RUN_NOT_EXECUTABLE':
      return 409;
    case 'CONNECTION_FAILED':
    case 'LLM_REQUEST_FAILED':
    case 'QUERY_FAILED':
      return 502;
    case 'ABORTED':
      return 408;
    case 'INVALID_INPUT':
    case 'LLM_RESPONSE_INVALID':
    case 'SQL_BLOCKED':
      return 400;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 500;
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value, jsonReplacer));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
}

function assertLoopbackHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized !== '127.0.0.1' && normalized !== '::1' && normalized !== 'localhost') {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'MVP Server 只允许监听 127.0.0.1、::1 或 localhost。',
      false,
    );
  }
}
