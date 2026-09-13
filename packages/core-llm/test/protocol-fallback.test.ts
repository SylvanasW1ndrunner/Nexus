import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  modelGatewayToProviderError,
  type CanonicalModelRequest,
  type CanonicalModelTool,
  type ModelSessionBundle,
} from '../src/index.js';

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('protocol fallback', () => {
  it('tries the next protocol once after a deterministic 404 before any response event', async () => {
    const fixture = await endpointFixture({ chatStatus: 404 });
    const configured = await configuredManager(fixture.url);
    const { result, bundle } = await executeCanonical(configured, request('hello'), true);

    expect(result.attempt.blocks).toContainEqual({ type: 'text', text: 'responses fallback' });
    expect(protocolAttempts(bundle, result)).toEqual(['openai-chat', 'openai-responses']);
    expect(fixture.requests.chat).toBe(1);
    expect(fixture.requests.responses).toBe(1);
  });

  it.each([401, 429])('does not change protocol after HTTP %s', async (status) => {
    const fixture = await endpointFixture({ chatStatus: status });
    const configured = await configuredManager(fixture.url);

    await expect(executeCanonical(configured, request('hello'))).rejects.toBeDefined();

    expect(fixture.requests.chat).toBeGreaterThanOrEqual(1);
    expect(fixture.requests.responses).toBe(0);
  });

  it('does not switch protocol for a rejected generation parameter', async () => {
    const fixture = await endpointFixture({ chatStatus: 400, error: 'temperature is not supported' });
    const configured = await configuredManager(fixture.url);

    await expect(executeCanonical(configured, request('hello'), false, {
      temperature: 0.5,
    })).rejects.toSatisfy((error: unknown) =>
      modelGatewayToProviderError(error).code === 'LLM_PARAMETER_UNSUPPORTED');
    expect(fixture.requests.responses).toBe(0);
  });

  it('preserves textual tool-like markup as ordinary model text without changing protocol', async () => {
    const fixture = await endpointFixture({
      chatStatus: 200,
      chatText: '<tool_calls>[{"name":"lookup","arguments":{}}]</tool_calls>',
    });
    const configured = await configuredManager(fixture.url);
    const tools: CanonicalModelTool[] = [{
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object', additionalProperties: false },
    }];

    const { result, bundle } = await executeCanonical(configured, {
      ...request('use lookup'),
      tools,
    });
    expect(result.attempt.blocks).toEqual([{
      type: 'text',
      text: '<tool_calls>[{"name":"lookup","arguments":{}}]</tool_calls>',
    }]);
    expect(protocolAttempts(bundle, result)).toEqual(['openai-chat']);
    expect(fixture.requests.responses).toBe(0);
  });

  it('locks the protocol after the first stream event even when the stream later fails', async () => {
    const fixture = await endpointFixture({ chatStatus: 200, brokenStream: true });
    const configured = await configuredManager(fixture.url);

    await expect(executeCanonical(configured, request('stream'), false, {}, true))
      .rejects.toBeDefined();

    // The canonical Gateway keeps stream events tentative until terminal validation.
    expect(fixture.requests.responses).toBe(0);
  });
});

type FixtureOptions = {
  chatStatus: number;
  error?: string;
  chatText?: string;
  brokenStream?: boolean;
};

async function endpointFixture(options: FixtureOptions): Promise<{
  url: string;
  requests: { chat: number; responses: number };
}> {
  const requests = { chat: 0, responses: 0 };
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    if (request.method === 'GET') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    if (request.url === '/v1/chat/completions') {
      requests.chat += 1;
      if (options.brokenStream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        setTimeout(() => response.destroy(new Error('fixture stream failure')), 5);
        return;
      }
      response.statusCode = options.chatStatus;
      response.setHeader('content-type', 'application/json');
      if (options.chatStatus !== 200) {
        response.end(JSON.stringify({ error: { message: options.error ?? `HTTP ${options.chatStatus}` } }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { content: options.chatText ?? 'chat response' }, finish_reason: 'stop' }],
      }));
      return;
    }
    if (request.url === '/v1/responses') {
      requests.responses += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: 'response-id',
        model: 'test-model',
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'responses fallback' }],
        }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind to TCP.');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function configuredManager(endpoint: string) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-protocol-fallback-'));
  directories.push(cacheDirectory);
  const manager = new LlmConnectionManager({
    cacheDirectory,
    providerTimeoutMs: 200,
  });
  const [connection] = manager.replaceConnections([{ endpoint, apiKey: 'fixture-key' }]);
  const discovery = await manager.discover(connection!.id);
  return {
    manager,
    discovery,
    selection: { connectionId: connection!.id, modelId: 'test-model' },
  };
}

async function executeCanonical(
  configured: Awaited<ReturnType<typeof configuredManager>>,
  canonicalRequest: CanonicalModelRequest,
  allowFallback = false,
  generation: { temperature?: number } = {},
  streaming = false,
) {
  const allowedFallbackRouteIds = allowFallback
    ? configured.discovery.alternatives.map((resolution) =>
        `${resolution.connectionId}:${canonicalRequest.model}:${resolution.pluginId}:${resolution.revision}`)
    : [];
  const bundle = await configured.manager.prepareModelSessionBundle(configured.selection, {
    allowedFallbackRouteIds,
    generation,
    streaming,
  });
  const result = await new ModelExecutionGateway().executeAttempt(bundle, canonicalRequest, {
    maxRetries: 0,
  });
  return { result, bundle };
}

function request(text: string): CanonicalModelRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  };
}

function protocolAttempts(
  bundle: ModelSessionBundle,
  result: Awaited<ReturnType<ModelExecutionGateway['executeAttempt']>>,
): string[] {
  const sessions = [bundle.primary, ...bundle.fallbacks];
  return [
    ...result.discardedAttempts.map((attempt) =>
      sessions.find((session) => session.route.routeId === attempt.routeId)!.route.protocol),
    result.session.route.protocol,
  ];
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
