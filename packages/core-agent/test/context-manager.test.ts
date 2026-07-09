import { describe, expect, it } from 'vitest';
import type { LlmTool } from '@dbagent/core-llm';
import { appendMessage, buildAgentContext, createAgentSession, createMessage, estimatePromptTokens } from '../src/index.js';

const now = () => '2026-06-23T00:00:00.000Z';

describe('buildAgentContext', () => {
  it('keeps small conversations unchanged', () => {
    const session = createAgentSession({ id: 's1', title: 'Small', mode: 'readonly', now });
    appendMessage(session, createMessage({ role: 'user', content: '查一下订单数' }, now));

    const context = buildAgentContext(session, tools(), { maxPromptTokens: 2_000 });

    expect(context.messages).toEqual([{ role: 'user', content: '查一下订单数' }]);
    expect(context.tools.map((tool) => tool.name)).toEqual(['query_database']);
    expect(context.compression).toMatchObject({
      phase: 'healthy',
      level: 'none',
      maxPromptTokens: 2_000,
      retainedMessageCount: 1,
      toolCount: 1,
      archivedMessageCount: 0,
      summarizedToolResultCount: 0,
      steps: [],
      warnings: [],
    });
  });

  it('reports warning phase before local compression is required', () => {
    const session = createAgentSession({ id: 's1', title: 'Warning', mode: 'readonly', now });
    appendMessage(session, createMessage({ role: 'user', content: '订单 '.repeat(30) }, now));

    const context = buildAgentContext(session, tools(), {
      maxPromptTokens: 200,
      warningThresholdRatio: 0.5,
      softCompressionThresholdRatio: 0.95,
      hardCompressionThresholdRatio: 1,
    });

    expect(context.compression).toMatchObject({
      phase: 'warning',
      level: 'none',
      warningThresholdTokens: 100,
      softCompressionThresholdTokens: 190,
      hardCompressionThresholdTokens: 200,
      steps: [],
    });
  });

  it('summarizes large tool results before sending them back to the model', () => {
    const session = createAgentSession({ id: 's1', title: 'Tool result', mode: 'readonly', now });
    appendMessage(session, createMessage({ role: 'user', content: '分析订单明细' }, now));
    appendMessage(
      session,
      createMessage(
        {
          role: 'tool',
          toolCallId: 'call_1',
          toolName: 'query_database',
          content: JSON.stringify({ rows: Array.from({ length: 200 }, (_, index) => ({ id: index, amount: index * 10 })) }),
        },
        now,
      ),
    );

    const context = buildAgentContext(session, tools(), { maxPromptTokens: 120, maxToolResultChars: 240 });

    expect(context.compression.phase).toMatch(/soft_compressed|hard_compressed|over_budget/);
    expect(context.compression.summarizedToolResultCount).toBe(1);
    expect(context.compression.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool-summary',
        affectedMessageCount: 1,
      }),
    ]));
    expect(context.messages.find((message) => message.role === 'tool')?.content).toContain('工具结果已在本地摘要');
    expect(context.compression.finalTokenEstimate).toBeLessThan(context.compression.originalTokenEstimate);
  });

  it('archives early messages while preserving recent user context', () => {
    const session = createAgentSession({ id: 's1', title: 'Long', mode: 'readonly', now });
    for (let index = 1; index <= 12; index += 1) {
      appendMessage(session, createMessage({ role: 'user', content: `第 ${index} 轮问题：${'订单 '.repeat(30)}` }, now));
      appendMessage(session, createMessage({ role: 'assistant', content: `第 ${index} 轮回答：${'结果 '.repeat(30)}` }, now));
    }

    const context = buildAgentContext(session, tools(), {
      maxPromptTokens: 160,
      keepRecentMessages: 4,
      maxToolResultChars: 100,
    });

    expect(context.compression.level).toBe('archive-early-messages');
    expect(context.compression.phase).toMatch(/hard_compressed|over_budget/);
    expect(context.compression.archivedMessageCount).toBeGreaterThan(0);
    expect(context.compression.steps.at(-1)).toMatchObject({
      type: 'archive-early-messages',
      affectedMessageCount: context.compression.archivedMessageCount,
    });
    expect(context.messages[0]?.role).toBe('system');
    expect(context.messages[0]?.content).toContain('前文已归档');
    expect(context.messages.at(-1)?.content).toContain('第 12 轮回答');
    expect(context.messages.some((message) => message.content.includes('第 1 轮问题'))).toBe(false);
  });

  it('reports when local compression still cannot fit the requested budget', () => {
    const session = createAgentSession({ id: 's1', title: 'Too small', mode: 'readonly', now });
    appendMessage(session, createMessage({ role: 'user', content: '非常小的预算' }, now));

    const context = buildAgentContext(session, tools(), { maxPromptTokens: 1 });

    expect(context.compression.warnings).toContain('Context is still over budget after local compression.');
  });

  it('estimates prompt tokens from messages and tools', () => {
    expect(estimatePromptTokens([{ role: 'user', content: '订单 GMV' }], tools())).toBeGreaterThan(0);
  });
});

function tools(): LlmTool[] {
  return [
    {
      name: 'query_database',
      description: 'Execute readonly SQL',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
    },
  ];
}
