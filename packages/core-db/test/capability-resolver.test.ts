import { describe, expect, it } from 'vitest';
import {
  CapabilityResolver,
  CapabilityUnavailableError,
  DATABASE_CAPABILITIES,
} from '../src/index.js';

describe('CapabilityResolver', () => {
  it('resolves ordered layers and retains source, limits and engine context', () => {
    const resolver = new CapabilityResolver();
    const profile = resolver.resolve({
      connectorId: 'mock',
      engine: 'warehouse',
      engineVersion: '2',
      resourceId: 'cluster-1',
      connectionProfileId: 'profile-1',
      resolvedAt: '2026-07-23T00:00:00.000Z',
      layers: [
        {
          source: 'manifest',
          capabilities: {
            [DATABASE_CAPABILITIES.SQL_QUERY]: {
              key: DATABASE_CAPABILITIES.SQL_QUERY,
              status: 'supported',
              limits: { maximumSqlBytes: 1000 },
            },
          },
        },
        {
          source: 'account',
          capabilities: {
            [DATABASE_CAPABILITIES.SQL_QUERY]: {
              key: DATABASE_CAPABILITIES.SQL_QUERY,
              status: 'supported',
              limits: { maximumSqlBytes: 500 },
            },
          },
        },
      ],
    });
    expect(profile).toMatchObject({
      connectorId: 'mock',
      engine: 'warehouse',
      engineVersion: '2',
      resourceId: 'cluster-1',
      connectionProfileId: 'profile-1',
    });
    expect(profile.capabilities[DATABASE_CAPABILITIES.SQL_QUERY]).toMatchObject({
      status: 'supported',
      source: 'account',
      limits: { maximumSqlBytes: 500 },
    });
  });

  it('represents supported, conditional, unsupported and unknown without guessing', () => {
    const resolver = new CapabilityResolver();
    const profile = resolver.resolve({
      connectorId: 'mock',
      engine: 'mock',
      layers: [
        {
          source: 'manifest',
          capabilities: {
            supported: { key: 'supported', status: 'supported' },
            conditional: {
              key: 'conditional',
              status: 'conditional',
              constraints: [{ name: 'approved', value: true }],
            },
            unsupported: {
              key: 'unsupported',
              status: 'unsupported',
              reason: 'Engine has no transactions',
            },
            unknown: { key: 'unknown', status: 'unknown' },
          },
        },
      ],
    });
    expect(resolver.get(profile, 'supported').status).toBe('supported');
    expect(resolver.get(profile, 'conditional').status).toBe('conditional');
    expect(resolver.get(profile, 'unsupported').status).toBe('unsupported');
    expect(resolver.get(profile, 'unknown').status).toBe('unknown');
    expect(resolver.get(profile, 'undeclared')).toMatchObject({
      status: 'unknown',
      source: 'implicit-unknown',
    });
  });

  it('evaluates every constraint operator and supports authorized conditional use', () => {
    const resolver = new CapabilityResolver();
    const constraints = [
      { name: 'equal', operator: 'eq' as const, value: 'x' },
      { name: 'different', operator: 'neq' as const, value: 'x' },
      { name: 'less', operator: 'lt' as const, value: 10 },
      { name: 'lessEqual', operator: 'lte' as const, value: 10 },
      { name: 'greater', operator: 'gt' as const, value: 10 },
      { name: 'greaterEqual', operator: 'gte' as const, value: 10 },
      { name: 'member', operator: 'in' as const, value: ['a', 'b'] },
      { name: 'array', operator: 'contains' as const, value: 'a' },
      { name: 'text', operator: 'contains' as const, value: 'needle' },
    ];
    const profile = resolver.resolve({
      connectorId: 'mock',
      engine: 'mock',
      layers: [
        {
          source: 'policy',
          capabilities: {
            action: { key: 'action', status: 'conditional', constraints },
          },
        },
      ],
    });
    const requirement = {
      key: 'action',
      context: {
        equal: 'x',
        different: 'y',
        less: 9,
        lessEqual: 10,
        greater: 11,
        greaterEqual: 10,
        member: 'b',
        array: ['a', 'c'],
        text: 'find-a-needle-here',
      },
    };
    expect(resolver.check(profile, requirement)).toMatchObject({ satisfied: true });
    expect(resolver.require(profile, requirement).key).toBe('action');
    const denied = resolver.check(profile, { key: 'action', context: { equal: 'wrong' } });
    expect(denied.satisfied).toBe(false);
    expect(denied.unmetConstraints).toHaveLength(constraints.length);
  });

  it('downgrades supported capabilities when runtime constraints are unmet', () => {
    const resolver = new CapabilityResolver();
    const profile = resolver.resolve({
      connectorId: 'mock',
      engine: 'mock',
      layers: [
        {
          source: 'resource',
          capabilities: {
            write: {
              key: 'write',
              status: 'supported',
              constraints: [{ name: 'role', value: 'primary' }],
            },
          },
        },
      ],
      context: { role: 'replica' },
    });
    expect(profile.capabilities.write).toMatchObject({ status: 'conditional' });
    expect(() => resolver.require(profile, { key: 'write', context: { role: 'replica' } })).toThrow(
      CapabilityUnavailableError,
    );
    expect(() => resolver.require(profile, { key: 'missing' })).toThrow(
      /Capability missing is unknown/,
    );
  });
});
