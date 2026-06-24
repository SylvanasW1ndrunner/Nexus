import { describe, expect, it } from 'vitest';
import { PermissionManager, decideAutomaticPermission } from '../src/index.js';

describe('decideAutomaticPermission', () => {
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
});
