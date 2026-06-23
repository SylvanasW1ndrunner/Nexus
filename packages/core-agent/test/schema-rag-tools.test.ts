import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmRouter, type LlmChatRequest, type LlmChatResponse, type LlmProvider } from '@dbagent/core-llm';
import { SchemaRagEngine } from '@dbagent/core-rag';
import { UsageTracker } from '@dbagent/core-usage';
import type { TableDetail } from '@dbagent/shared';
import { ReactAgent, registerSchemaRagTools, SCHEMA_RAG_TOOL_NAMES, ToolRegistry } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('schema RAG Agent tools', () => {
  it('registers safe readonly schema tools with stable model-facing contracts', () => {
    const registry = new ToolRegistry();

    registerSchemaRagTools(registry, indexedRag(), { defaultConnectionId: 'conn_1' });

    expect(registry.llmTools().map((tool) => tool.name)).toEqual([
      SCHEMA_RAG_TOOL_NAMES.searchSchema,
      SCHEMA_RAG_TOOL_NAMES.describeTable,
      SCHEMA_RAG_TOOL_NAMES.listTables,
      SCHEMA_RAG_TOOL_NAMES.getRelations,
    ]);
    expect(registry.get(SCHEMA_RAG_TOOL_NAMES.searchSchema)).toMatchObject({
      dangerLevel: 'safe',
      readonly: true,
      inputSchema: { required: ['query'] },
    });
  });

  it('searches business glossary terms and returns compact context for the next Agent turn', async () => {
    const registry = new ToolRegistry();
    registerSchemaRagTools(registry, indexedRag(), { defaultConnectionId: 'conn_1', maxContextChars: 1_200 });

    const result = await registry.get(SCHEMA_RAG_TOOL_NAMES.searchSchema)?.handler(
      { query: 'monthly GMV', limit: 4 },
      { session: minimalSession() },
    );

    expect(result).toMatchObject({
      connectionId: 'conn_1',
      query: 'monthly GMV',
      count: 4,
      truncated: false,
    });
    expect(JSON.stringify(result)).toContain('public.orders.total_amount');
  });

  it('requires an explicit connection when no active connection is configured', async () => {
    const registry = new ToolRegistry();
    registerSchemaRagTools(registry, indexedRag());

    await expect(
      Promise.resolve().then(() => registry.get(SCHEMA_RAG_TOOL_NAMES.listTables)?.handler({}, { session: minimalSession() })),
    ).rejects.toThrow('connectionId is required.');
  });

  it('can skip tools already registered by a broader database tool pack', () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: SCHEMA_RAG_TOOL_NAMES.describeTable,
        description: 'Live database describe table',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ source: 'driver' }),
    );

    registerSchemaRagTools(registry, indexedRag(), {
      defaultConnectionId: 'conn_1',
      skipExistingTools: true,
    });

    expect(registry.get(SCHEMA_RAG_TOOL_NAMES.describeTable)?.description).toBe('Live database describe table');
    expect(registry.has(SCHEMA_RAG_TOOL_NAMES.searchSchema)).toBe(true);
    expect(registry.has(SCHEMA_RAG_TOOL_NAMES.getRelations)).toBe(true);
  });

  it('lets the Agent inspect schema before answering a user data question', async () => {
    const registry = new ToolRegistry();
    registerSchemaRagTools(registry, indexedRag(), { defaultConnectionId: 'conn_1' });
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [
          {
            id: 'rag_1',
            name: SCHEMA_RAG_TOOL_NAMES.searchSchema,
            arguments: { query: 'GMV', limit: 4 },
          },
        ],
      },
      {
        text: 'GMV should use public.orders.total_amount and join order_items only when SKU detail is needed.',
        toolCalls: [],
      },
    ]);

    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registry,
      usage,
      undefined,
      { now: () => '2026-06-23T00:00:00.000Z', createSessionId: () => 'session_rag' },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Which table should I use for GMV?',
      mode: 'readonly',
      allowedTools: [SCHEMA_RAG_TOOL_NAMES.searchSchema],
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual([SCHEMA_RAG_TOOL_NAMES.searchSchema]);
    expect(result.toolExecutions).toMatchObject([{ toolName: SCHEMA_RAG_TOOL_NAMES.searchSchema, status: 'success' }]);
    expect(result.session.messages.find((message) => message.role === 'tool')?.content).toContain(
      'public.orders.total_amount',
    );
    expect(result.finalText).toContain('public.orders.total_amount');
  });
});

function indexedRag(): SchemaRagEngine {
  const engine = new SchemaRagEngine();
  engine.index({
    connectionId: 'conn_1',
    tables: fixtureTables(),
    glossary: [
      {
        term: 'GMV',
        aliases: ['gross merchandise value'],
        description: 'Order amount metric stored in orders.total_amount.',
        documentIds: ['table:public.orders', 'column:public.orders.total_amount'],
        weight: 60,
      },
    ],
    indexedAt: '2026-06-23T00:00:00.000Z',
  });
  return engine;
}

function fixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      comment: 'Order fact table for revenue analysis',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, 'Order id', true),
        column('total_amount', 2, 'numeric', false, 'GMV amount'),
        {
          ...column('user_id', 3, 'uuid', false, 'Buyer user id'),
          foreignKey: { schema: 'public', table: 'users', column: 'id' },
        },
      ],
    },
    {
      schema: 'public',
      name: 'users',
      type: 'table',
      comment: 'Registered users',
      primaryKey: ['id'],
      columns: [column('id', 1, 'uuid', false, 'User id', true), column('email', 2, 'text', false, 'Email')],
    },
    {
      schema: 'public',
      name: 'order_items',
      type: 'table',
      comment: 'Order line items',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, 'Line id', true),
        {
          ...column('order_id', 2, 'uuid', false, 'Order id'),
          foreignKey: { schema: 'public', table: 'orders', column: 'id' },
        },
        column('sku', 3, 'text', false, 'SKU'),
      ],
    },
  ];
}

function column(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment?: string,
  isPrimaryKey = false,
) {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    ...(comment === undefined ? {} : { comment }),
    isPrimaryKey,
  };
}

function minimalSession() {
  return {
    id: 'session_test',
    title: 'test',
    mode: 'readonly' as const,
    strategy: 'react' as const,
    messages: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    aborted: false,
  };
}

function scriptedProviderWithCalls(script: LlmChatResponse[]): { provider: LlmProvider; calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    async chat(request) {
      calls.push(request);
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return next;
    },
    async isAvailable() {
      return { available: true };
    },
  };
  return { provider, calls };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-rag-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}
