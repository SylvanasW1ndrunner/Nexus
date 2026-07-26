import { describe, expect, it } from 'vitest';
import type { LlmTool } from '@dbagent/core-llm';
import {
  appendMessage,
  buildAgentContext,
  buildAgentContextCompactionRequest,
  buildDeterministicContextSummary,
  createAgentContextCheckpoint,
  createAgentContextCompactionPlan,
  createAgentSession,
  createMessage,
  estimatePromptTokens,
} from '../src/index.js';

const now = () => '2026-07-24T00:00:00.000Z';

describe('Agent context management', () => {
  it('keeps a small conversation unchanged within the model capacity', () => {
    const session = createAgentSession({
      id: 'small',
      title: 'Small',
      mode: 'read',
      now,
    });
    appendMessage(session, createMessage({ role: 'user', content: '查一下订单数' }, now));

    const context = buildAgentContext(session, tools(), {
      modelContextTokens: 2_000,
      maxOutputTokens: 200,
    });

    expect(context.messages).toEqual([{ role: 'user', content: '查一下订单数' }]);
    expect(context.requiresCompaction).toBe(false);
    expect(context.compression).toMatchObject({
      phase: 'healthy',
      level: 'none',
      trigger: 'none',
      modelContextTokens: 2_000,
      reservedOutputTokens: 200,
      availablePromptTokens: 1_800,
      coveredConversationMessageCount: 0,
      maskedToolResultCount: 0,
      warnings: [],
    });
  });

  it('shortens old tool outputs before asking for conversation compaction', () => {
    const session = sessionWithToolRounds(3, 2_000);
    const originalMessages = structuredClone(session.messages);

    const context = buildAgentContext(session, tools(), {
      modelContextTokens: 700,
      maxOutputTokens: 100,
      keepRecentMessages: 2,
      maxToolResultChars: 220,
      warningThresholdRatio: 0.1,
      compactionThresholdRatio: 0.95,
    });

    expect(context.compression.maskedToolResultCount).toBeGreaterThan(0);
    expect(context.compression.level).toBe('tool-output-masking');
    const shortenedToolOutput = context.messages.find(
      (message) =>
        message.role === 'tool' && message.content.includes('Earlier tool output shortened'),
    );
    expect(shortenedToolOutput).toBeDefined();
    expect(context.compression.finalTokenEstimate).toBeLessThan(
      context.compression.originalTokenEstimate,
    );
    expect(session.messages).toEqual(originalMessages);
  });

  it('never splits an assistant tool call from its following tool result', () => {
    const session = sessionWithToolRounds(8, 200);
    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 5,
      },
      'auto',
    );

    expect(plan).toBeDefined();
    const covered = session.messages
      .filter((message) => message.role !== 'system')
      .slice(0, plan?.coveredConversationMessageCount);
    const lastCovered = covered.at(-1);
    expect(lastCovered?.role === 'assistant' && Boolean(lastCovered.toolCalls?.length)).toBe(false);
    expect(plan?.sourceMessages.length).toBeGreaterThan(0);
  });

  it('batches a long compaction source on complete tool interaction boundaries', () => {
    const session = sessionWithToolRounds(30, 1_500);
    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_400,
        maxOutputTokens: 400,
        keepRecentMessages: 3,
      },
      'auto',
    );

    expect(plan).toBeDefined();
    if (!plan) {
      throw new Error('Expected a context compaction plan for the long session.');
    }
    expect(plan.sourceBatches.length).toBeGreaterThan(1);
    for (const batch of plan.sourceBatches) {
      const finalMessage = batch.at(-1);
      expect(finalMessage?.role === 'assistant' && Boolean(finalMessage.toolCalls?.length)).toBe(
        false,
      );
      const request = buildAgentContextCompactionRequest({
        sourceMessages: batch,
        maxToolResultChars: plan.requestMaxToolResultChars,
        maxMessageTokens: plan.requestMaxMessageTokens,
      });
      expect(estimatePromptTokens(request)).toBeLessThanOrEqual(plan.availablePromptTokens);
    }
  });

  it('caps one oversized historical message to a valid compaction request', () => {
    const session = createAgentSession({
      id: 'oversized-source',
      title: 'Oversized source',
      mode: 'read',
      now,
    });
    appendMessage(
      session,
      createMessage(
        {
          role: 'user',
          content: `必须保留 public.orders.amount 与精确金额 1726.50。${'超长历史输入。'.repeat(8_000)}`,
        },
        now,
      ),
    );
    for (let index = 0; index < 8; index += 1) {
      appendMessage(session, createMessage({ role: 'assistant', content: `recent-${index}` }, now));
    }

    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_400,
        maxOutputTokens: 400,
        keepRecentMessages: 4,
      },
      'manual',
    );

    expect(plan).toBeDefined();
    expect(estimatePromptTokens(plan?.requestMessages ?? [])).toBeLessThanOrEqual(
      plan?.availablePromptTokens ?? 0,
    );
    expect(plan?.requestMessages[1]?.content).toContain('full text remains in session history');
    expect(plan?.requestMessages[1]?.content).toContain('public.orders.amount');
  });

  it('uses a semantic checkpoint as the model view without deleting full history', () => {
    const session = sessionWithToolRounds(8, 200);
    const originalCount = session.messages.length;
    const firstRawMessage = session.messages[0]?.content ?? '';
    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 5,
      },
      'auto',
    );
    expect(plan).toBeDefined();
    if (!plan) return;
    session.contextCheckpoint = createAgentContextCheckpoint({
      session,
      plan,
      method: 'model',
      summary: '## Goal\n统计订单。\n## Database facts and SQL\norders.amount 是金额列。',
      now: now(),
    });

    const context = buildAgentContext(session, tools(), {
      modelContextTokens: 2_000,
      maxOutputTokens: 300,
      keepRecentMessages: 5,
    });
    const visibleText = context.messages.map((message) => message.content).join('\n');

    expect(session.messages).toHaveLength(originalCount);
    expect(visibleText).toContain('orders.amount 是金额列');
    expect(visibleText).not.toContain(firstRawMessage);
    expect(visibleText).not.toContain('coveredConversationMessageCount');
    expect(visibleText).not.toContain('activeCheckpointSequence');
    expect(context.compression.activeCheckpointSequence).toBe(1);
  });

  it('builds cumulative checkpoints across repeated compactions', () => {
    const session = sessionWithToolRounds(8, 120);
    const firstPlan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 5,
      },
      'auto',
    );
    expect(firstPlan).toBeDefined();
    if (!firstPlan) return;
    session.contextCheckpoint = createAgentContextCheckpoint({
      session,
      plan: firstPlan,
      method: 'model',
      summary: '第一阶段：确认 orders 表，已完成订单数统计。',
      now: now(),
    });
    appendToolRound(session, 9, 150);
    appendToolRound(session, 10, 150);
    appendToolRound(session, 11, 150);

    const secondPlan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 4,
      },
      'auto',
    );

    expect(secondPlan?.previousSummary).toContain('第一阶段');
    expect(
      secondPlan?.requestMessages.some((message) => message.content.includes('第一阶段')),
    ).toBe(true);
    expect(secondPlan?.coveredConversationMessageCount).toBeGreaterThan(
      firstPlan.coveredConversationMessageCount,
    );
    if (!secondPlan) return;
    const secondCheckpoint = createAgentContextCheckpoint({
      session,
      plan: secondPlan,
      method: 'model',
      summary: '累计摘要：订单数和金额均已确认。',
      now: now(),
    });
    expect(secondCheckpoint.sequence).toBe(2);
  });

  it('supports manual focus instructions through the same compaction plan', () => {
    const session = sessionWithToolRounds(6, 100);
    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 4,
      },
      'manual',
      '重点保留已执行 SQL 和精确金额。',
    );

    expect(plan?.trigger).toBe('manual');
    expect(plan?.focus).toBe('重点保留已执行 SQL 和精确金额。');
    expect(
      plan?.requestMessages.some((message) => message.content.includes('<manual_focus>')),
    ).toBe(true);
  });

  it('provides a structured deterministic recovery summary', () => {
    const session = sessionWithToolRounds(5, 120);
    const plan = createAgentContextCompactionPlan(
      session,
      {
        modelContextTokens: 2_000,
        maxOutputTokens: 300,
        keepRecentMessages: 3,
      },
      'manual',
    );
    expect(plan).toBeDefined();
    if (!plan) return;

    const summary = buildDeterministicContextSummary(plan);

    expect(summary).toContain('Goal and user requirements');
    expect(summary).toContain('Actions, SQL/tool results, and errors');
    expect(summary).toContain('query_database');
    expect(summary).not.toContain('call_internal_');
  });

  it('reports a physical window overflow without calling it a spend budget', () => {
    const session = createAgentSession({
      id: 'overflow',
      title: 'Overflow',
      mode: 'read',
      now,
    });
    appendMessage(session, createMessage({ role: 'user', content: '订单数据 '.repeat(500) }, now));

    const context = buildAgentContext(session, tools(), {
      modelContextTokens: 200,
      maxOutputTokens: 50,
    });

    expect(context.compression.phase).toBe('window_exceeded');
    expect(context.requiresCompaction).toBe(true);
    expect(context.compression.warnings.join(' ')).toContain('model input capacity');
    expect(context.compression.warnings.join(' ').toLowerCase()).not.toContain('budget');
  });

  it('estimates messages and tool definitions together', () => {
    expect(estimatePromptTokens([{ role: 'user', content: '订单 GMV' }], tools())).toBeGreaterThan(
      0,
    );
  });
});

function sessionWithToolRounds(count: number, payloadChars: number) {
  const session = createAgentSession({
    id: 'long-session',
    title: 'Long session',
    mode: 'read',
    now,
  });
  appendMessage(session, createMessage({ role: 'user', content: '统计订单并保留精确结果。' }, now));
  for (let index = 1; index <= count; index += 1) {
    appendToolRound(session, index, payloadChars);
  }
  return session;
}

function appendToolRound(
  session: ReturnType<typeof createAgentSession>,
  index: number,
  payloadChars: number,
): void {
  appendMessage(
    session,
    createMessage(
      {
        role: 'assistant',
        content: `第 ${index} 轮查询`,
        toolCalls: [
          {
            id: `call_internal_${index}`,
            name: 'query_database',
            arguments: {
              sql: `select ${index} as round_no, sum(amount) from orders`,
            },
          },
        ],
      },
      now,
    ),
  );
  appendMessage(
    session,
    createMessage(
      {
        role: 'tool',
        toolCallId: `call_internal_${index}`,
        toolName: 'query_database',
        content: JSON.stringify({
          round: index,
          amount: index * 100,
          payload: 'x'.repeat(payloadChars),
        }),
      },
      now,
    ),
  );
}

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
