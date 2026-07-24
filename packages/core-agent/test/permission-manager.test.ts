import { describe, expect, it } from 'vitest';
import {
  PermissionManager,
  decideAutomaticPermission,
  type AgentMode,
  type ToolDangerLevel,
} from '../src/index.js';

describe('decideAutomaticPermission', () => {
  it('implements the product read/edit/full ladder independently of tool danger labels', () => {
    const readTool = {
      dangerLevel: 'high' as const,
      readonly: false,
      requiredPermission: 'read' as const,
    };
    const editTool = {
      dangerLevel: 'safe' as const,
      readonly: true,
      requiredPermission: 'edit' as const,
    };
    const fullTool = {
      dangerLevel: 'medium' as const,
      readonly: false,
      requiredPermission: 'full' as const,
    };

    expect(decideAutomaticPermission('read', readTool)).toBe('allow');
    expect(decideAutomaticPermission('read', editTool)).toBe('ask');
    expect(decideAutomaticPermission('read', fullTool)).toBe('ask');
    expect(decideAutomaticPermission('edit', readTool)).toBe('allow');
    expect(decideAutomaticPermission('edit', editTool)).toBe('allow');
    expect(decideAutomaticPermission('edit', fullTool)).toBe('ask');
    expect(decideAutomaticPermission('full', readTool)).toBe('allow');
    expect(decideAutomaticPermission('full', editTool)).toBe('allow');
    expect(decideAutomaticPermission('full', fullTool)).toBe('allow');
  });

  it('keeps a stable mode and danger-level matrix for runtime tool decisions', () => {
    const cases: Array<{
      mode: AgentMode;
      dangerLevel: ToolDangerLevel;
      readonly?: boolean;
      decision: 'allow' | 'deny' | 'ask';
    }> = [
      { mode: 'readonly', dangerLevel: 'safe', readonly: true, decision: 'allow' },
      { mode: 'readonly', dangerLevel: 'medium', readonly: true, decision: 'allow' },
      { mode: 'readonly', dangerLevel: 'high', readonly: true, decision: 'allow' },
      { mode: 'readonly', dangerLevel: 'critical', readonly: true, decision: 'allow' },
      { mode: 'readonly', dangerLevel: 'safe', readonly: false, decision: 'deny' },
      { mode: 'readonly', dangerLevel: 'medium', readonly: false, decision: 'deny' },
      { mode: 'readonly', dangerLevel: 'high', readonly: false, decision: 'deny' },
      { mode: 'readonly', dangerLevel: 'critical', readonly: false, decision: 'deny' },
      { mode: 'ask', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'ask', dangerLevel: 'medium', decision: 'ask' },
      { mode: 'ask', dangerLevel: 'high', decision: 'ask' },
      { mode: 'ask', dangerLevel: 'critical', decision: 'deny' },
      { mode: 'auto', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'auto', dangerLevel: 'medium', decision: 'ask' },
      { mode: 'auto', dangerLevel: 'high', decision: 'ask' },
      { mode: 'auto', dangerLevel: 'critical', decision: 'deny' },
      { mode: 'full-auto', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'full-auto', dangerLevel: 'medium', decision: 'allow' },
      { mode: 'full-auto', dangerLevel: 'high', decision: 'allow' },
      { mode: 'full-auto', dangerLevel: 'critical', decision: 'ask' },
    ];

    for (const item of cases) {
      expect(
        decideAutomaticPermission(item.mode, {
          dangerLevel: item.dangerLevel,
          ...(item.readonly === undefined ? {} : { readonly: item.readonly }),
        }),
        `${item.mode} ${item.dangerLevel} readonly=${String(item.readonly)}`,
      ).toBe(item.decision);
    }
  });

  it('allows safe tools in every mode', () => {
    expect(decideAutomaticPermission('readonly', { dangerLevel: 'safe', readonly: true })).toBe('allow');
    expect(decideAutomaticPermission('ask', { dangerLevel: 'safe' })).toBe('allow');
  });

  it('denies write-capable tools in readonly mode', () => {
    expect(decideAutomaticPermission('readonly', { dangerLevel: 'medium', readonly: false })).toBe('deny');
  });

  it('allows readonly medium tools in readonly mode for SELECT-style work', () => {
    expect(decideAutomaticPermission('readonly', { dangerLevel: 'medium', readonly: true })).toBe('allow');
  });

  it('keeps critical tools behind a hard approval boundary even in full-auto', () => {
    expect(decideAutomaticPermission('full-auto', { dangerLevel: 'critical' })).toBe('ask');
  });

  it('allows high tools in full-auto but asks in normal modes', () => {
    expect(decideAutomaticPermission('full-auto', { dangerLevel: 'high' })).toBe('allow');
    expect(decideAutomaticPermission('auto', { dangerLevel: 'high' })).toBe('ask');
    expect(decideAutomaticPermission('ask', { dangerLevel: 'high' })).toBe('ask');
  });
});

describe('PermissionManager', () => {
  it('turns an operation above the selected access level into a one-time approval request', async () => {
    const requests: string[] = [];
    const manager = new PermissionManager((request) => {
      requests.push(
        `${request.mode}:${request.tool.requiredPermission}:${request.toolCall.id}`,
      );
      return {
        approved: true,
        requestId: 'permission-dialog-1',
        approvedBy: 'user',
      };
    });
    const result = await manager.checkDetailed({
      mode: 'read',
      tool: {
        name: 'sql_execute',
        description: '',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        requiredPermission: 'edit',
      },
      toolCall: {
        id: 'call-update',
        name: 'sql_execute',
        arguments: { sql: 'UPDATE orders SET status = \'paid\' WHERE id = 1' },
      },
    });

    expect(requests).toEqual(['read:edit:call-update']);
    expect(result).toMatchObject({
      decision: 'allow',
      source: 'approval-provider',
      approvalRequestId: 'permission-dialog-1',
      approvedBy: 'user',
    });
  });

  it('distinguishes automatic allow from approval-provider allow', async () => {
    const automatic = await new PermissionManager().checkDetailed({
      mode: 'full-auto',
      tool: { name: 'execute_sql', description: '', inputSchema: { type: 'object' }, dangerLevel: 'high' },
      toolCall: { id: 'call_auto', name: 'execute_sql', arguments: {} },
    });
    expect(automatic).toEqual({ decision: 'allow', source: 'automatic' });

    const approved = await new PermissionManager(() => true).checkDetailed({
      mode: 'ask',
      tool: { name: 'execute_sql', description: '', inputSchema: { type: 'object' }, dangerLevel: 'high' },
      toolCall: { id: 'call_approved', name: 'execute_sql', arguments: {} },
    });
    expect(approved).toEqual({ decision: 'allow', source: 'approval-provider' });
  });

  it('preserves structured approval provenance from the provider', async () => {
    const approved = await new PermissionManager(() => ({
      approved: true,
      requestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:00.000Z',
      approvedBy: 'tester',
      reason: '业务确认',
    })).checkDetailed({
      mode: 'ask',
      tool: { name: 'execute_sql', description: '', inputSchema: { type: 'object' }, dangerLevel: 'high' },
      toolCall: { id: 'call_approved', name: 'execute_sql', arguments: {} },
    });

    expect(approved).toEqual({
      decision: 'allow',
      source: 'approval-provider',
      approvalRequestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:00.000Z',
      approvedBy: 'tester',
      reason: '业务确认',
    });
  });
});
