import { describe, expect, it } from 'vitest';
import {
  DatabaseDriverRegistry,
  PostgresDriver,
  createDefaultDatabaseDriverRegistry,
  type DatabaseDriverRegistration,
  type IDatabaseDriver,
} from '../src/index.js';

describe('DatabaseDriverRegistry', () => {
  it('creates PostgreSQL drivers from the default registry', () => {
    const registry = createDefaultDatabaseDriverRegistry();

    expect(registry.has('postgres')).toBe(true);
    expect(registry.create('postgres')).toBeInstanceOf(PostgresDriver);
  });

  it('reuses one driver instance per engine for active connection pools', () => {
    const registry = createDefaultDatabaseDriverRegistry();

    expect(registry.get('postgres')).toBe(registry.get('postgres'));
    expect(registry.get('postgres')).toBeInstanceOf(PostgresDriver);
  });

  it('exposes immutable capability snapshots for registered engines', () => {
    const registry = createDefaultDatabaseDriverRegistry();
    const capabilities = registry.listCapabilities();

    expect(capabilities).toEqual([
      {
        engine: 'postgres',
        supportsTransactions: true,
        supportsExplain: true,
        supportsSchemas: true,
      },
    ]);

    capabilities[0]!.supportsExplain = false;
    expect(registry.listCapabilities()[0]!.supportsExplain).toBe(true);
  });

  it('rejects registrations whose engine does not match capabilities', () => {
    const registration: DatabaseDriverRegistration = {
      engine: 'postgres',
      capabilities: {
        engine: 'mysql' as 'postgres',
        supportsTransactions: true,
        supportsExplain: false,
        supportsSchemas: false,
      },
      create: () => ({}) as IDatabaseDriver,
    };

    expect(() => new DatabaseDriverRegistry([registration])).toThrow(/registration mismatch/i);
  });

  it('fails fast when an engine is not registered', () => {
    const registry = new DatabaseDriverRegistry();

    expect(() => registry.create('postgres')).toThrow(/not registered/i);
  });
});
