import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactAgent, ToolRegistry } from '@dbagent/core-agent';
import { LlmRouter, type LlmChatResponse, type LlmProvider } from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import {
  McpHealthManager,
  McpToolTimeoutError,
  McpUnavailableError,
  adaptMcpToolDefinition,
  inferMcpToolRisk,
  namespacedToolName,
  registerMcpTools,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MCP tool adapter', () => {
  it('normalizes MCP tool names, schemas, source metadata and readonly risk', () => {
    const definition = adaptMcpToolDefinition({
      serverId: 'customer db',
      source: 'user-mcp',
      tool: {
        name: 'list_tables',
        description: 'List tables from the remote database',
        inputSchema: {
          type: 'object',
          properties: { schema: { type: 'string' } },
          required: ['schema'],
        },
      },
    });

    expect(definition).toMatchObject({
      name: 'customer_db__list_tables',
      originalName: 'list_tables',
      source: 'user-mcp',
      sourceId: 'customer db',
      dangerLevel: 'safe',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: { schema: { type: 'string' } },
        required: ['schema'],
      },
    });
  });

  it('uses conservative defaults for unknown market tools and dangerous names', () => {
    expect(inferMcpToolRisk({ name: 'summarize', description: 'custom action' }, 'market-mcp')).toEqual({
      dangerLevel: 'high',
      readonly: false,
    });
    expect(inferMcpToolRisk({ name: 'delete_records', description: 'Delete rows' }, 'user-mcp')).toEqual({
      dangerLevel: 'high',
      readonly: false,
    });
    expect(inferMcpToolRisk({ name: 'decrypt_phone', annotations: { readOnlyHint: true } }, 'user-mcp')).toEqual({
      dangerLevel: 'safe',
      readonly: true,
    });
  });

  it('keeps long names within provider limits and resolves collisions deterministically', () => {
    const longName = namespacedToolName('very long server name that comes from smithery marketplace', 'read customer table');

    expect(longName.length).toBeLessThanOrEqual(64);
    expect(longName).toMatch(/__[a-f0-9]{8}$/);

    const usedNames = new Set<string>();
    const first = adaptMcpToolDefinition({
      serverId: 'server',
      source: 'user-mcp',
      tool: { name: 'read-data' },
      usedNames,
    });
    const second = adaptMcpToolDefinition({
      serverId: 'server',
      source: 'user-mcp',
      tool: { name: 'read data' },
      usedNames,
    });

    expect(first.name).toBe('server__read-data');
    expect(second.name).toBe('server__read_data');
  });

  it('registers healthy MCP tools and invokes the original tool name through ToolRegistry', async () => {
    const registry = new ToolRegistry();
    const health = new McpHealthManager();
    health.markHealthy('decryptor');
    const calls: Array<{ toolName: string; args: Record<string, unknown>; aborted: boolean }> = [];

    const registered = registerMcpTools({
      registry,
      serverId: 'decryptor',
      source: 'user-mcp',
      health,
      tools: [
        {
          name: 'decrypt_phone',
          description: 'Decrypt a phone field for analysis',
          annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        },
      ],
      callTool: ({ toolName, args, signal }) => {
        calls.push({ toolName, args, aborted: signal.aborted });
        return { city: 'Shanghai' };
      },
    });

    expect(registered).toEqual([
      { name: 'decryptor__decrypt_phone', originalName: 'decrypt_phone', source: 'user-mcp', sourceId: 'decryptor' },
    ]);
    await expect(
      registry.get('decryptor__decrypt_phone')?.handler({ value: 'enc:phone' }, toolContext()),
    ).resolves.toEqual({
      city: 'Shanghai',
    });
    expect(calls).toEqual([{ toolName: 'decrypt_phone', args: { value: 'enc:phone' }, aborted: false }]);
  });

  it('blocks unavailable MCP servers before invoking third-party code', async () => {
    const registry = new ToolRegistry();
    const health = new McpHealthManager();
    health.markUnhealthy('broken', 'spawn ENOENT');
    let called = false;

    registerMcpTools({
      registry,
      serverId: 'broken',
      source: 'user-mcp',
      health,
      tools: [{ name: 'read_status', annotations: { readOnlyHint: true } }],
      callTool: () => {
        called = true;
        return {};
      },
    });

    await expect(registry.get('broken__read_status')?.handler({}, toolContext())).rejects.toBeInstanceOf(
      McpUnavailableError,
    );
    expect(called).toBe(false);
  });

  it('times out MCP tools that hang and surfaces a structured timeout error', async () => {
    const registry = new ToolRegistry();
    const health = new McpHealthManager();
    health.markHealthy('slow');

    registerMcpTools({
      registry,
      serverId: 'slow',
      source: 'user-mcp',
      health,
      timeoutMs: 5,
      tools: [{ name: 'read_slow', annotations: { readOnlyHint: true } }],
      callTool: () =>
        new Promise(() => {
          // Simulates a stuck MCP server that never resolves.
        }),
    });

    await expect(registry.get('slow__read_slow')?.handler({}, toolContext())).rejects.toBeInstanceOf(
      McpToolTimeoutError,
    );
  });

  it('lets readonly Agent use readonly MCP tools but denies dangerous write-capable tools before side effects', async () => {
    const registry = new ToolRegistry();
    const health = new McpHealthManager();
    health.markHealthy('warehouse');
    const calledTools: string[] = [];

    registerMcpTools({
      registry,
      serverId: 'warehouse',
      source: 'user-mcp',
      health,
      tools: [
        { name: 'list_tables', description: 'List tables', annotations: { readOnlyHint: true } },
        { name: 'delete_records', description: 'Delete rows', annotations: { destructiveHint: true } },
      ],
      callTool: ({ toolName }) => {
        calledTools.push(toolName);
        return { ok: true };
      },
    });

    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          responseWithTool('call_list', 'warehouse__list_tables', {}),
          { text: 'Tables are available.', toolCalls: [] },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const readResult = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'List tables through MCP.',
      mode: 'readonly',
      maxIterations: 2,
    });
    expect(readResult.status).toBe('done');
    expect(calledTools).toEqual(['list_tables']);

    const blockedAgent = new ReactAgent(
      new LlmRouter(usage, [scriptedProvider([responseWithTool('call_delete', 'warehouse__delete_records', {})])]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );
    const blockedResult = await blockedAgent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Delete records through MCP.',
      mode: 'readonly',
      maxIterations: 1,
    });

    expect(blockedResult.status).toBe('permission_denied');
    expect(calledTools).toEqual(['list_tables']);
  });
});

function toolContext() {
  return {
    session: {
      id: 'session_mcp_tools',
      title: 'mcp tools',
      mode: 'readonly' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    async chat() {
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return next;
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function responseWithTool(id: string, name: string, args: Record<string, unknown>): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
  };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dbagent-mcp-tool-adapter-${randomUUID()}-`));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

function fixedDependencies() {
  return {
    now: () => '2026-06-18T10:00:00.000Z',
    createSessionId: () => 'session_mcp_agent',
  };
}
