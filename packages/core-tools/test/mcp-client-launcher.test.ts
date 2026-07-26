import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  type JSONRPCMessage,
  ListToolsRequestSchema,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { launchMcpServer, type McpServerConfig } from '../src/index.js';

const HTTP_TEST_TIMEOUT_MS = 15_000;

describe('official SDK remote MCP client', () => {
  it(
    'uses Streamable HTTP, negotiates capabilities and resolves secret-backed headers',
    async () => {
      const fixture = await createStreamableHttpFixture('Bearer fixture-token');
      const client = await launchMcpServer(remoteConfig(`${fixture.url}/mcp`, 'streamable-http'), {
        requestTimeoutMs: 2_000,
        resolveSecret: (ref) =>
          ref === 'mcp:remote:header:authorization' ? 'Bearer fixture-token' : undefined,
      });

      try {
        expect(client.describe()).toMatchObject({
          transport: 'streamable-http',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'streamable-fixture' },
        });
        await expect(client.listTools()).resolves.toMatchObject([
          { name: 'inspect_headers', annotations: { readOnlyHint: true } },
        ]);
        await expect(
          client.callTool('inspect_headers', {}, new AbortController().signal),
        ).resolves.toMatchObject({
          content: [{ type: 'text', text: 'authorized' }],
          structuredContent: { authorization: 'Bearer fixture-token' },
        });
      } finally {
        await client.stop();
        await fixture.close();
      }
    },
    HTTP_TEST_TIMEOUT_MS,
  );

  it(
    'falls back from Streamable HTTP to the official legacy SSE transport',
    async () => {
      const fixture = await createLegacySseFixture();
      const client = await launchMcpServer(
        remoteConfig(`${fixture.url}/sse`, 'streamable-http', false),
        { requestTimeoutMs: 2_000 },
      );

      try {
        expect(client.describe().transport).toBe('sse');
        await expect(client.listTools()).resolves.toMatchObject([{ name: 'legacy_echo' }]);
        await expect(
          client.callTool('legacy_echo', { value: 'fallback-ok' }, new AbortController().signal),
        ).resolves.toMatchObject({
          content: [{ type: 'text', text: 'fallback-ok' }],
        });
      } finally {
        await client.stop();
        await fixture.close();
      }
    },
    HTTP_TEST_TIMEOUT_MS,
  );

  it(
    'can disable legacy SSE fallback and preserve the Streamable HTTP error',
    async () => {
      const fixture = await createLegacySseFixture();
      try {
        await expect(
          launchMcpServer(remoteConfig(`${fixture.url}/sse`, 'streamable-http', false), {
            requestTimeoutMs: 1_000,
            legacySseFallback: false,
          }),
        ).rejects.toThrow();
      } finally {
        await fixture.close();
      }
    },
    HTTP_TEST_TIMEOUT_MS,
  );
});

async function createStreamableHttpFixture(requiredAuthorization: string): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  let observedAuthorization = '';
  const protocols = new Set<Server>();

  const http = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== requiredAuthorization) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end('Unauthorized');
      return;
    }
    observedAuthorization = request.headers.authorization;
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    const protocol = createProtocolServer('streamable-fixture', 'inspect_headers', () => ({
      content: [{ type: 'text', text: 'authorized' }],
      structuredContent: {
        authorization: observedAuthorization,
      },
    }));
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    protocols.add(protocol);
    try {
      await protocol.connect(new ProtocolTransportAdapter(transport));
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    }
  };
  const url = await listen(http);

  return {
    url,
    async close() {
      await Promise.all([...protocols].map((protocol) => protocol.close()));
      protocols.clear();
      await closeHttp(http);
    },
  };
}

/**
 * The SDK's Node Streamable HTTP wrapper exposes callback accessors as
 * `handler | undefined`, while its own Transport interface models them as
 * exact optional properties. Keep the official transport and bridge only that
 * declaration mismatch so strict test builds exercise the real implementation.
 */
class ProtocolTransportAdapter implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(private readonly transport: StreamableHTTPServerTransport) {}

  start(): Promise<void> {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onmessage = (message, extra) => this.onmessage?.(message, extra);
    return this.transport.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

async function createLegacySseFixture(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const sessions = new Map<string, { protocol: Server; transport: SSEServerTransport }>();
  const http = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/sse') {
      response.writeHead(405).end('Use legacy SSE.');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/sse') {
      const protocol = createProtocolServer('legacy-sse-fixture', 'legacy_echo', (args) => ({
        content: [{ type: 'text', text: typeof args.value === 'string' ? args.value : '' }],
      }));
      const transport = new SSEServerTransport('/messages', response);
      sessions.set(transport.sessionId, { protocol, transport });
      await protocol.connect(transport);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        response.writeHead(404).end('Unknown session.');
        return;
      }
      await session.transport.handlePostMessage(request, response);
      return;
    }
    response.writeHead(404).end();
  };
  const url = await listen(http);

  return {
    url,
    async close() {
      await Promise.all([...sessions.values()].map(({ protocol }) => protocol.close()));
      sessions.clear();
      await closeHttp(http);
    },
  };
}

function createProtocolServer(
  name: string,
  toolName: string,
  handler: (args: Record<string, unknown>) => CallToolResult,
): Server {
  const protocol = new Server(
    { name, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  protocol.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: toolName,
        description: `${name} tool`,
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  protocol.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    handler(params.arguments ?? {}),
  );
  return protocol;
}

function remoteConfig(
  url: string,
  transport: 'streamable-http' | 'sse',
  includeAuthorization = true,
): McpServerConfig {
  return {
    id: 'remote-fixture',
    name: 'Remote Fixture',
    source: 'user',
    transport,
    url,
    ...(includeAuthorization
      ? {
          headers: {
            Authorization: { ref: 'mcp:remote:header:authorization' },
          },
        }
      : {}),
    autoStart: false,
    enabled: true,
    installedAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  };
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind.');
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
