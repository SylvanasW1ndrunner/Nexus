import { describe, expect, it } from 'vitest';
import type { DatabaseConnector } from '../src/index.js';
import {
  ALL_DATABASE_CAPABILITIES,
  ConnectorNotFoundError,
  ConnectorRegistry,
  PostgresConnector,
} from '../src/index.js';

describe('ConnectorRegistry', () => {
  it('registers, finds, lists, replaces and unregisters connectors', () => {
    const registry = new ConnectorRegistry();
    const postgres = new PostgresConnector();
    expect(
      ALL_DATABASE_CAPABILITIES.filter((key) => !postgres.manifest.capabilities[key]),
    ).toEqual([]);
    registry.register(postgres);
    expect(registry.size).toBe(1);
    expect(registry.get('postgres-native')).toBe(postgres);
    expect(registry.find({ engine: 'postgres' })).toEqual([postgres]);
    expect(registry.find({ engine: 'postgres', transport: 'tcp' })).toEqual([postgres]);
    expect(registry.find({ engine: 'postgres', transport: 'http' })).toEqual([]);
    expect(registry.list()[0]).not.toBe(postgres.manifest);

    const replacement = new PostgresConnector();
    registry.replace(replacement);
    expect(registry.get('postgres-native')).toBe(replacement);
    expect(registry.unregister('postgres-native')).toBe(true);
    expect(registry.unregister('postgres-native')).toBe(false);
    expect(() => registry.get('postgres-native')).toThrow(ConnectorNotFoundError);
  });

  it('rejects duplicate ids and invalid manifests or capability keys', () => {
    const registry = new ConnectorRegistry();
    const postgres = new PostgresConnector();
    registry.register(postgres);
    expect(() => registry.register(new PostgresConnector())).toThrow(/already registered/);

    const invalidTransport = {
      ...postgres,
      manifest: { ...postgres.manifest, id: 'invalid', transports: [] },
    } as unknown as DatabaseConnector;
    expect(() => registry.register(invalidTransport)).toThrow(/at least one transport/);

    const invalidCapability = {
      ...postgres,
      manifest: {
        ...postgres.manifest,
        id: 'mismatch',
        capabilities: {
          query: {
            key: 'different',
            status: 'supported',
            source: 'test',
            observedAt: new Date().toISOString(),
          },
        },
      },
    } as unknown as DatabaseConnector;
    expect(() => registry.register(invalidCapability)).toThrow(/key mismatch/);
  });
});
