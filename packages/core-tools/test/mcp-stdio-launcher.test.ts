import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  launchStdioMcpServer,
  McpResultTooLargeError,
  type McpListChangedEvent,
  type McpPromptSpec,
  type McpResourceSpec,
  type McpRuntimeClient,
  type McpRuntimeExitEvent,
  type McpServerConfig,
  McpToolAbortedError,
  type McpToolSpec,
  McpToolTimeoutError,
} from '../src/index.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const REAL_PROCESS_REQUEST_TIMEOUT_MS = 5_000;
const REAL_PROCESS_TEST_TIMEOUT_MS = 15_000;

describe('official SDK stdio MCP client', () => {
  it(
    'negotiates capabilities and preserves paginated tools, resources, prompts and rich results',
    async () => {
      const client = await launchStdioMcpServer(serverConfig('normal', true), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        resolveSecret: (ref) =>
          ref === 'mcp:fixture:env:API_TOKEN' ? 'token-from-keychain' : undefined,
      });

      try {
        expect(client.describe()).toMatchObject({
          serverId: 'fixture',
          transport: 'stdio',
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: { name: 'schemanaut-mcp-fixture', version: '1.0.0' },
          instructions: 'Deterministic SchemaNaut MCP integration fixture.',
        });
        await expect(client.ping()).resolves.toBeUndefined();

        const tools = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([
          'echo',
          'replace_catalog',
          'logical_error',
          'slow',
          'crash',
        ]);
        expect(tools[0]).toMatchObject({
          name: 'echo',
          title: 'Rich Echo',
          outputSchema: { type: 'object' },
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: { fixtureVersion: 1 },
        });

        const result = await client.callTool(
          'echo',
          { value: 'hello' },
          new AbortController().signal,
        );
        expect(result).toMatchObject({
          content: [
            { type: 'text', text: 'hello' },
            {
              type: 'resource_link',
              uri: 'fixture://resources/alpha',
              name: 'Alpha resource',
            },
          ],
          structuredContent: {
            echo: 'hello',
            publicMode: 'test',
            hasToken: true,
          },
          _meta: { fixtureTrace: 'echo-1' },
        });

        await expect(client.listResources()).resolves.toMatchObject([
          {
            uri: 'fixture://resources/alpha',
            name: 'Alpha',
            annotations: { audience: ['assistant'], priority: 0.8 },
            _meta: { fixtureVersion: 1 },
          },
          { uri: 'fixture://resources/beta', name: 'Beta' },
        ]);
        await expect(client.listResourceTemplates()).resolves.toMatchObject([
          { uriTemplate: 'fixture://customers/{customerId}', name: 'Customer' },
          { uriTemplate: 'fixture://events/{eventId}', name: 'Event' },
        ]);
        await expect(client.readResource('fixture://resources/beta')).resolves.toMatchObject({
          contents: [
            {
              uri: 'fixture://resources/beta',
              blob: 'AAECAw==',
              _meta: { encoding: 'base64' },
            },
          ],
        });
        await expect(client.listPrompts()).resolves.toMatchObject([
          { name: 'explain-customer', _meta: { fixtureVersion: 1 } },
          { name: 'inspect-anomaly' },
        ]);
        const prompt = await client.getPrompt('explain-customer', { customerId: 'c-42' });
        expect(prompt).toMatchObject({
          description: 'Fixture prompt explain-customer',
          messages: [
            {
              role: 'user',
            },
          ],
        });
        expect(JSON.stringify(prompt.messages)).toContain('c-42');
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'refreshes tools, resources and prompts after standard list-changed notifications',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
      });

      try {
        const toolsChanged = onceToolsChanged(client);
        const resourcesChanged = onceResourcesChanged(client);
        const promptsChanged = oncePromptsChanged(client);

        await client.callTool('replace_catalog', {}, new AbortController().signal);

        await expect(toolsChanged).resolves.toMatchObject({
          items: [{ name: 'new_tool', _meta: { fixtureVersion: 2 } }],
        });
        await expect(resourcesChanged).resolves.toMatchObject({
          items: [{ uri: 'fixture://resources/version-2', name: 'Version 2' }],
        });
        await expect(promptsChanged).resolves.toMatchObject({
          items: [{ name: 'version-2-prompt' }],
        });
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'preserves protocol-level tool errors instead of converting them into transport failures',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
      });
      try {
        await expect(
          client.callTool('logical_error', {}, new AbortController().signal),
        ).resolves.toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'Fixture rejected the requested operation.' }],
          _meta: { code: 'FIXTURE_REJECTED' },
        });
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'propagates AbortSignal cancellation to an in-flight SDK request',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
      });
      const controller = new AbortController();
      const call = client.callTool('slow', { delayMs: 10_000 }, controller.signal);
      setTimeout(() => controller.abort(), 20);

      try {
        await expect(call).rejects.toBeInstanceOf(McpToolAbortedError);
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'applies the SDK request timeout to stuck tool calls and paginated list calls',
    async () => {
      const slowClient = await launchStdioMcpServer(serverConfig(), {
        connectTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        requestTimeoutMs: 200,
      });
      try {
        await expect(
          slowClient.callTool('slow', { delayMs: 10_000 }, new AbortController().signal),
        ).rejects.toBeInstanceOf(McpToolTimeoutError);
      } finally {
        await slowClient.stop();
      }

      const stuckClient = await launchStdioMcpServer(serverConfig('stuck-list'), {
        connectTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        requestTimeoutMs: 200,
      });
      try {
        await expect(stuckClient.listTools()).rejects.toThrow(/timed out|timeout/i);
      } finally {
        await stuckClient.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'rejects repeated pagination cursors and configured page-limit overflow',
    async () => {
      const repeated = await launchStdioMcpServer(serverConfig('repeat-cursor'), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
      });
      try {
        await expect(repeated.listTools()).rejects.toThrow(
          'returned a repeated tools pagination cursor',
        );
      } finally {
        await repeated.stop();
      }

      const limited = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        paginationPageLimit: 1,
      });
      try {
        await expect(limited.listTools()).rejects.toThrow(
          'exceeded the tools pagination page limit (1)',
        );
      } finally {
        await limited.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'rejects oversized rich tool results after protocol validation',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        maxResultBytes: 128,
      });
      try {
        await expect(
          client.callTool('echo', { value: 'x'.repeat(256) }, new AbortController().signal),
        ).rejects.toBeInstanceOf(McpResultTooLargeError);
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'rejects oversized protocol messages before sending them to the MCP process',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        maxMessageBytes: 2_048,
      });
      try {
        await expect(
          client.callTool('echo', { value: 'x'.repeat(4_096) }, new AbortController().signal),
        ).rejects.toThrow('exceeding the 2048-byte message limit');
      } finally {
        await client.stop();
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it('fails before spawning when a secret ref cannot be resolved', async () => {
    await expect(
      launchStdioMcpServer(serverConfig('normal', true), {
        resolveSecret: () => undefined,
      }),
    ).rejects.toThrow('Missing secret for MCP env API_TOKEN ref mcp:fixture:env:API_TOKEN');
  });

  it(
    'reports an unexpected SDK transport close with bounded stderr',
    async () => {
      const client = await launchStdioMcpServer(serverConfig(), {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        stderrLimitBytes: 64,
      });
      const exit = onceExit(client);

      await expect(client.callTool('crash', {}, new AbortController().signal)).rejects.toThrow();

      const exitEvent = await exit;
      expect(exitEvent.stderrPreview).toMatch(/x+$/);
      expect(exitEvent.stderrPreview).toHaveLength(64);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

function serverConfig(mode = 'normal', includeSecretEnv = false): McpServerConfig {
  return {
    id: 'fixture',
    name: 'Fixture',
    source: 'user',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE_SERVER, mode],
    ...(includeSecretEnv
      ? {
          env: {
            PUBLIC_MODE: 'test',
            API_TOKEN: { ref: 'mcp:fixture:env:API_TOKEN' },
          },
        }
      : {}),
    autoStart: false,
    enabled: true,
    installedAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  };
}

function onceExit(client: McpRuntimeClient): Promise<McpRuntimeExitEvent> {
  return new Promise((resolve, reject) => {
    const unsubscribe = client.onExit?.((event) => {
      unsubscribe?.();
      resolve(event);
    });
    if (!unsubscribe) reject(new Error('MCP client does not expose onExit.'));
  });
}

function onceToolsChanged(client: McpRuntimeClient): Promise<McpListChangedEvent<McpToolSpec>> {
  return new Promise((resolve, reject) => {
    if (!client.onToolsChanged) {
      reject(new Error('MCP client does not expose tools list changes.'));
      return;
    }
    const unsubscribe = client.onToolsChanged((event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

function onceResourcesChanged(
  client: McpRuntimeClient,
): Promise<McpListChangedEvent<McpResourceSpec>> {
  return new Promise((resolve, reject) => {
    if (!client.onResourcesChanged) {
      reject(new Error('MCP client does not expose resources list changes.'));
      return;
    }
    const unsubscribe = client.onResourcesChanged((event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

function oncePromptsChanged(client: McpRuntimeClient): Promise<McpListChangedEvent<McpPromptSpec>> {
  return new Promise((resolve, reject) => {
    if (!client.onPromptsChanged) {
      reject(new Error('MCP client does not expose prompts list changes.'));
      return;
    }
    const unsubscribe = client.onPromptsChanged((event) => {
      unsubscribe();
      resolve(event);
    });
  });
}
