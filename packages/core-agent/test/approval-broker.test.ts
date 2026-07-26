import { describe, expect, it } from 'vitest';
import { AgentToolApprovalBroker, type PermissionRequest } from '../src/index.js';

describe('AgentToolApprovalBroker', () => {
  it('queues a redacted approval request and resolves approval provenance', async () => {
    const now = sequenceNow(['2026-07-10T01:00:00.000Z', '2026-07-10T01:00:02.000Z']);
    const broker = new AgentToolApprovalBroker({
      now,
      createRequestId: () => 'approval_1',
      approvalTimeoutMs: 1_000,
    });

    const resultPromise = broker.requestApproval(
      request({ password: 'secret-pass', sql: 'delete from orders' }),
    );

    expect(broker.listPending()).toEqual([
      expect.objectContaining({
        id: 'approval_1',
        status: 'pending',
        mode: 'read',
        sessionId: 'session_1',
        toolCallId: 'call_write',
        toolName: 'execute_sql',
        dangerLevel: 'high',
        readonly: false,
        createdAt: '2026-07-10T01:00:00.000Z',
      }),
    ]);
    expect(broker.listPending()[0]?.argumentPreview).toContain('[REDACTED]');
    expect(broker.listPending()[0]?.argumentPreview).not.toContain('secret-pass');

    expect(broker.approve('approval_1', { resolvedBy: 'tester', reason: '业务确认' })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      approved: true,
      requestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:02.000Z',
      approvedBy: 'tester',
      reason: '业务确认',
    });
    expect(broker.getRequest('approval_1')).toMatchObject({
      status: 'approved',
      resolvedAt: '2026-07-10T01:00:02.000Z',
      resolvedBy: 'tester',
    });
  });

  it('returns a denied approval result without executing the pending request', async () => {
    const broker = new AgentToolApprovalBroker({
      now: sequenceNow(['2026-07-10T01:00:00.000Z', '2026-07-10T01:00:01.000Z']),
      createRequestId: () => 'approval_deny',
      approvalTimeoutMs: 1_000,
    });

    const resultPromise = broker.requestApproval(request({ sql: 'drop table orders' }));
    expect(broker.deny('approval_deny', { resolvedBy: 'tester', reason: '风险过高' })).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      approved: false,
      requestId: 'approval_deny',
      approvedBy: 'tester',
      reason: '风险过高',
    });
    expect(broker.getRequest('approval_deny')).toMatchObject({ status: 'denied' });
  });

  it('expires unanswered requests', async () => {
    const broker = new AgentToolApprovalBroker({
      now: () => '2026-07-10T01:00:00.000Z',
      createRequestId: () => 'approval_timeout',
      approvalTimeoutMs: 1,
    });

    const result = await broker.requestApproval(
      request({ sql: 'alter table orders add column note text' }),
    );

    expect(result).toEqual({
      approved: false,
      requestId: 'approval_timeout',
      reason: 'approval request expired',
    });
    expect(broker.getRequest('approval_timeout')).toMatchObject({ status: 'expired' });
  });

  it('cancels requests when the Agent run aborts', async () => {
    const controller = new AbortController();
    const broker = new AgentToolApprovalBroker({
      now: () => '2026-07-10T01:00:00.000Z',
      createRequestId: () => 'approval_abort',
      approvalTimeoutMs: 1_000,
    });

    const resultPromise = broker.requestApproval(
      request({ sql: 'delete from orders' }, { signal: controller.signal }),
    );
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      approved: false,
      requestId: 'approval_abort',
      reason: 'approval request was cancelled',
    });
    expect(broker.getRequest('approval_abort')).toMatchObject({ status: 'cancelled' });
  });

  it('cancels only pending approvals owned by a steered Session', async () => {
    let id = 0;
    const broker = new AgentToolApprovalBroker({
      createRequestId: () => `approval_${++id}`,
      approvalTimeoutMs: 1_000,
    });
    const first = broker.requestApproval(request({ sql: 'delete from orders' }));
    const second = broker.requestApproval(
      request({ sql: 'delete from other_orders' }, { sessionId: 'session_2' }),
    );

    expect(broker.cancelSession('session_1')).toBe(1);
    await expect(first).resolves.toMatchObject({
      approved: false,
      reason: 'approval request was superseded by new user input',
    });
    expect(broker.listPending()).toHaveLength(1);
    expect(broker.deny('approval_2')).toBe(true);
    await second;
  });
});

function request(
  args: Record<string, unknown>,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    mode: 'read',
    sessionId: 'session_1',
    sessionTitle: '订单清理',
    tool: {
      name: 'execute_sql',
      description: 'Execute SQL',
      inputSchema: { type: 'object' },
      dangerLevel: 'high',
      readonly: false,
      source: 'database',
    },
    toolCall: { id: 'call_write', name: 'execute_sql', arguments: args },
    ...overrides,
  };
}

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? values[values.length - 1] ?? '';
}
