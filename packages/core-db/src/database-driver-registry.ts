import type { DatabaseEngine } from '@dbagent/shared';
import type { DatabaseCapabilities, IDatabaseDriver } from './types.js';
import { PostgresDriver } from './postgres-driver.js';

export type DatabaseDriverFactory = () => IDatabaseDriver;

export type DatabaseDriverRegistration = {
  engine: DatabaseEngine;
  capabilities: DatabaseCapabilities;
  create: DatabaseDriverFactory;
};

export class DatabaseDriverRegistry {
  private readonly registrations = new Map<DatabaseEngine, DatabaseDriverRegistration>();
  private readonly drivers = new Map<DatabaseEngine, IDatabaseDriver>();

  constructor(registrations: DatabaseDriverRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: DatabaseDriverRegistration): void {
    const engine = String(registration.engine);
    const capabilitiesEngine = String(registration.capabilities.engine);
    if (registration.engine !== registration.capabilities.engine) {
      throw new Error(
        `Driver registration mismatch: engine ${engine} does not match capabilities ${capabilitiesEngine}.`,
      );
    }
    this.registrations.set(registration.engine, registration);
  }

  has(engine: DatabaseEngine): boolean {
    return this.registrations.has(engine);
  }

  create(engine: DatabaseEngine): IDatabaseDriver {
    const registration = this.registrations.get(engine);
    if (!registration) {
      throw new Error(`Database engine ${engine} is not registered.`);
    }
    return registration.create();
  }

  get(engine: DatabaseEngine): IDatabaseDriver {
    const existing = this.drivers.get(engine);
    if (existing) return existing;
    const driver = this.create(engine);
    this.drivers.set(engine, driver);
    return driver;
  }

  listCapabilities(): DatabaseCapabilities[] {
    return Array.from(this.registrations.values(), (registration) => ({ ...registration.capabilities }));
  }
}

export function createDefaultDatabaseDriverRegistry(): DatabaseDriverRegistry {
  return new DatabaseDriverRegistry([
    {
      engine: 'postgres',
      capabilities: {
        engine: 'postgres',
        supportsTransactions: true,
        supportsExplain: true,
        supportsSchemas: true,
      },
      create: () => new PostgresDriver(),
    },
  ]);
}
