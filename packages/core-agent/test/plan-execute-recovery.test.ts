import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentPlanExecutionStore,
  AgentPlanRecoveryService,
  createAgentSession,
  type AgentPlan,
  type AgentPlanExecuteOptions,
  type AgentPlanExecuteResult,
  type AgentPlanRecoveryRunner,
  type AgentSession,
  type AgentToolExecutionRecord,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentPlanRecoveryService', () => {
  it('lists recoverable Plan & Execute snapshots with user-facing resume summaries', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('old_plan'),
      status: 'running',
      session: testSession('session_old'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 2,
      toolExecutions: [toolRecord('schema_1', 'search_schema', 'success', '{"tables":["orders"]}')],
      now: '2026-07-09T01:00:00.000Z',
    });
    const newPlan = recoveredPlan('new_plan');
    newPlan.steps[1]!.status = 'running';
    await store.save({
      plan: newPlan,
      status: 'running',
      session: testSession('session_new'),
      finalText: 'query running',
      executedSteps: 1,
      totalIterations: 4,
      toolExecutions: [
        toolRecord('schema_2', 'search_schema', 'success', '{"tables":["refunds"]}'),
        toolRecord('query_bad', 'query_database', 'failed', 'column missing_column does not exist'),
      ],
      now: '2026-07-09T01:05:00.000Z',
    });

    const plans = await recovery.listRecoverablePlans();

    expect(plans).toMatchObject([
      {
        planId: 'new_plan',
        sessionId: 'session_new',
        interruptedStepId: 'run_query',
        interruptedStepTitle: 'Run query',
        completedStepCount: 1,
        pendingStepCount: 1,
        executedSteps: 1,
        totalIterations: 4,
        lastToolError: 'column missing_column does not exist',
        actions: ['continue', 'restart', 'abandon'],
      },
      { planId: 'old_plan' },
    ]);
    expect(plans[0]?.resumePrompt).toContain('请继续恢复上次中断的 Plan & Execute 任务。');
    expect(plans[0]?.resumePrompt).toContain('不要无理由重复已经 done 的步骤');
    expect(plans[0]?.resumePrompt).toContain('query_database / failed');
  });

  it('continues a running plan through a runner and clears recoverable work after success', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    const snapshotPlan = recoveredPlan('plan_continue_success');
    await store.save({
      plan: snapshotPlan,
      status: 'running',
      session: testSession('session_continue_success'),
      executedSteps: 1,
      totalIterations: 3,
      toolExecutions: [toolRecord('schema_1', 'search_schema', 'success', '{"tables":["refunds"]}')],
      now: '2026-07-09T01:00:00.000Z',
    });
    const runner = scriptedPlanRunner([
      successfulPlanResult(continuedPlan('plan_continue_success'), testSession('session_continue_success')),
    ]);

    const continued = await recovery.continue('plan_continue_success', runner, {
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 2,
      now: '2026-07-09T01:10:00.000Z',
    });

    expect(continued.result.status).toBe('done');
    expect(continued.abandonedSnapshot).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 2,
      initialExecutedSteps: 1,
      initialTotalIterations: 3,
      mode: 'readonly',
    });
    expect(runner.calls[0]?.initialPlan?.id).toBe('plan_continue_success');
    expect(runner.calls[0]?.initialSession?.id).toBe('session_continue_success');
    expect(runner.calls[0]?.userMessage).toContain('原始目标：Analyze refunds after crash.');
    await expect(recovery.listRecoverablePlans()).resolves.toEqual([]);
    await expect(store.load('plan_continue_success')).resolves.toMatchObject({
      status: 'done',
      finalText: 'refund spike verified',
      executedSteps: 2,
      totalIterations: 5,
    });
  });

  it('keeps the original snapshot recoverable when continuation returns a failed status', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('plan_failed_status'),
      status: 'running',
      session: testSession('session_failed_status'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 3,
      now: '2026-07-09T01:00:00.000Z',
    });
    const failedPlan = recoveredPlan('plan_failed_status');
    failedPlan.steps[1]!.status = 'failed';
    failedPlan.steps[1]!.failureReason = 'Permission denied.';
    const runner = scriptedPlanRunner([failedPlanResult(failedPlan, testSession('session_failed_status'))]);

    const continued = await recovery.continue('plan_failed_status', runner, {
      providerId: 'fake',
      model: 'fake-model',
      now: '2026-07-09T01:12:00.000Z',
    });

    expect(continued.result.status).toBe('failed');
    expect(continued.abandonedSnapshot).toBe(false);
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      {
        planId: 'plan_failed_status',
        executedSteps: 1,
        totalIterations: 3,
        updatedAt: '2026-07-09T01:12:00.000Z',
      },
    ]);
    await expect(store.load('plan_failed_status')).resolves.toMatchObject({
      status: 'running',
      finalText: 'schema inspected',
      plan: { steps: [{ status: 'done' }, { status: 'pending' }] },
    });
  });

  it.each(['failed', 'aborted', 'planning_failed'] as const)(
    'keeps the original snapshot recoverable when continuation returns %s',
    async (status) => {
      const store = new AgentPlanExecutionStore(await storePath());
      const recovery = new AgentPlanRecoveryService(store);
      await store.save({
        plan: recoveredPlan(`plan_${status}`),
        status: 'running',
        session: testSession(`session_${status}`),
        finalText: 'schema inspected',
        executedSteps: 1,
        totalIterations: 3,
        now: '2026-07-09T01:00:00.000Z',
      });
      const resultPlan = recoveredPlan(`plan_${status}`);
      resultPlan.steps[1]!.status = status === 'aborted' ? 'skipped' : 'failed';
      const runner = scriptedPlanRunner([
        {
          status,
          plan: resultPlan,
          session: testSession(`session_${status}`),
          finalText: `${status} result should not replace running recovery snapshot`,
          executedSteps: 2,
          totalIterations: 4,
          toolExecutions: [toolRecord('tool_1', 'query_database', 'failed', status)],
          contextCompression: [],
        },
      ]);

      const continued = await recovery.continue(`plan_${status}`, runner, {
        providerId: 'fake',
        model: 'fake-model',
        now: '2026-07-09T01:12:00.000Z',
      });

      expect(continued.result.status).toBe(status);
      expect(continued.abandonedSnapshot).toBe(false);
      await expect(store.load(`plan_${status}`)).resolves.toMatchObject({
        status: 'running',
        finalText: 'schema inspected',
        executedSteps: 1,
        totalIterations: 3,
        plan: { steps: [{ status: 'done' }, { status: 'pending' }] },
        updatedAt: '2026-07-09T01:12:00.000Z',
      });
    },
  );

  it('keeps the original snapshot recoverable when the runner throws', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('plan_runner_error'),
      status: 'running',
      session: testSession('session_runner_error'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 3,
      now: '2026-07-09T01:00:00.000Z',
    });
    let capturedOptions: AgentPlanExecuteOptions | undefined;
    const runner: AgentPlanRecoveryRunner = {
      run(options) {
        capturedOptions = options;
        return Promise.reject(new Error('provider failed during plan recovery'));
      },
    };

    await expect(
      recovery.continue('plan_runner_error', runner, {
        providerId: 'fake',
        model: 'fake-model',
        now: '2026-07-09T01:15:00.000Z',
      }),
    ).rejects.toThrow('provider failed during plan recovery');

    expect(capturedOptions?.initialPlan?.id).toBe('plan_runner_error');
    expect(capturedOptions?.initialExecutedSteps).toBe(1);
    expect(capturedOptions?.initialTotalIterations).toBe(3);
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      {
        planId: 'plan_runner_error',
        executedSteps: 1,
        totalIterations: 3,
        updatedAt: '2026-07-09T01:15:00.000Z',
      },
    ]);
  });

  it('restarts a recoverable plan from the original goal and abandons the old snapshot after success', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('plan_restart_success'),
      status: 'running',
      session: testSession('session_restart_success'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 3,
      now: '2026-07-09T01:00:00.000Z',
    });
    const runner = scriptedPlanRunner([
      successfulPlanResult(continuedPlan('plan_restart_new'), testSession('session_restart_new')),
    ]);

    const restarted = await recovery.restart('plan_restart_success', runner, {
      providerId: 'fake',
      model: 'fake-model',
      allowedTools: ['query_database'],
      now: '2026-07-09T01:30:00.000Z',
    });

    expect(restarted.result.status).toBe('done');
    expect(restarted.abandonedSnapshot).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      allowedTools: ['query_database'],
      mode: 'readonly',
    });
    expect(runner.calls[0]?.initialPlan).toBeUndefined();
    expect(runner.calls[0]?.initialSession).toBeUndefined();
    expect(runner.calls[0]?.initialExecutedSteps).toBeUndefined();
    expect(runner.calls[0]?.initialTotalIterations).toBeUndefined();
    expect(runner.calls[0]?.userMessage).toContain('Restart the interrupted Plan & Execute task from a clean plan.');
    expect(runner.calls[0]?.userMessage).toContain('Original goal: Analyze refunds after crash.');
    await expect(store.load('plan_restart_success')).resolves.toMatchObject({
      status: 'abandoned',
      errorMessage: 'Restarted Plan & Execute task completed successfully.',
      finishedAt: '2026-07-09T01:30:00.000Z',
    });
    await expect(store.load('plan_restart_new')).resolves.toMatchObject({
      status: 'done',
      finalText: 'refund spike verified',
      executedSteps: 2,
      totalIterations: 5,
    });
    await expect(recovery.listRecoverablePlans()).resolves.toEqual([]);
  });

  it('keeps the original snapshot recoverable when restart returns a failed status', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('plan_restart_failed'),
      status: 'running',
      session: testSession('session_restart_failed'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 3,
      now: '2026-07-09T01:00:00.000Z',
    });
    const failedPlan = recoveredPlan('plan_restart_new_failed');
    failedPlan.steps[0]!.status = 'failed';
    const runner = scriptedPlanRunner([failedPlanResult(failedPlan, testSession('session_restart_new_failed'))]);

    const restarted = await recovery.restart('plan_restart_failed', runner, {
      providerId: 'fake',
      model: 'fake-model',
      now: '2026-07-09T01:35:00.000Z',
    });

    expect(restarted.result.status).toBe('failed');
    expect(restarted.abandonedSnapshot).toBe(false);
    await expect(store.load('plan_restart_failed')).resolves.toMatchObject({
      status: 'running',
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 3,
      updatedAt: '2026-07-09T01:35:00.000Z',
    });
    await expect(store.load('plan_restart_new_failed')).resolves.toBeUndefined();
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      { planId: 'plan_restart_failed', executedSteps: 1, totalIterations: 3 },
    ]);
  });

  it('abandons a recoverable plan snapshot', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    await store.save({
      plan: recoveredPlan('plan_abandon'),
      status: 'running',
      session: testSession('session_abandon'),
      now: '2026-07-09T01:00:00.000Z',
    });

    await expect(recovery.abandon('plan_abandon', 'manual cleanup', '2026-07-09T01:20:00.000Z')).resolves.toBe(true);
    await expect(recovery.listRecoverablePlans()).resolves.toEqual([]);
    await expect(store.load('plan_abandon')).resolves.toMatchObject({
      status: 'abandoned',
      errorMessage: 'manual cleanup',
      finishedAt: '2026-07-09T01:20:00.000Z',
    });
  });

  it('does not leak secrets through recovery summaries or resume prompts', async () => {
    const store = new AgentPlanExecutionStore(await storePath());
    const recovery = new AgentPlanRecoveryService(store);
    const apiKey = ['sk', 'recovery-secret-123456'].join('-');
    const plan = recoveredPlan('plan_secret_recovery');
    plan.goal = `Analyze refunds with provider ${apiKey}`;
    plan.steps[0]!.resultSummary = `schema loaded with ${apiKey}`;
    plan.steps[1]!.failureReason = `query failed with ${apiKey}`;
    plan.steps[1]!.status = 'failed';
    await store.save({
      plan,
      status: 'running',
      session: testSession('session_secret_recovery'),
      finalText: `partial result ${apiKey}`,
      executedSteps: 1,
      totalIterations: 3,
      toolExecutions: [toolRecord('secret_tool', 'query_database', 'failed', `tool failed with ${apiKey}`)],
      now: '2026-07-09T01:00:00.000Z',
    });

    const [summary] = await recovery.listRecoverablePlans();
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('sk-[REDACTED]');
    expect(summary?.resumePrompt).toContain('Analyze refunds with provider sk-[REDACTED]');
    expect(summary?.resumePrompt).not.toContain('{recoveryPlan.goal}');
    expect(summary?.lastResultText).not.toContain(apiKey);
    expect(summary?.lastToolError).not.toContain(apiKey);
  });
});

function scriptedPlanRunner(results: AgentPlanExecuteResult[]) {
  return {
    calls: [] as AgentPlanExecuteOptions[],
    run(options: AgentPlanExecuteOptions): Promise<AgentPlanExecuteResult> {
      this.calls.push(options);
      const next = results.shift();
      if (!next) throw new Error('No scripted plan result left.');
      return Promise.resolve(next);
    },
  };
}

function successfulPlanResult(plan: AgentPlan, session: AgentSession): AgentPlanExecuteResult {
  return {
    status: 'done',
    plan,
    session,
    finalText: 'refund spike verified',
    executedSteps: 2,
    totalIterations: 5,
    toolExecutions: [toolRecord('query_2', 'query_database', 'success', '{"rows":[{"refund_count":12}]}')],
    contextCompression: [],
  };
}

function failedPlanResult(plan: AgentPlan, session: AgentSession): AgentPlanExecuteResult {
  return {
    status: 'failed',
    plan,
    session,
    finalText: 'Plan step failed: Permission denied.',
    executedSteps: 2,
    totalIterations: 4,
    toolExecutions: [toolRecord('write_1', 'execute_sql', 'denied', 'Permission denied.')],
    contextCompression: [],
  };
}

function recoveredPlan(id: string): AgentPlan {
  return {
    id,
    title: 'Recovered refund analysis',
    goal: 'Analyze refunds after crash.',
    createdAt: '2026-07-09T01:00:00.000Z',
    plannerModelText: '{"title":"Recovered refund analysis"}',
    steps: [
      {
        id: 'inspect_schema',
        title: 'Inspect schema',
        instruction: 'Find order and refund tables.',
        status: 'done',
        resultSummary: 'orders and refunds located',
        runStatus: 'done',
        iterations: 3,
      },
      {
        id: 'run_query',
        title: 'Run query',
        instruction: 'Query refund spike.',
        status: 'pending',
      },
    ],
  };
}

function continuedPlan(id: string): AgentPlan {
  const plan = recoveredPlan(id);
  plan.steps[1] = {
    ...plan.steps[1]!,
    status: 'done',
    resultSummary: 'refund spike verified',
    runStatus: 'done',
    iterations: 2,
  };
  return plan;
}

function toolRecord(
  toolCallId: string,
  toolName: string,
  status: AgentToolExecutionRecord['status'],
  resultPreview: string,
): AgentToolExecutionRecord {
  return {
    toolCallId,
    toolName,
    status,
    durationMs: 10,
    resultPreview,
  };
}

function testSession(id: string): AgentSession {
  const session = createAgentSession({
    id,
    title: 'Recovered task',
    mode: 'readonly',
    now: () => '2026-07-09T01:00:00.000Z',
  });
  session.messages.push({ role: 'user', content: 'Analyze refunds after crash.', createdAt: '2026-07-09T01:00:00.000Z' });
  return session;
}

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-plan-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'plan-executions.json');
}
