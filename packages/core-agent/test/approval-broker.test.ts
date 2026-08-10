import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AgentToolApprovalBroker, type PermissionRequest } from '../src/index.js';

describe('deprecated AgentToolApprovalBroker legacy compatibility path', () => {
  it('preserves its public pending request workflow until the atomic cutover', async () => {
    let notification: ReturnType<AgentToolApprovalBroker['listPending']>[number] | undefined;
    const broker = new AgentToolApprovalBroker({
      now: sequenceNow(['2026-07-10T01:00:00.000Z', '2026-07-10T01:00:02.000Z']),
      createRequestId: () => 'approval_1',
      onRequest: (request) => { notification = request; },
    });

    const resultPromise = broker.requestApproval(
      request({ password: 'secret-pass', sql: 'delete from orders' }),
    );

    expect(notification).toMatchObject({
      id: 'approval_1', status: 'pending', sessionId: 'session_1',
      toolCallId: 'call_write', toolName: 'execute_sql',
    });
    expect(notification?.argumentPreview).toContain('[REDACTED]');
    expect(notification?.argumentPreview).not.toContain('secret-pass');
    expect(broker.listPending()).toHaveLength(1);
    expect(broker.listAll()).toHaveLength(1);
    expect(broker.getRequest('approval_1')).toMatchObject({ status: 'pending' });

    expect(broker.approve('approval_1', { resolvedBy: 'tester', reason: 'approved' })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      approved: true,
      requestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:02.000Z',
      approvedBy: 'tester',
      reason: 'approved',
    });
    expect(broker.deny('approval_1')).toBe(false);
    expect(broker.getRequest('approval_1')).toMatchObject({
      status: 'approved', resolvedBy: 'tester',
    });
  });

  it('preserves the legacy timeout behavior without affecting Journal approval truth', async () => {
    const broker = new AgentToolApprovalBroker({
      createRequestId: () => 'approval_no_timeout',
      approvalTimeoutMs: 1,
    });
    const result = await broker.requestApproval(
      request({ sql: 'alter table orders add note text' }),
    );
    expect(result).toMatchObject({
      approved: false, reason: 'approval request expired',
    });
    expect(broker.getRequest('approval_no_timeout')).toMatchObject({ status: 'expired' });
  });

  it('preserves abort and status visibility for the legacy public path', async () => {
    const controller = new AbortController();
    const broker = new AgentToolApprovalBroker({
      createRequestId: () => 'approval_abort',
    });
    const result = broker.requestApproval(
      request({ sql: 'delete from orders' }, { signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toEqual({
      approved: false,
      requestId: 'approval_abort',
      reason: 'approval request was cancelled',
    });
    expect(broker.getRequest('approval_abort')).toMatchObject({ status: 'cancelled' });
  });

  it('removes the transient waiter when notification delivery throws', async () => {
    const broker = new AgentToolApprovalBroker({
      createRequestId: () => 'approval_notification_failure',
      onRequest: () => { throw new Error('notification transport failed'); },
    });

    await expect(broker.requestApproval(request({ sql: 'delete from orders' })))
      .rejects.toThrow('notification transport failed');
    expect(broker.approve('approval_notification_failure')).toBe(false);
  });

  it('keeps the Journal-backed primary free of in-memory approval Maps', async () => {
    const source = await readFile(
      new URL('../src/approval-broker.ts', import.meta.url),
      'utf8',
    );
    const primary = source.slice(
      source.indexOf('export class JournalApprovalBroker'),
      source.indexOf('export type AgentToolApprovalBrokerOptions'),
    );
    expect(primary).not.toMatch(/new Map/u);
    expect(primary).not.toContain('AgentToolApprovalRequest');
    expect(source).toContain('Task 9/11 performs the atomic');
  });
});

function request(
  args: Record<string, unknown>,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    mode: 'read',
    sessionId: 'session_1',
    sessionTitle: 'Order cleanup',
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
