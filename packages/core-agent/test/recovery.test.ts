import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCheckpointStore, AgentRecoveryService, type AgentSession } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentRecoveryService', () => {
  it('builds user-facing recovery plans from running checkpoints', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    const service = new AgentRecoveryService(store);
    const apiKey = ['sk', 'recovery-secret-123456'].join('-');
    const session = testSession('session_recovery');
    session.messages.push({
      role: 'assistant',
      content: '我已经查到订单数，准备继续分析退款率。',
      toolCalls: [{ id: 'call_orders', name: 'query_database', arguments: { sql: 'select count(*) from orders', apiKey } }],
      createdAt: '2026-06-23T10:00:01.000Z',
    });
    session.messages.push({
      role: 'tool',
      toolCallId: 'call_orders',
      toolName: 'query_database',
      content: '{"rows":[{"order_count":42}]}',
      createdAt: '2026-06-23T10:00:02.000Z',
    });

    await store.save({
      session,
      iteration: 2,
      status: 'running',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 21,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
        {
          toolCallId: 'call_refunds',
          toolName: 'query_database',
          status: 'failed',
          durationMs: 8,
          resultPreview: `provider rejected ${apiKey}`,
        },
      ],
      now: '2026-06-23T10:00:03.000Z',
    });

    const plans = await service.listRecoverablePlans();

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      sessionId: 'session_recovery',
      title: '分析 GMV 下降原因',
      userMessage: '分析 GMV 下降原因',
      interruptedIteration: 2,
      completedToolCount: 1,
      failedToolCount: 1,
      deniedToolCount: 0,
      actions: ['continue', 'restart', 'abandon'],
      lastAssistantText: '我已经查到订单数，准备继续分析退款率。',
      lastToolError: 'provider rejected sk-[REDACTED]',
    });
    expect(plans[0]?.resumePrompt).toContain('请继续恢复上次中断的 Agent 任务');
    expect(plans[0]?.resumePrompt).toContain('query_database / success');
    expect(plans[0]?.resumePrompt).toContain('query_database / failed');
    expect(plans[0]?.resumePrompt).not.toContain(apiKey);
  });

  it('abandons recoverable runs so startup recovery stops prompting the user', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    const service = new AgentRecoveryService(store);
    await store.save({
      session: testSession('session_abandon'),
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-23T10:00:00.000Z',
    });

    await expect(service.listRecoverablePlans()).resolves.toHaveLength(1);
    await expect(service.abandon('session_abandon', '用户选择放弃恢复', '2026-06-23T10:05:00.000Z')).resolves.toBe(1);

    await expect(service.listRecoverablePlans()).resolves.toEqual([]);
    await expect(store.listBySession('session_abandon')).resolves.toMatchObject([
      {
        status: 'abandoned',
        errorMessage: '用户选择放弃恢复',
        finishedAt: '2026-06-23T10:05:00.000Z',
      },
    ]);
  });

  it('sorts multiple recovery plans by most recently updated first', async () => {
    const store = new AgentCheckpointStore(await checkpointPath());
    const service = new AgentRecoveryService(store);
    await store.save({
      session: testSession('old_session'),
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-23T10:00:00.000Z',
    });
    await store.save({
      session: testSession('new_session'),
      iteration: 1,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-23T10:10:00.000Z',
    });

    await expect(service.listRecoverablePlans()).resolves.toMatchObject([
      { sessionId: 'new_session' },
      { sessionId: 'old_session' },
    ]);
  });
});

async function checkpointPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'agent-checkpoints.json');
}

function testSession(id: string): AgentSession {
  return {
    id,
    title: '分析 GMV 下降原因',
    mode: 'readonly',
    strategy: 'react',
    messages: [{ role: 'user', content: '分析 GMV 下降原因', createdAt: '2026-06-23T10:00:00.000Z' }],
    tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    aborted: false,
  };
}
