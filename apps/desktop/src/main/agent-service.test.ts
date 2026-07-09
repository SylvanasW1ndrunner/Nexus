import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentAuditLogStore,
  AgentPlanExecutionStore,
  AgentPlanRecoveryService,
  createAgentSession,
  type AgentPlan,
  PlanExecuteAgent,
  ReactAgent,
  ToolRegistry,
  type AgentAuditLogWriter,
} from '@dbagent/core-agent';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { parseSkillDefinition, type SkillDefinition } from '@dbagent/core-skills';
import { UsageTracker } from '@dbagent/core-usage';
import { DailyAgentAuditLogStore } from './agent-audit-log.js';
import { HeadlessAgentService } from './agent-service.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('HeadlessAgentService', () => {
  it('previews policy and matches an eligible Skill without calling the model', async () => {
    const provider = scriptedProvider([]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill(), pythonAnalysisSkill()],
    });

    const match = await service.matchSkills({
      userInput: '请生成昨日 GMV 日报',
      mode: 'readonly',
    });

    expect(provider.requests).toEqual([]);
    expect(match.toolPolicy.allowedToolNames).toEqual(['list_tables', 'describe_table', 'query_database']);
    expect(match.selectedSkill?.skill.name).toBe('daily_gmv_report');
    expect(match.selectedSkill?.availableTools).toEqual(['query_database']);
    expect(match.candidates.find((candidate) => candidate.skill.name === 'daily_gmv_report')).toMatchObject({
      eligible: true,
      missingTools: [],
    });
  });

  it('runs a matched Skill through ReactAgent and exposes only the Skill tool intersection', async () => {
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_query', name: 'query_database', arguments: { sql: 'select 100 as gmv' } }],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
      {
        text: '昨日 GMV 是 100。',
        toolCalls: [],
        usage: { promptTokens: 16, completionTokens: 6, totalTokens: 22 },
      },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
    });

    const result = await service.run({
      runId: 'run_daily_gmv',
      providerId: 'fake',
      model: 'fake-model',
      userInput: '请生成昨日 GMV 日报',
      mode: 'readonly',
      maxIterations: 2,
    });

    expect(result).toMatchObject({
      runId: 'run_daily_gmv',
      strategy: 'react',
      status: 'done',
      sessionId: 'session_agent_service',
      finalText: '昨日 GMV 是 100。',
      selectedSkill: { skill: { name: 'daily_gmv_report' } },
      toolExecutions: [{ toolCallId: 'call_query', toolName: 'query_database', status: 'success' }],
    });
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
    expect(result.toolPolicy.allowedToolNames).toEqual(['query_database']);
  });

  it('runs an explicitly requested Plan & Execute Skill and returns a serializable plan summary', async () => {
    const provider = scriptedProvider([
      {
        text: JSON.stringify({
          title: 'GMV drop investigation',
          steps: [
            {
              id: 'inspect_gmv',
              title: 'Inspect GMV',
              instruction: 'Query GMV and summarize the drop.',
            },
          ],
        }),
        toolCalls: [],
      },
      {
        text: '',
        toolCalls: [{ id: 'call_query', name: 'query_database', arguments: { sql: 'select 100 as gmv' } }],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      },
      {
        text: 'GMV drop investigation completed.',
        toolCalls: [],
        usage: { promptTokens: 24, completionTokens: 6, totalTokens: 30 },
      },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
    });

    const result = await service.run({
      runId: 'run_plan_gmv',
      providerId: 'fake',
      model: 'fake-model',
      strategy: 'plan-execute',
      userInput: 'daily_gmv_report: Analyze GMV drop reason step-by-step',
      mode: 'readonly',
      maxIterations: 2,
      maxPlanSteps: 3,
    });

    expect(result).toMatchObject({
      runId: 'run_plan_gmv',
      strategy: 'plan-execute',
      status: 'done',
      finalText: 'GMV drop investigation completed.',
      iterations: 2,
      executedSteps: 1,
      totalIterations: 2,
      selectedSkill: { skill: { name: 'daily_gmv_report' } },
      plan: {
        title: 'GMV drop investigation',
        steps: [
          {
            id: 'inspect_gmv',
            title: 'Inspect GMV',
            status: 'done',
            runStatus: 'done',
            iterations: 2,
          },
        ],
      },
      toolExecutions: [{ toolCallId: 'call_query', toolName: 'query_database', status: 'success' }],
    });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[1]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
  });

  it('auto-selects Plan & Execute for complex investigation tasks', async () => {
    const provider = scriptedProvider([
      {
        text: JSON.stringify({
          title: 'GMV root cause plan',
          steps: [{ id: 'inspect', title: 'Inspect', instruction: 'Inspect GMV symptoms.' }],
        }),
        toolCalls: [],
      },
      { text: 'No tool needed for this test.', toolCalls: [] },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
    });

    const result = await service.run({
      runId: 'run_auto_plan',
      providerId: 'fake',
      model: 'fake-model',
      strategy: 'auto',
      userInput: 'daily_gmv_report: investigate root cause of GMV drop',
      mode: 'readonly',
      maxIterations: 1,
    });

    expect(result.strategy).toBe('plan-execute');
    expect(result.plan?.title).toBe('GMV root cause plan');
  });

  it('lists recoverable Plan & Execute snapshots for desktop recovery', async () => {
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    await planStore.save({
      plan: recoverablePlan('plan_recoverable_list'),
      status: 'running',
      session: testAgentSession('session_recoverable_list'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 2,
      toolExecutions: [
        {
          toolCallId: 'call_schema',
          toolName: 'describe_table',
          status: 'success',
          durationMs: 3,
          resultPreview: '{"table":"orders"}',
        },
      ],
      now: '2026-06-17T00:05:00.000Z',
    });
    const service = await createService({
      provider: scriptedProvider([]),
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
      planStore,
    });

    const result = await service.listRecoverablePlans();

    expect(result.plans).toMatchObject([
      {
        planId: 'plan_recoverable_list',
        sessionId: 'session_recoverable_list',
        title: 'Recoverable GMV plan',
        interruptedStepId: 'run_query',
        interruptedStepTitle: 'Run query',
        completedStepCount: 1,
        pendingStepCount: 1,
        executedSteps: 1,
        totalIterations: 2,
        actions: ['continue', 'restart', 'abandon'],
      },
    ]);
    expect(result.plans[0]?.resumePrompt).toContain('Plan & Execute');
  });

  it('continues a recoverable Plan & Execute snapshot through desktop service', async () => {
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    await planStore.save({
      plan: recoverablePlan('plan_continue_desktop'),
      status: 'running',
      session: testAgentSession('session_continue_desktop'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 1,
      toolExecutions: [],
      now: '2026-06-17T00:05:00.000Z',
    });
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_query_after_recovery', name: 'query_database', arguments: { sql: 'select 100 as gmv' } }],
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
      {
        text: 'Recovered plan completed.',
        toolCalls: [],
        usage: { promptTokens: 24, completionTokens: 5, totalTokens: 29 },
      },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
      planStore,
    });

    const result = await service.continuePlan({
      planId: 'plan_continue_desktop',
      runId: 'run_continue_desktop',
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      maxIterations: 2,
    });

    expect(result).toMatchObject({
      runId: 'run_continue_desktop',
      strategy: 'plan-execute',
      status: 'done',
      finalText: 'Recovered plan completed.',
      abandonedSnapshot: true,
      recoveryPlan: {
        planId: 'plan_continue_desktop',
        executedSteps: 1,
        totalIterations: 1,
      },
      plan: {
        id: 'plan_continue_desktop',
        steps: [
          { id: 'inspect_schema', status: 'done' },
          { id: 'run_query', status: 'done', runStatus: 'done' },
        ],
      },
      toolExecutions: [{ toolCallId: 'call_query_after_recovery', toolName: 'query_database', status: 'success' }],
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'list_tables',
      'describe_table',
      'query_database',
    ]);
    expect(result.toolPolicy.allowedToolNames).toEqual(['list_tables', 'describe_table', 'query_database']);
    await expect(service.listRecoverablePlans()).resolves.toEqual({ plans: [] });
    await expect(planStore.load('plan_continue_desktop')).resolves.toMatchObject({
      status: 'done',
      executedSteps: 2,
      totalIterations: 3,
    });
  });

  it('keeps a recoverable snapshot when desktop continuation fails', async () => {
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    await planStore.save({
      plan: recoverablePlan('plan_continue_failed_desktop'),
      status: 'running',
      session: testAgentSession('session_continue_failed_desktop'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 1,
      toolExecutions: [],
      now: '2026-06-17T00:05:00.000Z',
    });
    const registry = registryWithQueryTools();
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with writes',
        inputSchema: { type: 'object', properties: {} },
        dangerLevel: 'high',
        readonly: false,
      },
      () => ({ ok: true }),
    );
    const provider = scriptedProvider([{ text: '', toolCalls: [{ id: 'call_hidden', name: 'execute_sql', arguments: {} }] }]);
    const service = await createService({
      provider,
      registry,
      skills: [dailyGmvSkill()],
      planStore,
    });

    const result = await service.continuePlan({
      planId: 'plan_continue_failed_desktop',
      runId: 'run_continue_failed_desktop',
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      maxIterations: 1,
    });

    expect(result).toMatchObject({
      runId: 'run_continue_failed_desktop',
      status: 'failed',
      abandonedSnapshot: false,
      plan: {
        id: 'plan_continue_failed_desktop',
        steps: [
          { id: 'inspect_schema', status: 'done' },
          { id: 'run_query', status: 'failed', runStatus: 'permission_denied' },
        ],
      },
      toolExecutions: [{ toolCallId: 'call_hidden', toolName: 'execute_sql', status: 'denied' }],
    });
    await expect(service.listRecoverablePlans()).resolves.toMatchObject({
      plans: [
        {
          planId: 'plan_continue_failed_desktop',
          executedSteps: 1,
          totalIterations: 1,
        },
      ],
    });
    await expect(planStore.load('plan_continue_failed_desktop')).resolves.toMatchObject({
      status: 'running',
      plan: { steps: [{ status: 'done' }, { status: 'pending' }] },
    });
  });

  it('restarts a recoverable Plan & Execute snapshot through desktop service', async () => {
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    await planStore.save({
      plan: recoverablePlan('plan_restart_desktop'),
      status: 'running',
      session: testAgentSession('session_restart_desktop'),
      finalText: 'schema inspected',
      executedSteps: 1,
      totalIterations: 1,
      toolExecutions: [],
      now: '2026-06-17T00:05:00.000Z',
    });
    const provider = scriptedProvider([
      {
        text: JSON.stringify({
          title: 'Restarted GMV investigation',
          steps: [
            {
              id: 'rerun_query',
              title: 'Rerun GMV query',
              instruction: 'Verify current GMV from scratch.',
            },
          ],
        }),
        toolCalls: [],
      },
      {
        text: '',
        toolCalls: [{ id: 'call_restart_query', name: 'query_database', arguments: { sql: 'select 100 as gmv' } }],
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
      {
        text: 'Restarted plan completed.',
        toolCalls: [],
        usage: { promptTokens: 24, completionTokens: 5, totalTokens: 29 },
      },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
      planStore,
    });

    const result = await service.restartPlan({
      planId: 'plan_restart_desktop',
      runId: 'run_restart_desktop',
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      maxIterations: 2,
      maxPlanSteps: 2,
    });

    expect(result).toMatchObject({
      runId: 'run_restart_desktop',
      strategy: 'plan-execute',
      status: 'done',
      finalText: 'Restarted plan completed.',
      abandonedSnapshot: true,
      recoveryPlan: { planId: 'plan_restart_desktop' },
      plan: {
        id: 'plan_agent_service',
        title: 'Restarted GMV investigation',
        steps: [{ id: 'rerun_query', status: 'done', runStatus: 'done' }],
      },
      toolExecutions: [{ toolCallId: 'call_restart_query', toolName: 'query_database', status: 'success' }],
    });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain('Restart the interrupted Plan & Execute task');
    expect(provider.requests[1]?.tools?.map((tool) => tool.name)).toEqual([
      'list_tables',
      'describe_table',
      'query_database',
    ]);
    await expect(service.listRecoverablePlans()).resolves.toEqual({ plans: [] });
    await expect(planStore.load('plan_restart_desktop')).resolves.toMatchObject({
      status: 'abandoned',
      errorMessage: 'Restarted Plan & Execute task completed successfully.',
    });
    await expect(planStore.load('plan_agent_service')).resolves.toMatchObject({
      status: 'done',
      finalText: 'Restarted plan completed.',
      executedSteps: 1,
      totalIterations: 2,
    });
  });

  it('abandons a recoverable Plan & Execute snapshot through desktop service', async () => {
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    await planStore.save({
      plan: recoverablePlan('plan_abandon_desktop'),
      status: 'running',
      session: testAgentSession('session_abandon_desktop'),
      now: '2026-06-17T00:05:00.000Z',
    });
    const service = await createService({
      provider: scriptedProvider([]),
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
      planStore,
    });

    await expect(
      service.abandonPlan({ planId: 'plan_abandon_desktop', reason: 'user chose to discard stale work' }),
    ).resolves.toEqual({
      planId: 'plan_abandon_desktop',
      abandoned: true,
      message: 'Recoverable Agent plan was abandoned.',
    });
    await expect(service.listRecoverablePlans()).resolves.toEqual({ plans: [] });
    await expect(planStore.load('plan_abandon_desktop')).resolves.toMatchObject({
      status: 'abandoned',
      errorMessage: 'user chose to discard stale work',
    });
  });

  it('writes a desktop Agent audit log for a real headless Agent run', async () => {
    const logsDir = await tempDir('dbagent-agent-service-audit-');
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_query', name: 'query_database', arguments: { sql: 'select 100 as gmv' } }],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
      {
        text: '昨日 GMV 是 100。',
        toolCalls: [],
        usage: { promptTokens: 16, completionTokens: 6, totalTokens: 22 },
      },
    ]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
      auditLog: new DailyAgentAuditLogStore(logsDir),
    });

    const result = await service.run({
      runId: 'run_daily_gmv_audit',
      providerId: 'fake',
      model: 'fake-model',
      userInput: '请生成昨日 GMV 日报',
      mode: 'readonly',
      maxIterations: 2,
    });
    const auditLog = new AgentAuditLogStore(join(logsDir, 'agent-2026-06-17.jsonl'));
    const events = await auditLog.readAll();

    expect(result.status).toBe('done');
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'model_call_started',
      'model_call_finished',
      'tool_call_started',
      'tool_call_finished',
      'model_call_started',
      'model_call_finished',
      'run_finished',
    ]);
    expect(events.find((event) => event.type === 'run_started')).toMatchObject({
      type: 'run_started',
      sessionId: 'session_agent_service',
      mode: 'readonly',
    });
    expect(events.find((event) => event.type === 'tool_call_finished')).toMatchObject({
      type: 'tool_call_finished',
      toolName: 'query_database',
      status: 'success',
    });
    expect(events.find((event) => event.type === 'run_finished')).toMatchObject({
      type: 'run_finished',
      status: 'done',
      iterations: 2,
    });
  });

  it('returns missing-tool diagnostics without running Agent when a Skill cannot execute', async () => {
    const provider = scriptedProvider([]);
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [pythonAnalysisSkill()],
    });

    const result = await service.run({
      providerId: 'fake',
      model: 'fake-model',
      userInput: '用 Python 训练模型预测 GMV，并画趋势图',
      mode: 'auto',
    });

    expect(result.status).toBe('no_matching_skill');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      skill: { name: 'data_analysis' },
      eligible: false,
      missingTools: ['workspace_script:run_python_analysis'],
    });
    expect(provider.requests).toEqual([]);
  });

  it('keeps hidden model tool calls denied even when the tool is registered', async () => {
    let writeExecuted = false;
    const registry = registryWithQueryTools();
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with writes',
        inputSchema: { type: 'object', properties: {} },
        dangerLevel: 'high',
        readonly: false,
      },
      () => {
        writeExecuted = true;
        return { ok: true };
      },
    );
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_hidden_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } }],
      },
    ]);
    const service = await createService({ provider, registry, skills: [dailyGmvSkill()] });

    const result = await service.run({
      providerId: 'fake',
      model: 'fake-model',
      userInput: '请生成昨日 GMV 日报',
      mode: 'auto',
      maxIterations: 1,
    });

    expect(result.status).toBe('permission_denied');
    expect(writeExecuted).toBe(false);
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_hidden_write', toolName: 'execute_sql', status: 'denied' },
    ]);
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
  });

  it('aborts an active Agent run by runId', async () => {
    let rejectOnAbort: ((error: Error) => void) | undefined;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const provider = blockingProvider((request) => {
      startedResolve();
      return new Promise<LlmChatResponse>((_resolve, reject) => {
        rejectOnAbort = reject;
        request.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
      });
    });
    const service = await createService({
      provider,
      registry: registryWithQueryTools(),
      skills: [dailyGmvSkill()],
    });

    const running = service.run({
      runId: 'run_abort',
      providerId: 'fake',
      model: 'fake-model',
      userInput: '请生成昨日 GMV 日报',
      mode: 'readonly',
    });
    await started;

    expect(service.abort({ runId: 'run_abort' })).toEqual({
      runId: 'run_abort',
      aborted: true,
      message: 'Agent run abort signal sent.',
    });
    rejectOnAbort?.(new Error('aborted by test'));

    await expect(running).resolves.toMatchObject({
      runId: 'run_abort',
      status: 'aborted',
      finalText: 'Agent run was aborted.',
    });
  });
});

async function createService(input: {
  provider: LlmProvider;
  registry: ToolRegistry;
  skills: SkillDefinition[];
  auditLog?: AgentAuditLogWriter;
  planStore?: AgentPlanExecutionStore;
}): Promise<HeadlessAgentService> {
  const usage = new UsageTracker(await usagePath());
  const llmRouter = new LlmRouter(usage, [input.provider]);
  const agent = new ReactAgent(llmRouter, input.registry, usage, undefined, {
    now: () => '2026-06-17T00:00:00.000Z',
    createSessionId: () => 'session_agent_service',
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
  });
  const planExecuteAgent = new PlanExecuteAgent(llmRouter, agent, {
    now: () => '2026-06-17T00:00:00.000Z',
    createPlanId: () => 'plan_agent_service',
    ...(input.planStore === undefined ? {} : { planStore: input.planStore }),
  });
  return new HeadlessAgentService({
    agent,
    planExecuteAgent,
    ...(input.planStore === undefined ? {} : { planRecoveryService: new AgentPlanRecoveryService(input.planStore) }),
    toolRegistry: input.registry,
    loadSkills: () => input.skills,
    createRunId: () => 'run_generated',
  });
}

async function usagePath(): Promise<string> {
  return join(await tempDir('dbagent-agent-service-'), 'usage.json');
}

async function planStorePath(): Promise<string> {
  return join(await tempDir('dbagent-agent-plan-store-'), 'plans.json');
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function testAgentSession(id: string) {
  const session = createAgentSession({
    id,
    title: 'Recovered desktop Agent session',
    mode: 'readonly',
    now: () => '2026-06-17T00:00:00.000Z',
  });
  session.strategy = 'plan-execute';
  return session;
}

function recoverablePlan(id: string): AgentPlan {
  return {
    id,
    title: 'Recoverable GMV plan',
    goal: 'Investigate GMV after interrupted desktop run.',
    createdAt: '2026-06-17T00:00:00.000Z',
    plannerModelText: '{"title":"Recoverable GMV plan"}',
    steps: [
      {
        id: 'inspect_schema',
        title: 'Inspect schema',
        instruction: 'Inspect the orders table before querying.',
        status: 'done',
        resultSummary: 'orders table inspected',
        runStatus: 'done',
        iterations: 1,
      },
      {
        id: 'run_query',
        title: 'Run query',
        instruction: 'Run readonly GMV query and summarize the result.',
        status: 'pending',
      },
    ],
  };
}

function registryWithQueryTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'list_tables',
      description: 'List tables',
      inputSchema: { type: 'object', properties: {} },
      dangerLevel: 'safe',
      readonly: true,
    },
    () => ['orders'],
  );
  registry.register(
    {
      name: 'describe_table',
      description: 'Describe table',
      inputSchema: { type: 'object', properties: {} },
      dangerLevel: 'safe',
      readonly: true,
    },
    () => ({ table: 'orders' }),
  );
  registry.register(
    {
      name: 'query_database',
      description: 'Run readonly SQL',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
      dangerLevel: 'medium',
      readonly: true,
    },
    () => ({ rows: [{ gmv: 100 }] }),
  );
  return registry;
}

function dailyGmvSkill(): SkillDefinition {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'daily_gmv_report',
      title: '每日 GMV 日报',
      description: '查询订单指标并生成每日 GMV 分析。',
      natural_language_keywords: ['昨日 GMV', 'GMV 日报', '日报'],
      allowed_tools: ['query_database'],
      steps: ['查询 GMV', '生成分析'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function pythonAnalysisSkill(): SkillDefinition {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'data_analysis',
      title: 'Python 数据分析',
      description: '使用 Python 完成建模、预测和可视化。',
      natural_language_keywords: ['Python 数据分析', '训练模型'],
      auto_inject_when: ['requires_python', 'requires_visualization', 'requires_modeling'],
      allowed_tools: ['query_database', 'workspace_script:run_python_analysis'],
      steps: ['查询数据', '运行 Python 分析'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function scriptedProvider(responses: LlmChatResponse[]): LlmProvider & { requests: LlmChatRequest[] } {
  const requests: LlmChatRequest[] = [];
  return {
    id: 'fake',
    name: 'Fake provider',
    mode: 'byok',
    requests,
    chat(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error('No scripted response left.');
      return Promise.resolve(response);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

function blockingProvider(
  handler: (request: LlmChatRequest) => Promise<LlmChatResponse>,
): LlmProvider {
  return {
    id: 'fake',
    name: 'Blocking provider',
    mode: 'byok',
    chat: handler,
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}
