import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentPlanExecutionStore,
  createAgentSession,
  type AgentPlan,
  type AgentSession,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentPlanExecutionStore', () => {
  it('persists and updates Plan & Execute snapshots for recovery', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const plan = testPlan('plan_orders');
    const session = testSession('session_orders');

    await store.save({
      plan,
      status: 'running',
      session,
      executedSteps: 0,
      totalIterations: 0,
      now: '2026-07-09T01:00:00.000Z',
    });
    plan.steps[0]!.status = 'done';
    plan.steps[0]!.resultSummary = 'schema inspected';
    await store.save({
      plan,
      status: 'done',
      session,
      finalText: 'refund spike detected',
      executedSteps: 1,
      totalIterations: 2,
      toolExecutions: [
        {
          toolCallId: 'query_1',
          toolName: 'query_database',
          status: 'success',
          durationMs: 12,
          resultPreview: '{"rows":[{"refund_count":12}]}',
        },
      ],
      now: '2026-07-09T01:02:00.000Z',
    });

    await expect(store.load('plan_orders')).resolves.toMatchObject({
      planId: 'plan_orders',
      status: 'done',
      finalText: 'refund spike detected',
      executedSteps: 1,
      totalIterations: 2,
      createdAt: '2026-07-09T01:00:00.000Z',
      finishedAt: '2026-07-09T01:02:00.000Z',
      plan: { steps: [{ status: 'done', resultSummary: 'schema inspected' }] },
    });
  });

  it('lists running plan snapshots as recoverable work and supports abandon', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    await store.save({
      plan: testPlan('old_plan'),
      status: 'running',
      session: testSession('session_a'),
      now: '2026-07-09T01:00:00.000Z',
    });
    await store.save({
      plan: testPlan('new_plan'),
      status: 'running',
      session: testSession('session_b'),
      now: '2026-07-09T01:05:00.000Z',
    });
    await store.save({
      plan: testPlan('done_plan'),
      status: 'done',
      session: testSession('session_c'),
      now: '2026-07-09T01:06:00.000Z',
    });

    await expect(store.listRecoverable()).resolves.toMatchObject([
      { planId: 'new_plan', status: 'running' },
      { planId: 'old_plan', status: 'running' },
    ]);
    await expect(store.markAbandoned('old_plan', 'user skipped recovery', '2026-07-09T01:10:00.000Z')).resolves.toBe(
      true,
    );
    await expect(store.listRecoverable()).resolves.toMatchObject([{ planId: 'new_plan' }]);
    await expect(store.load('old_plan')).resolves.toMatchObject({
      status: 'abandoned',
      errorMessage: 'user skipped recovery',
      finishedAt: '2026-07-09T01:10:00.000Z',
    });
  });

  it('redacts secrets from plan snapshots and legacy raw files', async () => {
    const filePath = await storePath();
    const store = new AgentPlanExecutionStore(filePath);
    const apiKey = ['sk', 'plan-secret-123456'].join('-');
    const plan = testPlan('plan_secret');
    plan.plannerModelText = `Use provider ${apiKey}`;
    plan.steps[0]!.resultSummary = `Connected with ${apiKey}`;
    const session = testSession('session_secret');
    session.messages.push({
      role: 'assistant',
      content: `Provider ${apiKey} configured`,
      createdAt: '2026-07-09T01:00:01.000Z',
    });

    await store.save({
      plan,
      status: 'running',
      session,
      finalText: `Still using ${apiKey}`,
      errorMessage: `Failed with ${apiKey}`,
      toolExecutions: [
        {
          toolCallId: 'secret_1',
          toolName: 'configure_provider',
          status: 'failed',
          durationMs: 5,
          resultPreview: `apiKey=${apiKey}`,
        },
      ],
      now: '2026-07-09T01:00:00.000Z',
    });

    const serialized = JSON.stringify(await store.load('plan_secret'));

    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('sk-[REDACTED]');

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify([
        {
          planId: 'legacy_plan',
          status: 'running',
          plan: { ...testPlan('legacy_plan'), plannerModelText: apiKey },
          finalText: apiKey,
          executedSteps: 0,
          totalIterations: 0,
          toolExecutions: [],
          createdAt: '2026-07-09T01:00:00.000Z',
          updatedAt: '2026-07-09T01:00:00.000Z',
        },
      ]),
      'utf8',
    );
    const legacySerialized = JSON.stringify(await store.listRecoverable());

    expect(legacySerialized).not.toContain(apiKey);
    expect(legacySerialized).toContain('sk-[REDACTED]');
  });

  it('treats corrupt plan snapshot JSON as empty so startup can continue', async () => {
    const filePath = await storePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');
    const store = new AgentPlanExecutionStore(filePath);

    await expect(store.listRecoverable()).resolves.toEqual([]);
  });
});

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-plan-store-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'plan-executions.json');
}

function testPlan(id: string): AgentPlan {
  return {
    id,
    title: 'Order analysis',
    goal: 'Analyze order refunds',
    createdAt: '2026-07-09T01:00:00.000Z',
    plannerModelText: '{"steps":[]}',
    steps: [
      {
        id: 'inspect_schema',
        title: 'Inspect schema',
        instruction: 'Find order and refund tables.',
        status: 'pending',
      },
    ],
  };
}

function testSession(id: string): AgentSession {
  return createAgentSession({
    id,
    title: 'test',
    mode: 'readonly',
    now: () => '2026-07-09T01:00:00.000Z',
  });
}
