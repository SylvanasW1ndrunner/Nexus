import { describe, expect, it } from 'vitest';
import { ToolRegistry, createAgentSession } from '@dbagent/core-agent';
import { registerAgentRuntimeTools } from '../src/index.js';

describe('Agent runtime tools', () => {
  it('maintains a verifiable task plan in the owning Session', async () => {
    const registry = new ToolRegistry();
    registerAgentRuntimeTools(registry);
    const session = createAgentSession({
      id: 'session-1',
      title: 'Plan',
      mode: 'read',
      now: fixedNow,
    });
    const context = { session };
    session.messages.push({
      role: 'tool',
      toolCallId: 'call-query',
      toolName: 'sql_execute',
      content: '{"resultHandleId":"result-verified","rows":[{"total":"1726.50"}]}',
      createdAt: fixedNow(),
    });

    await registry.get('task_plan_create')!.handler(
      {
        goal: 'Verify revenue',
        tasks: [
          {
            id: 'query',
            title: 'Run aggregate query',
            acceptanceCriteria: ['Database result contains total revenue'],
          },
        ],
      },
      context,
    );
    await registry.get('task_update')!.handler(
      {
        taskId: 'query',
        status: 'completed',
        evidence: {
          kind: 'database-result',
          summary: 'SUM(net_amount) returned 1726.50',
          reference: 'result-verified',
        },
      },
      context,
    );
    const projected = (await registry.get('task_list')!.handler({}, context)) as {
      tasks: Array<{
        status: string;
        evidence: Array<{ summary: string }>;
      }>;
    };

    expect(session.taskPlan?.tasks[0]?.status).toBe('completed');
    expect(projected.tasks[0]).toMatchObject({
      status: 'completed',
      evidence: [{ summary: 'SUM(net_amount) returned 1726.50' }],
    });
  });

  it('rejects completion evidence that is not backed by Session tools or artifacts', async () => {
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

    expect(() =>
      registry.get('task_update')!.handler(
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
      ),
    ).toThrow('not present');
    expect(session.taskPlan?.tasks[0]?.status).toBe('pending');
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
});

function fixedNow(): string {
  return '2026-07-25T00:00:00.000Z';
}
