import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmRouter, type LlmChatRequest, type LlmChatResponse, type LlmProvider } from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import { ReactAgent, ToolRegistry } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ReactAgent', () => {
  it('runs a readonly database tool and returns a final business answer', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'query_database',
            arguments: { sql: 'select count(*) as order_count from orders' },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: '订单总数是 42，可以继续按日期分析趋势。',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '帮我看一下订单总数',
      mode: 'readonly',
    });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('订单总数是 42，可以继续按日期分析趋势。');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_1', toolName: 'query_database', status: 'success' },
    ]);
    expect(result.session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.session.tokenUsage.totalTokens).toBe(43);
    await expect(usage.current()).resolves.toMatchObject({
      usedRounds: 1,
      byokTokenEstimate: 43,
    });
  });

  it('blocks non-readonly tools in readonly mode before side effects happen', async () => {
    let writeExecuted = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with possible writes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        readonly: false,
      },
      () => {
        writeExecuted = true;
        return { ok: true };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'call_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } }],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单表',
      mode: 'readonly',
    });

    expect(result.status).toBe('permission_denied');
    expect(writeExecuted).toBe(false);
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_write', toolName: 'execute_sql', status: 'denied' },
    ]);
  });

  it('does not execute ask-mode medium tools without an approval provider', async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write_workspace_file',
        description: 'Write a workspace artifact',
        inputSchema: { type: 'object' },
        dangerLevel: 'medium',
      },
      () => {
        executed = true;
        return 'written';
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'call_file', name: 'write_workspace_file', arguments: { path: 'report.md' } }],
          },
          {
            text: '需要用户批准后才能写入文件。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '写一个分析报告',
      mode: 'ask',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(executed).toBe(false);
    expect(result.toolExecutions).toMatchObject([{ status: 'denied', resultPreview: 'Permission: ask' }]);
    expect(result.finalText).toBe('需要用户批准后才能写入文件。');
  });

  it('returns tool failures to the model so the next iteration can recover', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      (args) => {
        if (String(args.sql).includes('missing_column')) {
          throw new Error('column missing_column does not exist');
        }
        return { rows: [{ order_count: 42 }] };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'bad_sql', name: 'query_database', arguments: { sql: 'select missing_column from orders' } }],
          },
          {
            text: '',
            toolCalls: [{ id: 'fixed_sql', name: 'query_database', arguments: { sql: 'select count(*) as order_count from orders' } }],
          },
          {
            text: '已修正 SQL，订单总数是 42。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '订单总数是多少',
      mode: 'readonly',
      maxIterations: 3,
    });

    expect(result.status).toBe('done');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'bad_sql', status: 'failed' },
      { toolCallId: 'fixed_sql', status: 'success' },
    ]);
    expect(result.finalText).toBe('已修正 SQL，订单总数是 42。');
  });

  it('only exposes tools allowed by the current skill execution plan', async () => {
    const registry = registryWithReadAndWriteTools();
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'Only query tools are available.',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run a readonly skill query.',
      mode: 'readonly',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
  });

  it('denies tool calls that are registered but not allowed for the current run', async () => {
    let writeExecuted = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ rows: [] }),
    );
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with possible writes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        readonly: false,
      },
      () => {
        writeExecuted = true;
        return { ok: true };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'hidden_write', name: 'execute_sql', arguments: { sql: 'drop table orders' } }],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run a skill that allows readonly query only.',
      mode: 'full-auto',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('permission_denied');
    expect(writeExecuted).toBe(false);
    expect(result.finalText).toBe('Tool is not allowed for this run.');
    expect(result.toolExecutions).toMatchObject([
      {
        toolCallId: 'hidden_write',
        toolName: 'execute_sql',
        status: 'denied',
        resultPreview: 'Tool not allowed by run policy.',
      },
    ]);
  });

  it('stops subscription Agent runs before calling the model when quota is exhausted', async () => {
    const usage = new UsageTracker(await usagePath(), { subscriptionRoundLimit: 0 });
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'should not run',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run subscription task.',
      mode: 'readonly',
      usageMode: 'subscription',
    });

    expect(result.status).toBe('quota_exceeded');
    expect(calls).toHaveLength(0);
    await expect(usage.roundHistory()).resolves.toEqual([]);
  });

  it('counts user-aborted Agent rounds without calling the model', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'should not run',
        toolCalls: [],
      },
    ]);
    const signal = AbortSignal.abort();
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Start then stop.',
      mode: 'readonly',
      signal,
    });

    expect(result.status).toBe('aborted');
    expect(calls).toHaveLength(0);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 1 });
    await expect(usage.roundHistory()).resolves.toMatchObject([{ status: 'aborted' }]);
  });

  it('does not count provider infrastructure failures as billable Agent rounds', async () => {
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [throwingProvider('provider timeout')]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    await expect(
      agent.run({
        providerId: 'throwing',
        model: 'fake-model',
        userMessage: 'Analyze orders.',
        mode: 'readonly',
      }),
    ).rejects.toThrow('provider timeout');

    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0 });
    await expect(usage.roundHistory()).resolves.toMatchObject([
      { sessionId: 'session_test', status: 'failed', errorMessage: 'provider timeout' },
    ]);
  });
});

function registryWithQueryTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'query_database',
      description: 'Execute readonly SQL',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    () => ({ rows: [{ order_count: 42 }] }),
  );
  return registry;
}

function registryWithReadAndWriteTools(): ToolRegistry {
  const registry = registryWithQueryTool();
  registry.register(
    {
      name: 'execute_sql',
      description: 'Execute SQL with possible writes',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      dangerLevel: 'high',
      readonly: false,
    },
    () => ({ ok: true }),
  );
  return registry;
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return scriptedProviderWithCalls(script).provider;
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

function throwingProvider(message: string): LlmProvider {
  return {
    id: 'throwing',
    name: 'Throwing Provider',
    mode: 'byok',
    async chat() {
      throw new Error(message);
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

function fixedDependencies() {
  return {
    now: () => '2026-06-17T00:00:00.000Z',
    createSessionId: () => 'session_test',
  };
}
