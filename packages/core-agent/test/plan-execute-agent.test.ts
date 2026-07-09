import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import {
  AgentPlanExecutionStore,
  createAgentSession,
  PlanExecuteAgent,
  type AgentPlan,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentToolExecutionRecord,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PlanExecuteAgent', () => {
  it('plans a business task and executes ordered ReAct steps in one session', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: JSON.stringify({
          title: 'Order refund analysis',
          steps: [
            {
              id: 'inspect_schema',
              title: 'Inspect schema',
              instruction: 'Find tables related to orders, refunds, and payments.',
            },
            {
              id: 'analyze_refunds',
              title: 'Analyze refunds',
              instruction: 'Query refund amount by day and detect abnormal spikes.',
            },
          ],
        }),
        toolCalls: [],
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      },
    ]);
    const runner = scriptedRunner([
      successfulRun('schema inspected', 2, [toolRecord('schema_1', 'schema_search', 'success')]),
      successfulRun('refund spike detected', 3, [toolRecord('sql_1', 'query_database', 'success')]),
    ]);
    const agent = new PlanExecuteAgent(new LlmRouter(usage, [provider]), runner, fixedDependencies());

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Analyze whether refund activity had abnormal spikes last week.',
      mode: 'readonly',
      allowedTools: ['schema_search', 'query_database'],
      maxPlanSteps: 5,
    });

    expect(result.status).toBe('done');
    expect(result.executedSteps).toBe(2);
    expect(result.totalIterations).toBe(5);
    expect(result.finalText).toBe('refund spike detected');
    expect(result.plan).toMatchObject({
      title: 'Order refund analysis',
      steps: [
        { id: 'inspect_schema', status: 'done', runStatus: 'done', iterations: 2 },
        { id: 'analyze_refunds', status: 'done', runStatus: 'done', iterations: 3 },
      ],
    });
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'schema_1', toolName: 'schema_search', status: 'success' },
      { toolCallId: 'sql_1', toolName: 'query_database', status: 'success' },
    ]);
    expect(runner.calls.map((call) => call.userMessage)).toEqual([
      expect.stringContaining('Instruction: Find tables related to orders, refunds, and payments.'),
      expect.stringContaining('Completed step summaries:\n- Inspect schema: schema inspected'),
    ]);
    expect(runner.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      allowedTools: ['schema_search', 'query_database'],
      initialIteration: 0,
    });
    expect(runner.calls[1]?.initialSession?.id).toBe('session_test');
    expect(runner.calls[1]?.initialIteration).toBe(2);
    expect(calls[0]).toMatchObject({
      model: 'fake-model',
      temperature: 0,
    });
    expect(calls[0]?.messages[1]?.content).toContain('Max steps: 5');
    await expect(usage.current()).resolves.toMatchObject({ byokTokenEstimate: 50 });
  });

  it('persists plan progress snapshots while executing steps', async () => {
    const usage = new UsageTracker(await usagePath());
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    const provider = scriptedProvider([
      {
        text: JSON.stringify({
          title: 'Revenue investigation',
          steps: [
            { id: 'inspect_schema', title: 'Inspect schema', instruction: 'Inspect revenue tables.' },
            { id: 'run_query', title: 'Run query', instruction: 'Query daily revenue.' },
          ],
        }),
        toolCalls: [],
      },
    ]);
    const runner = scriptedRunner([
      successfulRun('schema inspected', 1, [toolRecord('schema_1', 'search_schema', 'success')]),
      successfulRun('daily revenue checked', 2, [toolRecord('query_1', 'query_database', 'success')]),
    ]);
    const agent = new PlanExecuteAgent(new LlmRouter(usage, [provider]), runner, {
      ...fixedDependencies(),
      createPlanId: () => 'plan_persisted',
      planStore,
    });

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Investigate revenue movement.',
      mode: 'readonly',
    });
    const snapshot = await planStore.load('plan_persisted');

    expect(result.status).toBe('done');
    expect(snapshot).toMatchObject({
      planId: 'plan_persisted',
      status: 'done',
      finalText: 'daily revenue checked',
      executedSteps: 2,
      totalIterations: 3,
      session: { id: 'session_test' },
      plan: {
        steps: [
          { id: 'inspect_schema', status: 'done', resultSummary: 'schema inspected' },
          { id: 'run_query', status: 'done', resultSummary: 'daily revenue checked' },
        ],
      },
      toolExecutions: [
        { toolCallId: 'schema_1', toolName: 'search_schema', status: 'success' },
        { toolCallId: 'query_1', toolName: 'query_database', status: 'success' },
      ],
    });
    await expect(planStore.listRecoverable()).resolves.toEqual([]);
  });

  it('stops and skips remaining steps when a ReAct step fails', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: '```json\n{"title":"Traffic anomaly","steps":[{"id":"find_events","title":"Find events","instruction":"Inspect event tables."},{"id":"run_query","title":"Run query","instruction":"Calculate conversion drop."},{"id":"write_report","title":"Write report","instruction":"Summarize findings."}]}\n```',
        toolCalls: [],
      },
    ]);
    const runner = scriptedRunner([
      failedRun('Permission denied.', 1, [toolRecord('write_1', 'execute_sql', 'denied')]),
    ]);
    const agent = new PlanExecuteAgent(new LlmRouter(usage, [provider]), runner, fixedDependencies());

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Investigate traffic conversion anomaly.',
      mode: 'readonly',
      stopOnStepFailure: true,
    });

    expect(result.status).toBe('failed');
    expect(result.executedSteps).toBe(1);
    expect(result.finalText).toContain('Plan step failed: Find events');
    expect(result.plan.steps).toMatchObject([
      { id: 'find_events', status: 'failed', runStatus: 'permission_denied' },
      { id: 'run_query', status: 'skipped', failureReason: 'Previous plan step failed.' },
      { id: 'write_report', status: 'skipped', failureReason: 'Previous plan step failed.' },
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(result.toolExecutions).toMatchObject([{ toolName: 'execute_sql', status: 'denied' }]);
  });

  it('does not execute steps when the planner returns invalid JSON', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([{ text: 'not json', toolCalls: [] }]);
    const runner = scriptedRunner([]);
    const agent = new PlanExecuteAgent(new LlmRouter(usage, [provider]), runner, fixedDependencies());

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Analyze customer retention.',
      mode: 'readonly',
    });

    expect(result.status).toBe('planning_failed');
    expect(result.executedSteps).toBe(0);
    expect(result.plan.steps).toEqual([]);
    expect(result.finalText).toContain('Agent planning failed');
    expect(runner.calls).toEqual([]);
  });

  it('resumes from a persisted plan without replanning or repeating completed steps', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([]);
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    const initialPlan = recoveredPlan();
    const runner = scriptedRunner([
      successfulRun('refund spike verified', 2, [toolRecord('query_2', 'query_database', 'success')]),
    ]);
    const agent = new PlanExecuteAgent(new LlmRouter(usage, [provider]), runner, {
      ...fixedDependencies(),
      planStore,
    });

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Resume refund analysis.',
      mode: 'readonly',
      initialPlan,
      initialSession: testSession(),
      initialExecutedSteps: 1,
      initialTotalIterations: 3,
    });

    expect(calls).toEqual([]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ initialIteration: 3 });
    expect(runner.calls[0]?.userMessage).toContain('Completed step summaries:\n- Inspect schema: orders and refunds located');
    expect(result.status).toBe('done');
    expect(result.executedSteps).toBe(2);
    expect(result.totalIterations).toBe(5);
    expect(result.plan.steps).toMatchObject([
      { id: 'inspect_schema', status: 'done' },
      { id: 'run_query', status: 'done', resultSummary: 'refund spike verified' },
    ]);
    await expect(planStore.load('plan_recovered')).resolves.toMatchObject({
      status: 'done',
      executedSteps: 2,
      totalIterations: 5,
    });
  });
});

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return scriptedProviderWithCalls(script).provider;
}

function scriptedProviderWithCalls(script: LlmChatResponse[]): { provider: LlmProvider; calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat(request) {
      calls.push(request);
      const next = script.shift();
      if (!next) throw new Error('No scripted planner response left.');
      return Promise.resolve(next);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
  return { provider, calls };
}

function scriptedRunner(results: AgentRunResult[]) {
  return {
    calls: [] as AgentRunOptions[],
    run(options: AgentRunOptions): Promise<AgentRunResult> {
      this.calls.push(options);
      const next = results.shift();
      if (!next) throw new Error('No scripted step result left.');
      const session = options.initialSession ?? testSession();
      return Promise.resolve({
        ...next,
        session,
      });
    },
  };
}

function successfulRun(
  finalText: string,
  iterations: number,
  toolExecutions: AgentRunResult['toolExecutions'],
): AgentRunResult {
  return {
    status: 'done',
    session: testSession(),
    finalText,
    iterations,
    toolExecutions,
    contextCompression: [],
  };
}

function failedRun(
  finalText: string,
  iterations: number,
  toolExecutions: AgentRunResult['toolExecutions'],
): AgentRunResult {
  return {
    status: 'permission_denied',
    session: testSession(),
    finalText,
    iterations,
    toolExecutions,
    contextCompression: [],
  };
}

function testSession(): AgentSession {
  return createAgentSession({
    id: 'session_test',
    title: 'test',
    mode: 'readonly',
    now: fixedDependencies().now,
  });
}

function toolRecord(
  toolCallId: string,
  toolName: string,
  status: AgentToolExecutionRecord['status'],
): AgentToolExecutionRecord {
  return {
    toolCallId,
    toolName,
    status,
    durationMs: 5,
    resultPreview: status === 'success' ? '{"ok":true}' : 'Permission denied.',
  };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-plan-execute-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

async function planStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-plan-execute-store-'));
  tempDirs.push(dir);
  return join(dir, 'plan-executions.json');
}

function fixedDependencies() {
  return {
    now: () => '2026-07-09T00:00:00.000Z',
  };
}

function recoveredPlan(): AgentPlan {
  return {
    id: 'plan_recovered',
    title: 'Recovered refund analysis',
    goal: 'Analyze refunds after crash.',
    createdAt: '2026-07-09T00:00:00.000Z',
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
