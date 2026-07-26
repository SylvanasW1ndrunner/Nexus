import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresDriver } from '../src/postgres-driver.js';
import type { DatabaseConnectionConfig } from '../src/types.js';

const poolConfigurations: Array<Record<string, unknown>> = [];

vi.mock('pg', () => ({
  Pool: class {
    constructor(configuration: Record<string, unknown>) {
      poolConfigurations.push(configuration);
    }

    connect() {
      return Promise.resolve({
        query: () => Promise.resolve({ rows: [{ ok: 1 }] }),
        release() {},
      });
    }

    end() {
      return Promise.resolve();
    }
  },
}));

describe('PostgresDriver TLS modes', () => {
  beforeEach(() => {
    poolConfigurations.length = 0;
  });

  it('distinguishes encryption-only, CA-only, and full hostname verification', async () => {
    const driver = new PostgresDriver();

    await expect(driver.test(connection('require'))).resolves.toMatchObject({ ok: true });
    await expect(driver.test(connection('verify-ca'))).resolves.toMatchObject({ ok: true });
    await expect(driver.test(connection('verify-full'))).resolves.toMatchObject({ ok: true });

    expect(poolConfigurations[0]?.ssl).toEqual({ rejectUnauthorized: false });
    const verifyCa = poolConfigurations[1]?.ssl as {
      rejectUnauthorized?: boolean;
      checkServerIdentity?: (host: string, certificate: unknown) => Error | undefined;
    };
    expect(verifyCa.rejectUnauthorized).toBe(true);
    expect(typeof verifyCa.checkServerIdentity).toBe('function');
    expect(verifyCa.checkServerIdentity?.('db.example.com', {})).toBeUndefined();
    expect(poolConfigurations[2]?.ssl).toEqual({ rejectUnauthorized: true });
  });
});

function connection(ssl: NonNullable<DatabaseConnectionConfig['ssl']>): DatabaseConnectionConfig {
  return {
    id: `tls-${String(ssl)}`,
    name: 'TLS test',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'analytics',
    username: 'reader',
    ssl,
    readOnly: true,
  };
}
