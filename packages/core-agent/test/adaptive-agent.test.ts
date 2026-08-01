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
  ReactAgent,
  ToolRegistry,
  createAgentTaskPlan,
  createAgentToolResultEnvelope,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('adaptive Agent orchestration', () => {
  it('uses a lightweight plan while runtime SQL evidence controls completion', async () => {
    const tools = new ToolRegistry();
    tools.register(tool('task_plan_create'), (_args, context) => {
      context.session.taskPlan = createAgentTaskPlan({
        goal: 'Verify order count',
        tasks: [
          {
            id: 'verify',
            title: 'Run and verify the count query',
          },
        ],
        now: fixedNow(),
        createId: () => 'fixed',
      });
      return { created: true };
    });
    tools.register(tool('sql_execute'), () =>
      createAgentToolResultEnvelope({
        modelProjection: { rows: [{ count: 42 }], returnedRowCount: 1 },
        durableSummary: { returnedRowCount: 1 },
        completionEvidence: {
          kind: 'database-result',
          deliveryReady: true,
        },
      }),
    );
    const harness = await agentHarness(
      [
        responseWithTool('plan', 'task_plan_create'),
        responseWithTool('query', 'sql_execute'),
        { text: '订单总数是 42。', toolCalls: [] },
      ],
      tools,
    );

    const result = await harness.agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: '统计订单数并验证',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.finalText).toBe('订单总数是 42。');
    expect(result.completion).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'done',
      unresolvedTaskIds: [],
    });
    expect(result.session.taskPlan).toBeUndefined();
    expect(result.events?.map((event) => event.type)).not.toContain('correcting');
  });

  it('treats rejected permission as an observation and replans successfully', async () => {
    const tools = new ToolRegistry();
    tools.register(
      {
        ...tool('dangerous_write'),
        dangerLevel: 'high',
        readonly: false,
        requiredPermission: 'full',
      },
      () => ({ changed: true }),
    );
    tools.register(tool('safe_query'), () => ({ rowCount: 1, value: 42 }));
    const harness = await agentHarness(
      [
        responseWithTool('write', 'dangerous_write'),
        responseWithTool('read', 'safe_query'),
        { text: '未修改数据；已通过只读查询得到 42。', toolCalls: [] },
      ],
      tools,
      () => false,
    );

    const result = await harness.agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: '先尝试修复，否则只读检查',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.toolExecutions.map(({ status }) => status)).toEqual(['denied', 'success']);
    expect(result.finalText).toContain('只读查询');
    expect(result.events?.map((event) => event.type)).toContain('correcting');
  });

  it('accepts ordinary user steering during an active isolated session', async () => {
    const tools = new ToolRegistry();
    tools.register(tool('safe_query'), () => ({ rowCount: 1 }));
    let releaseFirst!: (response: LlmChatResponse) => void;
    const firstResponse = new Promise<LlmChatResponse>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: LlmChatRequest[] = [];
    let call = 0;
    const provider: LlmProvider = {
      id: 'scripted',
      name: 'scripted',
      mode: 'byok',
      async chat(request) {
        requests.push(request);
        call += 1;
        if (call === 1) return await firstResponse;
        return { text: '已按上海范围完成。', toolCalls: [] };
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const usage = await usageTracker();
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      tools,
      usage,
      undefined,
      fixedDependencies(),
    );
    const running = agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: '统计订单',
      mode: 'read',
    });
    await waitFor(() => requests.length === 1);
    expect(agent.steer('session-adaptive', '只看上海')).toBe(true);
    releaseFirst(responseWithTool('query', 'safe_query'));
    const result = await running;

    expect(result.status).toBe('done');
    expect(
      requests[1]?.messages.some(
        (message) => message.role === 'user' && message.content === '只看上海',
      ),
    ).toBe(true);
    expect(
      result.session.messages.some(
        (message) => message.role === 'user' && message.content === '只看上海',
      ),
    ).toBe(true);
  });

  it('detects repeated unchanged observations and tells the model to change path', async () => {
    const tools = new ToolRegistry();
    tools.register(tool('safe_query'), () => ({ unchanged: true }));
    const harness = await agentHarness(
      [
        responseWithTool('one', 'safe_query'),
        responseWithTool('two', 'safe_query'),
        responseWithTool('three', 'safe_query'),
        { text: '已换用已有证据说明限制。', toolCalls: [] },
      ],
      tools,
    );

    const result = await harness.agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: '查找可用结果',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.events?.map((event) => event.message)).toContain(
      '重复操作没有带来新信息，正在切换探索路径。',
    );
    expect(
      harness.requests[3]?.messages.some(
        (message) => message.role === 'system' && message.content.includes('No-progress guard'),
      ),
    ).toBe(true);
    expect(
      result.session.messages.some(
        (message) => message.role === 'system' && message.content.includes('No-progress guard'),
      ),
    ).toBe(false);
  });
});

function tool(name: string) {
  return {
    name,
    description: name,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
    dangerLevel: 'safe' as const,
    readonly: true,
    source: 'builtin' as const,
  };
}

function responseWithTool(id: string, name: string): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: {} }],
  };
}

async function agentHarness(
  responses: LlmChatResponse[],
  tools: ToolRegistry,
  approvalProvider?: () => boolean,
): Promise<{ agent: ReactAgent; requests: LlmChatRequest[] }> {
  const requests: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    id: 'scripted',
    name: 'scripted',
    mode: 'byok',
    chat(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error('No scripted response remains.');
      return Promise.resolve(response);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
  const usage = await usageTracker();
  return {
    agent: new ReactAgent(
      new LlmRouter(usage, [provider]),
      tools,
      usage,
      approvalProvider,
      fixedDependencies(),
    ),
    requests,
  };
}

async function usageTracker(): Promise<UsageTracker> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-adaptive-'));
  temporaryDirectories.push(directory);
  return new UsageTracker(join(directory, 'usage.json'));
}

function fixedDependencies() {
  return {
    now: fixedNow,
    createSessionId: () => 'session-adaptive',
  };
}

function fixedNow(): string {
  return '2026-07-25T00:00:00.000Z';
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
