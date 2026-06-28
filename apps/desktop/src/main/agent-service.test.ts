import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactAgent, ToolRegistry } from '@dbagent/core-agent';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { parseSkillDefinition, type SkillDefinition } from '@dbagent/core-skills';
import { UsageTracker } from '@dbagent/core-usage';
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
      status: 'done',
      sessionId: 'session_agent_service',
      finalText: '昨日 GMV 是 100。',
      selectedSkill: { skill: { name: 'daily_gmv_report' } },
      toolExecutions: [{ toolCallId: 'call_query', toolName: 'query_database', status: 'success' }],
    });
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
    expect(result.toolPolicy.allowedToolNames).toEqual(['query_database']);
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
}): Promise<HeadlessAgentService> {
  const usage = new UsageTracker(await usagePath());
  const agent = new ReactAgent(new LlmRouter(usage, [input.provider]), input.registry, usage, undefined, {
    createSessionId: () => 'session_agent_service',
  });
  return new HeadlessAgentService({
    agent,
    toolRegistry: input.registry,
    loadSkills: () => input.skills,
    createRunId: () => 'run_generated',
  });
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-service-'));
  tempDirs.push(dir);
  return join(dir, 'usage.json');
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
