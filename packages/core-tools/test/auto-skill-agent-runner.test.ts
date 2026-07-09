import { parseSkillDefinition } from '@dbagent/core-skills';
import { describe, expect, it } from 'vitest';
import {
  type AgentPlanExecuteResult,
  type AgentRunResult,
  type AgentToolSource,
  ToolRegistry,
} from '@dbagent/core-agent';
import {
  runAutoSkillAgent,
  selectAutoSkillPlan,
  type SkillAgent,
  type SkillAgentRunOptionsForAgent,
  type SkillPlanExecuteAgent,
  type SkillPlanExecuteRunOptionsForAgent,
} from '../src/index.js';

describe('Auto Skill Agent runner', () => {
  it('matches a user task to an eligible Skill and runs the Agent through official plugin policy', async () => {
    const registry = new ToolRegistry();
    registerTool(registry, 'search_schema', 'safe', true);
    registerTool(registry, 'query_database', 'medium', true);
    registerTool(registry, 'write_workspace_file', 'medium', false, { source: 'workspace' });
    registerTool(registry, 'execute_sql', 'high', false);

    const agent = recordingAgent();
    const output = await runAutoSkillAgent(agent, {
      providerId: 'fake',
      model: 'fake-model',
      mode: 'ask',
      userInput: '请生成昨日 GMV 日报，并写入工作区',
      skills: [dailyReportSkill(), dataAnalysisSkill()],
      toolPolicy: {
        toolRegistry: registry,
        disabledPluginIds: ['official.mcp-client'],
      },
      maxIterations: 4,
      userMessagePrefix: '这是一次自动 Skill 执行。',
    });

    expect(output.autoPlan.candidate.skill.name).toBe('daily_gmv_report');
    expect(output.candidates.map((candidate) => candidate.skill.name)).toContain('daily_gmv_report');
    expect(output.preflightToolPolicy.agentAllowedToolNames).toEqual([
      'search_schema',
      'query_database',
      'write_workspace_file',
      'execute_sql',
    ]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      mode: 'ask',
      maxIterations: 4,
      allowedTools: ['search_schema', 'query_database', 'write_workspace_file'],
    });
    expect(agent.calls[0]?.userMessage).toContain('这是一次自动 Skill 执行。');
    expect(agent.calls[0]?.userMessage).toContain('当前 Skill: 每日 GMV 日报');
    expect(agent.calls[0]?.userMessage).toContain('用户任务:\n请生成昨日 GMV 日报，并写入工作区');
    expect(output.toolPolicy.blockedByPluginToolNames).toEqual([]);
    expect(output.toolPolicy.blockedBySkillToolNames).toEqual(['execute_sql']);
  });

  it('uses inferred and explicit signals to select Python analysis Skills', () => {
    const autoPlan = selectAutoSkillPlan({
      providerId: 'fake',
      model: 'fake-model',
      userInput: '分析下周收入趋势',
      skills: [dailyReportSkill(), dataAnalysisSkill()],
      match: { signals: ['requires_python', 'requires_visualization', 'requires_modeling'] },
      toolPolicy: {
        runtimeTools: [
          { name: 'search_schema', dangerLevel: 'safe', readonly: true },
          { name: 'query_database', dangerLevel: 'medium', readonly: true },
          {
            name: 'workspace_script:run_python_analysis',
            dangerLevel: 'medium',
            readonly: false,
            source: 'workspace-script',
          },
        ],
      },
    });

    expect(autoPlan.candidate.skill.name).toBe('data_analysis');
    expect(autoPlan.candidate.matchedSignals).toEqual([
      'requires_visualization',
      'requires_python',
      'requires_modeling',
    ]);
    expect(autoPlan.plan.allowedTools).toEqual([
      'search_schema',
      'query_database',
      'workspace_script:run_python_analysis',
    ]);
  });

  it('runs an auto-selected Skill through the Plan & Execute strategy when requested', async () => {
    const registry = new ToolRegistry();
    registerTool(registry, 'search_schema', 'safe', true);
    registerTool(registry, 'query_database', 'medium', true);
    registerTool(registry, 'write_workspace_file', 'medium', false, { source: 'workspace' });

    const agent = recordingPlanExecuteAgent();
    const output = await runAutoSkillAgent(agent, {
      strategy: 'plan-execute',
      providerId: 'fake',
      model: 'fake-model',
      mode: 'auto',
      userInput: 'daily_gmv_report: Generate a daily GMV report',
      skills: [dailyReportSkill(), dataAnalysisSkill()],
      toolPolicy: {
        toolRegistry: registry,
      },
      maxPlanSteps: 4,
      stopOnStepFailure: true,
    });

    expect(output.strategy).toBe('plan-execute');
    expect(output.autoPlan.candidate.skill.name).toBe('daily_gmv_report');
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      mode: 'auto',
      allowedTools: ['search_schema', 'query_database', 'write_workspace_file'],
      maxPlanSteps: 4,
      stopOnStepFailure: true,
    });
    expect(agent.calls[0]?.userMessage).toContain('daily_gmv_report: Generate a daily GMV report');
    expect(output.result.status).toBe('done');
  });

  it('does not run the Agent when the matching Skill is blocked by missing runtime tools', async () => {
    const agent = recordingAgent();

    await expect(
      runAutoSkillAgent(agent, {
        providerId: 'fake',
        model: 'fake-model',
        userInput: '用 Python 训练模型预测 GMV',
        skills: [dataAnalysisSkill()],
        toolPolicy: {
          runtimeTools: [
            { name: 'search_schema', dangerLevel: 'safe', readonly: true },
            { name: 'query_database', dangerLevel: 'medium', readonly: true },
          ],
        },
      }),
    ).rejects.toMatchObject({
      name: 'NoMatchingSkillError',
      code: 'skill.no_matching_skill',
      candidates: [
        {
          skill: { name: 'data_analysis' },
          eligible: false,
          missingTools: ['workspace_script:run_python_analysis'],
        },
      ],
      pluginAllowedToolNames: ['search_schema', 'query_database'],
    });

    expect(agent.calls).toEqual([]);
  });
});

function dailyReportSkill() {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'daily_gmv_report',
      title: '每日 GMV 日报',
      description: '查询订单指标，生成每日 GMV、同比、环比和口径说明。',
      system_addition: '必须先检索 schema，再执行查询。',
      natural_language_keywords: ['昨日 GMV', 'GMV 日报', '日报'],
      allowed_tools: ['search_schema', 'query_database', 'write_workspace_file'],
      defaults: { date: 'yesterday' },
      steps: ['检索订单 schema', '查询 GMV', '写入日报文件'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function dataAnalysisSkill() {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'data_analysis',
      title: 'Python 数据分析',
      description: '用 Python 脚本完成建模、预测和可视化。',
      natural_language_keywords: ['Python 数据分析', '建模预测', '训练模型'],
      auto_inject_when: ['requires_visualization', 'requires_python', 'requires_modeling'],
      allowed_tools: ['search_schema', 'query_database', 'workspace_script:run_python_analysis'],
      steps: ['检索 schema', '执行 Python 分析脚本', '解释结果'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function registerTool(
  registry: ToolRegistry,
  name: string,
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical',
  readonly: boolean,
  metadata: { source?: AgentToolSource; sourceId?: string; originalName?: string } = {},
): void {
  registry.register(
    {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      dangerLevel,
      readonly,
      ...(metadata.source === undefined ? {} : { source: metadata.source }),
      ...(metadata.sourceId === undefined ? {} : { sourceId: metadata.sourceId }),
      ...(metadata.originalName === undefined ? {} : { originalName: metadata.originalName }),
    },
    () => ({ ok: true }),
  );
}

function recordingAgent(error?: Error): SkillAgent & { calls: SkillAgentRunOptionsForAgent[] } {
  const calls: SkillAgentRunOptionsForAgent[] = [];
  return {
    calls,
    run(options) {
      calls.push(options);
      if (error) throw error;
      return Promise.resolve({
        status: 'done',
        session: {
          id: 'session_auto_skill_agent',
          title: 'auto skill agent',
          mode: options.mode ?? 'ask',
          strategy: 'react',
          messages: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          aborted: false,
        },
        finalText: 'done',
        iterations: 1,
        toolExecutions: [],
      } satisfies AgentRunResult);
    },
  };
}

function recordingPlanExecuteAgent(): SkillPlanExecuteAgent & { calls: SkillPlanExecuteRunOptionsForAgent[] } {
  const calls: SkillPlanExecuteRunOptionsForAgent[] = [];
  return {
    calls,
    run(options) {
      calls.push(options);
      return Promise.resolve({
        status: 'done',
        plan: {
          id: 'plan_auto_skill_agent',
          title: 'auto skill plan',
          goal: options.userMessage,
          createdAt: '2026-07-09T00:00:00.000Z',
          plannerModelText: '{"steps":[]}',
          steps: [
            {
              id: 'step_1',
              title: 'inspect schema',
              instruction: 'inspect schema',
              status: 'done',
            },
          ],
        },
        finalText: 'done',
        executedSteps: 1,
        totalIterations: 1,
        toolExecutions: [],
      } satisfies AgentPlanExecuteResult);
    },
  };
}
