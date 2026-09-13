import { describe, expect, it } from 'vitest';
import {
  PermissionManager,
  decideAutomaticPermission,
  type AgentToolPermissionFacts,
} from '../src/index.js';
import { preparedToolIntent } from './permission-audit-fixture.js';

function facts(overrides: Partial<AgentToolPermissionFacts> = {}): AgentToolPermissionFacts {
  return {
    toolName: 'workspace.write',
    dangerLevel: 'safe',
    readonly: false,
    access: 'write',
    recoveryClass: 'idempotent',
    actions: ['write'],
    paths: [],
    hosts: [],
    network: false,
    externalWrite: false,
    destructive: false,
    credentials: false,
    admin: false,
    unknownRisk: false,
    resolvedAddresses: [],
    targets: [],
    ...overrides,
  };
}

describe('PermissionManager', () => {
  it('asks in default mode for external writes and network access', () => {
    expect(decideAutomaticPermission('default', facts({ externalWrite: true }))).toBe('ask');
    expect(
      decideAutomaticPermission('default', facts({ network: true, actions: ['network'] })),
    ).toBe('ask');
  });

  it('asks in auto mode only for risky facts', () => {
    expect(decideAutomaticPermission('auto', facts({ externalWrite: true }))).toBe('allow');
    expect(decideAutomaticPermission('auto', facts({ dangerLevel: 'high' }))).toBe('ask');
    expect(
      decideAutomaticPermission('auto', facts({ destructive: true, actions: ['delete'] })),
    ).toBe('ask');
  });

  it('automatically allows built-in decisions in full-access mode', () => {
    expect(
      decideAutomaticPermission('full-access', facts({ dangerLevel: 'critical', admin: true })),
    ).toBe('allow');
  });

  it('uses the strictest matching enterprise rule: deny then ask then allow', () => {
    const manager = new PermissionManager({
      rules: [
        { id: 'allow-workspace', decision: 'allow', tools: ['workspace.*'] },
        { id: 'ask-write', decision: 'ask', actions: ['write'] },
        { id: 'deny-production', decision: 'deny', paths: ['*/production/*'] },
      ],
    });
    const evaluation = manager.evaluate(
      'full-access',
      facts({ paths: ['/srv/production/app.ts'] }),
    );
    expect(evaluation.decision).toBe('deny');
    expect(evaluation.matchedRuleIds).toEqual(['allow-workspace', 'ask-write', 'deny-production']);
    expect(manager.evaluate('full-access', facts()).decision).toBe('ask');
    expect(
      new PermissionManager({
        rules: [{ id: 'allow-only', decision: 'allow', tools: ['workspace.*'] }],
      }).evaluate('default', facts()).decision,
    ).toBe('allow');
  });

  it('publishes replacement rules and their revision atomically for later evaluations', () => {
    const manager = new PermissionManager({ revision: 'policy:v1' });
    expect(manager.evaluate('full-access', facts()).decision).toBe('allow');
    expect(manager.evaluate('full-access', facts()).policyRevision).toBe('policy:v1');

    manager.replacePolicy({
      revision: 'policy:v2',
      rules: [{ id: 'deny-write', decision: 'deny', actions: ['write'] }],
    });
    expect(manager.evaluate('full-access', facts())).toMatchObject({
      decision: 'deny',
      policyRevision: 'policy:v2',
      matchedRuleIds: ['deny-write'],
    });
  });

  it('treats an explicitly empty selector as matching nothing', () => {
    const manager = new PermissionManager({
      rules: [{ id: 'empty-tools', decision: 'deny', tools: [] }],
    });
    expect(manager.evaluate('full-access', facts()).decision).toBe('allow');
    expect(manager.evaluate('full-access', facts()).matchedRuleIds).toEqual([]);
  });

  it('uses the prepared invocation permission facts at the unique policy boundary', () => {
    const { intent } = preparedToolIntent({
      toolName: 'plain_write',
      recoveryClass: 'idempotent',
    });
    expect(intent.permission.actions).toEqual(['write']);
    expect(intent.permission.access).toBe('write');
  });
});
