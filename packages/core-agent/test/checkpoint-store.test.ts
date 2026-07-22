import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCheckpointStore, type AgentSession } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentCheckpointStore', () => {
  it('persists and updates current iteration checkpoints', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    const session = testSession('session_recover');

    await store.save({
      session,
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-18T01:00:00.000Z',
    });
    session.messages.push({ role: 'assistant', content: 'running tools', createdAt: '2026-06-18T01:00:01.000Z' });
    await store.save({
      session,
      iteration: 1,
      status: 'done',
      toolExecutions: [
        {
          toolCallId: 'call_1',
          toolName: 'query_database',
          status: 'success',
          durationMs: 12,
          resultPreview: '{"rows":[{"count":42}]}',
        },
      ],
      finalText: '完成',
      now: '2026-06-18T01:00:02.000Z',
    });

    const checkpoints = await store.listBySession('session_recover');

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      sessionId: 'session_recover',
      iteration: 1,
      status: 'done',
      finalText: '完成',
      startedAt: '2026-06-18T01:00:00.000Z',
      finishedAt: '2026-06-18T01:00:02.000Z',
      toolExecutions: [{ toolName: 'query_database', status: 'success' }],
    });
  });

  it('lists running checkpoints as recoverable startup work', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    await store.save({
      session: testSession('old_running'),
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-18T01:00:00.000Z',
    });
    await store.save({
      session: testSession('new_running'),
      iteration: 2,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-18T01:05:00.000Z',
    });
    await store.save({
      session: testSession('done'),
      iteration: 1,
      status: 'done',
      toolExecutions: [],
      now: '2026-06-18T01:06:00.000Z',
    });

    await expect(store.listRecoverable()).resolves.toMatchObject([
      { sessionId: 'new_running', status: 'running' },
      { sessionId: 'old_running', status: 'running' },
    ]);
  });

  it('marks interrupted running checkpoints without touching completed work', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    await store.save({
      session: testSession('session_interrupted'),
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-18T01:00:00.000Z',
    });
    await store.save({
      session: testSession('session_interrupted'),
      iteration: 2,
      status: 'done',
      toolExecutions: [],
      now: '2026-06-18T01:01:00.000Z',
    });

    await expect(
      store.markInterrupted('session_interrupted', '应用重启前任务中断', '2026-06-18T01:10:00.000Z'),
    ).resolves.toBe(1);
    await expect(store.listBySession('session_interrupted')).resolves.toMatchObject([
      { iteration: 1, status: 'failed', errorMessage: '应用重启前任务中断' },
      { iteration: 2, status: 'done' },
    ]);
  });

  it('treats corrupt checkpoint JSON as empty so startup can continue', async () => {
    const filePath = await checkpointPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');
    const store = new AgentCheckpointStore(filePath);

    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('redacts secrets from checkpoint snapshots and tool execution previews', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    const apiKey = ['sk', 'checkpoint-secret-123456'].join('-');
    const bearerToken = 'token-checkpoint-secret-123456';
    const connectionString = 'postgresql://tester:localpass@127.0.0.1/app';
    const session = testSession('session_redacted');
    session.messages.push({
      role: 'assistant',
      content: '准备调用远程 provider',
      toolCalls: [
        {
          id: 'call_secret',
          name: 'configure_provider',
          arguments: {
            apiKey,
            password: 'db-pass',
            headers: { authorization: `Bearer ${bearerToken}` },
            connectionString,
          },
        },
      ],
      createdAt: '2026-06-18T01:00:01.000Z',
    });

    await store.save({
      session,
      iteration: 1,
      status: 'failed',
      toolExecutions: [
        {
          toolCallId: 'call_secret',
          toolName: 'configure_provider',
          status: 'failed',
          durationMs: 3,
          resultPreview: JSON.stringify({
            apiKey,
            password: 'db-pass',
            dsn: connectionString,
            header: `Bearer ${bearerToken}`,
          }),
        },
      ],
      finalText: `Provider ${apiKey} failed.`,
      errorMessage: `Authorization failed: Bearer ${bearerToken}`,
      now: '2026-06-18T01:00:02.000Z',
    });

    const serialized = JSON.stringify(await store.listBySession('session_redacted'));

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain('localpass');
    expect(serialized).not.toContain('db-pass');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('"tokenUsage":{"promptTokens":0,"completionTokens":0,"totalTokens":0}');
  });

  it('redacts legacy raw checkpoint files when reading them', async () => {
    const filePath = await checkpointPath();
    const apiKey = ['sk', 'legacy-secret-123456'].join('-');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify([
        {
          id: 'checkpoint_legacy',
          sessionId: 'session_legacy',
          iteration: 1,
          status: 'running',
          session: testSession('session_legacy'),
          toolExecutions: [],
          finalText: `raw ${apiKey}`,
          startedAt: '2026-06-18T01:00:00.000Z',
          updatedAt: '2026-06-18T01:00:00.000Z',
        },
      ]),
      'utf8',
    );
    const store = new AgentCheckpointStore(filePath);

    const serialized = JSON.stringify(await store.listRecoverable());

    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('sk-[REDACTED]');
  });
});

async function checkpointPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-checkpoints-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'agent-checkpoints.json');
}

function testSession(id: string): AgentSession {
  return {
    id,
    title: '测试任务',
    mode: 'readonly',
    strategy: 'react',
    messages: [{ role: 'user', content: '分析订单', createdAt: '2026-06-18T01:00:00.000Z' }],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    aborted: false,
  };
}
