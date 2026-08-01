import { describe, expect, it } from 'vitest';
import { ToolRegistry, createAgentSession } from '@dbagent/core-agent';
import { registerAgentRuntimeTools } from '../src/index.js';

describe('Agent runtime tools', () => {
  it('keeps planning lightweight and leaves completion evidence to the runtime', async () => {
    const registry = new ToolRegistry();
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-1',
      title: 'Plan',
      mode: 'read',
      now: fixedNow,
    });
    const context = { session };

    await registry.get('task_plan_create')!.handler(
      {
        goal: 'Verify revenue',
        tasks: [
          {
            id: 'query',
            title: 'Run aggregate query',
          },
        ],
      },
      context,
    );
    await registry.get('task_update')!.handler(
      {
        taskId: 'query',
        status: 'completed',
      },
      context,
    );
    const projected = (await registry.get('task_list')!.handler({}, context)) as {
      tasks: Array<{ status: string }>;
    };

    expect(session.taskPlan?.tasks[0]?.status).toBe('completed');
    expect(projected.tasks[0]).toEqual({
      id: 'query',
      title: 'Run aggregate query',
      status: 'completed',
    });
    const createSchema = registry.get('task_plan_create')!.inputSchema;
    const updateSchema = registry.get('task_update')!.inputSchema;
    expect(JSON.stringify(createSchema)).not.toMatch(/acceptanceCriteria|dependsOn|evidence/);
    expect(JSON.stringify(updateSchema)).not.toMatch(/acceptanceCriteria|dependsOn|evidence/);
  });

  it('does not ask the model to manufacture or attach runtime evidence', async () => {
    const registry = new ToolRegistry();
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-evidence',
      title: 'Evidence',
      mode: 'read',
      now: fixedNow,
    });
    const context = { session };
    await registry.get('task_plan_create')!.handler(
      {
        goal: 'Verify result',
        tasks: [{ id: 'verify', title: 'Run final query' }],
      },
      context,
    );

    await registry.get('task_update')!.handler(
      {
        taskId: 'verify',
        status: 'completed',
        evidence: {
          kind: 'database-result',
          summary: 'Invented success',
          reference: 'result-does-not-exist',
        },
      },
      context,
    );
    expect(session.taskPlan?.tasks[0]).toMatchObject({
      status: 'completed',
      evidence: [],
    });
  });

  it('discovers tools by capability and activates only matching schemas', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'database_count_orders',
        description: 'Count database orders with SQL',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ count: 1 }),
    );
    registry.register(
      {
        name: 'web_weather',
        description: 'Read current weather',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ sunny: true }),
    );
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-1',
      title: 'Discovery',
      mode: 'read',
      now: fixedNow,
    });

    const result = (await registry
      .get('tool_search')!
      .handler({ query: 'database orders' }, { session })) as { tools: Array<{ name: string }> };

    expect(result.tools.map((tool) => tool.name)).toEqual(['database_count_orders']);
    expect(session.activeTools).toEqual(['database_count_orders']);
    expect(JSON.stringify(result)).not.toMatch(/hash|nodeId|sourcePath|score/i);
  });

  it('does not discover, describe, or activate tools excluded by the run policy', async () => {
    const registry = new ToolRegistry();
    for (const name of ['database_read_orders', 'database_delete_orders']) {
      registry.register(
        {
          name,
          description: 'Database orders operation',
          inputSchema: { type: 'object', properties: {} },
          dangerLevel: name.includes('delete') ? 'high' : 'safe',
          readonly: name.includes('read'),
        },
        () => ({}),
      );
    }
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-policy',
      title: 'Policy',
      mode: 'read',
      now: fixedNow,
    });
    const context = {
      session,
      allowedTools: ['tool_search', 'tool_describe', 'database_read_orders'],
    };

    const result = (await registry
      .get('tool_search')!
      .handler({ query: 'database orders' }, context)) as { tools: Array<{ name: string }> };

    expect(result.tools.map((tool) => tool.name)).toEqual(['database_read_orders']);
    expect(session.activeTools).toEqual(['database_read_orders']);
    expect(() =>
      registry.get('tool_describe')!.handler({ name: 'database_delete_orders' }, context),
    ).toThrow('unavailable for this run');
    expect(session.activeTools).toEqual(['database_read_orders']);
  });

  it('never discovers or describes hidden and disabled runtime tools', async () => {
    const registry = new ToolRegistry();
    for (const exposure of ['hidden', 'disabled'] as const) {
      registry.register(
        {
          name: `${exposure}_internal_tool`,
          description: 'Internal catalog maintenance capability',
          inputSchema: { type: 'object', properties: {} },
          dangerLevel: 'safe',
          readonly: true,
          exposure,
        },
        () => ({}),
      );
    }
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-hidden-tools',
      title: 'Hidden tools',
      mode: 'read',
      now: fixedNow,
    });

    const result = (await registry.get('tool_search')!.handler(
      { query: 'internal catalog maintenance' },
      { session },
    )) as { tools: Array<{ name: string }> };

    expect(result.tools).toEqual([]);
    expect(session.activeTools).toEqual([]);
    expect(() =>
      registry
        .get('tool_describe')!
        .handler({ name: 'hidden_internal_tool' }, { session }),
    ).toThrow('unavailable for this run');
  });

  it('uses the bilingual catalog index and scopes activations without returning catalog internals', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        namespace: 'database.kafka',
        name: 'inspect_event_payload',
        title: '检查事件 JSON 结构',
        description: 'Inspect Kafka payload fields',
        aliases: ['解析消息结构'],
        tags: ['Kafka', '数据清洗'],
        inputSchema: {
          type: 'object',
          properties: {
            eventType: { type: 'string', description: '事件类型过滤条件' },
          },
        },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({}),
    );
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-bilingual',
      title: 'Discovery',
      mode: 'read',
      now: fixedNow,
    });

    const rawResult: unknown = await registry.get('tool_search')!.handler(
      { query: '按 eventType 解析 Kafka 消息结构' },
      {
        session,
        toolActivationScope: {
          catalogRevision: registry.catalogRevision,
          checkpointSequence: 2,
          taskPhase: 'act',
          activatedAt: fixedNow(),
        },
      },
    );
    const result = rawResult as { tools: Array<{ name: string; inputSchema: unknown }> };

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('inspect_event_payload');
    expect(result.tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(session.toolActivations).toEqual([
      {
        toolName: 'inspect_event_payload',
        catalogRevision: registry.catalogRevision,
        checkpointSequence: 2,
        taskPhase: 'act',
        activatedAt: '2026-07-25T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/catalogRevision|matchedTerms|score|hash|nodeId/i);
  });
});

function fixedNow(): string {
  return '2026-07-25T00:00:00.000Z';
}
