import { describe, expect, it } from 'vitest';
import { ToolRegistry, type AgentRunResult } from '@dbagent/core-agent';
import { renderSkillAgentUserMessage, runSkillAgent, type SkillAgent, type SkillAgentRunOptionsForAgent } from '../src/index.js';

describe('Skill Agent runner', () => {
  it('runs an Agent with the intersection of Skill allowed tools and official plugin policy', async () => {
    const registry = new ToolRegistry();
    registerTool(registry, 'query_database', 'medium', true);
    registerTool(registry, 'execute_sql', 'high', false);
    registerTool(registry, 'workspace_script:summarize_orders', 'medium', false, {
      source: 'workspace-script',
      sourceId: 'scripts/summarize_orders.py',
      originalName: 'workspace_script:summarize_orders',
    });
    registerTool(registry, 'orders_server__list_orders', 'safe', true, {
      source: 'user-mcp',
      sourceId: 'orders_server',
      originalName: 'list_orders',
    });

    const agent = recordingAgent();
    const output = await runSkillAgent(agent, {
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      skillPlan: {
        skill: {
          name: 'daily_gmv',
          title: '每日 GMV 分析',
          description: '查询订单并生成日报。',
        },
        userInput: '生成昨天华东区 GMV 日报',
        systemAddition: '必须用中文输出。',
        allowedTools: [
          'query_database',
          'execute_sql',
          'workspace_script:summarize_orders',
          'orders_server__list_orders',
          'missing_tool',
        ],
        steps: ['检索订单相关 schema', '查询 GMV', '调用脚本生成摘要'],
        outputFormat: 'markdown',
      },
      toolPolicy: {
        toolRegistry: registry,
        disabledPluginIds: ['official.mcp-client'],
        readonlyOnly: true,
      },
    });

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({
      providerId: 'fake',
      model: 'fake-model',
      mode: 'readonly',
      allowedTools: ['query_database'],
    });
    expect(agent.calls[0]?.userMessage).toContain('当前 Skill: 每日 GMV 分析');
    expect(agent.calls[0]?.userMessage).toContain('Skill 执行步骤:');
    expect(agent.calls[0]?.userMessage).toContain('用户任务:\n生成昨天华东区 GMV 日报');
    expect(output.toolPolicy.blockedByPluginToolNames).toEqual([
      'execute_sql',
      'workspace_script:summarize_orders',
      'orders_server__list_orders',
      'missing_tool',
    ]);
    expect(output.toolPolicy.blockedBySkillToolNames).toEqual([]);
    expect(output.result.status).toBe('done');
  });

  it('allows plugin-approved runtime tools when the Skill does not further restrict them', async () => {
    const agent = recordingAgent();
    await runSkillAgent(agent, {
      providerId: 'fake',
      model: 'fake-model',
      skillPlan: {
        userInput: '运行脚本分析订单',
        allowedTools: ['workspace_script:summarize_orders', 'query_database'],
      },
      toolPolicy: {
        runtimeTools: [
          {
            name: 'workspace_script:summarize_orders',
            dangerLevel: 'medium',
            readonly: false,
            source: 'workspace-script',
          },
          {
            name: 'query_database',
            dangerLevel: 'medium',
            readonly: true,
          },
        ],
      },
      maxIterations: 3,
      maxToolExecutionMs: 1000,
    });

    expect(agent.calls[0]).toMatchObject({
      allowedTools: ['workspace_script:summarize_orders', 'query_database'],
      maxIterations: 3,
      maxToolExecutionMs: 1000,
    });
  });

  it('renders a deterministic Skill Agent user message', () => {
    expect(
      renderSkillAgentUserMessage(
        {
          skill: { name: 'schema_doc', description: '生成 schema 文档。' },
          userInput: '为 public schema 写文档',
          allowedTools: ['search_schema'],
          steps: ['读取 schema', '输出 Markdown'],
          outputFormat: 'markdown',
        },
        '这是一次 Skill 执行。',
      ),
    ).toBe(
      [
        '这是一次 Skill 执行。',
        '',
        '当前 Skill: schema_doc',
        'Skill 说明: 生成 schema 文档。',
        '',
        'Skill 执行步骤:',
        '1. 读取 schema',
        '2. 输出 Markdown',
        '',
        '期望输出格式: markdown',
        '',
        '用户任务:',
        '为 public schema 写文档',
      ].join('\n'),
    );
  });

  it('propagates Agent failures without hiding policy diagnostics', async () => {
    const agent = recordingAgent(new Error('provider timeout'));
    await expect(
      runSkillAgent(agent, {
        providerId: 'fake',
        model: 'fake-model',
        skillPlan: {
          userInput: '查询 GMV',
          allowedTools: ['query_database'],
        },
        toolPolicy: {
          runtimeTools: [{ name: 'query_database', dangerLevel: 'medium', readonly: true }],
        },
      }),
    ).rejects.toThrow('provider timeout');
    expect(agent.calls[0]?.allowedTools).toEqual(['query_database']);
  });
});

function registerTool(
  registry: ToolRegistry,
  name: string,
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical',
  readonly: boolean,
  metadata: { source?: string; sourceId?: string; originalName?: string } = {},
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
          id: 'session_skill_agent',
          title: 'skill agent',
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
