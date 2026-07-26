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
      { mode: 'read', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'read', dangerLevel: 'medium', readonly: true, decision: 'allow' },
      { mode: 'read', dangerLevel: 'medium', readonly: false, decision: 'ask' },
      { mode: 'read', dangerLevel: 'high', decision: 'ask' },
      { mode: 'read', dangerLevel: 'critical', decision: 'ask' },
      { mode: 'edit', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'edit', dangerLevel: 'medium', decision: 'allow' },
      { mode: 'edit', dangerLevel: 'high', decision: 'ask' },
      { mode: 'edit', dangerLevel: 'critical', decision: 'ask' },
      { mode: 'full', dangerLevel: 'safe', decision: 'allow' },
      { mode: 'full', dangerLevel: 'medium', decision: 'allow' },
      { mode: 'full', dangerLevel: 'high', decision: 'allow' },
      { mode: 'full', dangerLevel: 'critical', decision: 'allow' },
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

  it('allows safe tools in every access level', () => {
    expect(decideAutomaticPermission('read', { dangerLevel: 'safe', readonly: true })).toBe(
      'allow',
    );
    expect(decideAutomaticPermission('edit', { dangerLevel: 'safe' })).toBe('allow');
    expect(decideAutomaticPermission('full', { dangerLevel: 'safe' })).toBe('allow');
  });

  it('asks once before using a write-capable tool above the selected level', () => {
    expect(decideAutomaticPermission('read', { dangerLevel: 'medium', readonly: false })).toBe(
      'ask',
    );
    expect(decideAutomaticPermission('edit', { dangerLevel: 'high' })).toBe('ask');
  });

  it('allows every declared permission in full mode', () => {
    expect(decideAutomaticPermission('full', { dangerLevel: 'critical' })).toBe('allow');
  });
});

describe('PermissionManager', () => {
  it('turns an operation above the selected access level into a one-time approval request', async () => {
    const requests: string[] = [];
    const manager = new PermissionManager((request) => {
      requests.push(`${request.mode}:${request.tool.requiredPermission}:${request.toolCall.id}`);
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
        arguments: { sql: "UPDATE orders SET status = 'paid' WHERE id = 1" },
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
      mode: 'full',
      tool: {
        name: 'execute_sql',
        description: '',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
      },
      toolCall: { id: 'call_auto', name: 'execute_sql', arguments: {} },
    });
    expect(automatic).toEqual({ decision: 'allow', source: 'automatic' });

    const approved = await new PermissionManager(() => true).checkDetailed({
      mode: 'read',
      tool: {
        name: 'execute_sql',
        description: '',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
      },
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
      mode: 'read',
      tool: {
        name: 'execute_sql',
        description: '',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
      },
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
