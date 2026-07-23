import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmRouter, type LlmChatResponse, type LlmProvider } from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import { AgentSessionStore, ReactAgent, ToolRegistry, type AgentSession } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentSessionStore', () => {
  it('persists, lists, loads, updates, archives, restores, and deletes sessions', async () => {
    const store = new AgentSessionStore(await sessionPath());
    const session = testSession('session_1', '订单分析');

    await expect(store.save({ session, now: '2026-06-23T01:00:00.000Z' })).resolves.toMatchObject({
      id: 'session_1',
      title: '订单分析',
      messageCount: 2,
      toolMessageCount: 0,
      archived: false,
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T01:00:00.000Z',
      lastMessageAt: '2026-06-23T00:00:01.000Z',
    });
    await expect(store.load('session_1')).resolves.toMatchObject({ id: 'session_1', title: '订单分析' });
    await expect(store.list()).resolves.toMatchObject([{ id: 'session_1' }]);

    await expect(store.update('session_1', { title: 'GMV 分析' }, '2026-06-23T02:00:00.000Z')).resolves.toMatchObject({
      title: 'GMV 分析',
      updatedAt: '2026-06-23T02:00:00.000Z',
    });
    await expect(store.archive('session_1', true, '2026-06-23T03:00:00.000Z')).resolves.toMatchObject({
      archived: true,
    });
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.list({ archived: true })).resolves.toMatchObject([{ id: 'session_1', archived: true }]);

    await expect(store.archive('session_1', false, '2026-06-23T04:00:00.000Z')).resolves.toMatchObject({
      archived: false,
    });
    await expect(store.delete('session_1')).resolves.toBe(true);
    await expect(store.load('session_1')).resolves.toBeUndefined();
  });

  it('searches summaries by title and message text with pagination', async () => {
    const store = new AgentSessionStore(await sessionPath());
    await store.save({ session: testSession('session_orders', '订单分析'), now: '2026-06-23T01:00:00.000Z' });
    await store.save({ session: testSession('session_users', '用户留存'), now: '2026-06-23T02:00:00.000Z' });

    await expect(store.list({ query: '订单分析' })).resolves.toMatchObject([{ id: 'session_orders' }]);
    await expect(store.list({ limit: 1, offset: 1 })).resolves.toMatchObject([{ id: 'session_orders' }]);
  });

  it('forks a session from a selected message and exports json or markdown', async () => {
    const store = new AgentSessionStore(await sessionPath());
    await store.save({ session: testSession('session_1', '订单分析'), now: '2026-06-23T01:00:00.000Z' });

    await expect(
      store.fork({
        id: 'session_1',
        fromMessageIndex: 0,
        newId: 'session_fork',
        title: '订单分析分支',
        now: '2026-06-23T02:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      id: 'session_fork',
      title: '订单分析分支',
      messages: [{ role: 'user' }],
    });
    await expect(store.export('session_fork', 'markdown')).resolves.toContain('# 订单分析分支');
    await expect(store.export('session_fork', 'json')).resolves.toContain('"id": "session_fork"');
  });

  it('rejects invalid operations with clear errors', async () => {
    const store = new AgentSessionStore(await sessionPath());
    await store.save({ session: testSession('session_1', '订单分析') });

    await expect(store.update('missing', { title: 'x' })).rejects.toThrow('Agent session not found: missing');
    await expect(store.fork({ id: 'session_1', fromMessageIndex: 99 })).rejects.toThrow('Invalid fork message index: 99');
    await expect(store.export('missing', 'json')).rejects.toThrow('Agent session not found: missing');
    await expect(store.list({ limit: 0 })).rejects.toThrow('limit must be a positive integer.');
    await expect(store.list({ offset: -1 })).rejects.toThrow('offset must be a non-negative integer.');
  });

  it('treats corrupt session JSON as empty so startup can continue', async () => {
    const filePath = await sessionPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');
    const store = new AgentSessionStore(filePath);

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load('missing')).resolves.toBeUndefined();
  });

  it('redacts secrets before persisting, loading, and exporting sessions', async () => {
    const filePath = await sessionPath();
    const store = new AgentSessionStore(filePath);
    const apiKey = ['sk', 'session-secret-123456'].join('-');
    const password = ['plain', 'password'].join('-');
    const databaseUrl = ['postgres://tester', `${password}@127.0.0.1/orders`].join(':');
    const session = testSession('session_secret', 'secret handling');
    session.messages.push({
      role: 'assistant',
      content: `Will query with Authorization: Bearer ${apiKey}`,
      toolCalls: [
        {
          id: 'call_secret',
          name: 'query_database',
          arguments: { apiKey, databaseUrl, password },
        },
      ],
      createdAt: '2026-06-23T00:00:02.000Z',
    });
    session.messages.push({
      role: 'tool',
      toolCallId: 'call_secret',
      toolName: 'query_database',
      content: `failed to connect ${databaseUrl} with apiKey=${apiKey}`,
      createdAt: '2026-06-23T00:00:03.000Z',
    });

    await store.save({ session, now: '2026-06-23T01:00:00.000Z' });

    const persisted = await readFile(filePath, 'utf8');
    const loaded = await store.load('session_secret');
    const exportedJson = await store.export('session_secret', 'json');
    const exportedMarkdown = await store.export('session_secret', 'markdown');
    const combined = [persisted, JSON.stringify(loaded), exportedJson, exportedMarkdown].join('\n');

    expect(combined).not.toContain(apiKey);
    expect(combined).not.toContain(password);
    expect(combined).not.toContain(`tester:${password}@`);
    expect(combined).toContain('[REDACTED]');
    expect(combined).toContain(['postgres://tester', '[REDACTED]@127.0.0.1/orders'].join(':'));
    expect(loaded?.messages[2]).toMatchObject({
      role: 'assistant',
      toolCalls: [
        {
          arguments: {
            apiKey: '[REDACTED]',
            databaseUrl: '[REDACTED]',
            password: '[REDACTED]',
          },
        },
      ],
    });
  });

  it('integrates with ReactAgent so completed runs are recoverable from session history', async () => {
    const store = new AgentSessionStore(await sessionPath());
    const usage = new UsageTracker(await usagePath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Read order count',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ rows: [{ order_count: 42 }] }),
    );
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          { text: '', toolCalls: [{ id: 'query_1', name: 'query_database', arguments: {} }] },
          { text: '订单总数是 42。', toolCalls: [] },
        ]),
      ]),
      registry,
      usage,
      undefined,
      {
        now: (() => {
          let tick = 0;
          return () => `2026-06-23T00:00:0${tick++}.000Z`;
        })(),
        createSessionId: () => 'session_agent_run',
        sessionStore: store,
      },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '查询订单总数',
      mode: 'readonly',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(result.session.tokenUsage.totalTokens).toBeGreaterThan(0);
    await expect(store.load('session_agent_run')).resolves.toMatchObject({
      id: 'session_agent_run',
      messages: [
        { role: 'user', content: '查询订单总数' },
        { role: 'assistant', toolCalls: [{ name: 'query_database' }] },
        { role: 'tool', toolName: 'query_database' },
        { role: 'assistant', content: '订单总数是 42。' },
      ],
    });
    await expect(store.list()).resolves.toMatchObject([
      {
        id: 'session_agent_run',
        messageCount: 4,
        toolMessageCount: 1,
        tokenUsage: { totalTokens: result.session.tokenUsage.totalTokens },
      },
    ]);
  });
});

function testSession(id: string, title: string): AgentSession {
  return {
    id,
    title,
    mode: 'readonly',
    strategy: 'react',
    messages: [
      { role: 'user', content: '分析 GMV', createdAt: '2026-06-23T00:00:00.000Z' },
      { role: 'assistant', content: '请先查看 orders.total_amount。', createdAt: '2026-06-23T00:00:01.000Z' },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    aborted: false,
  };
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat() {
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return Promise.resolve(next);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

async function sessionPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-sessions-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'agent-sessions.json');
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-session-usage-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}
