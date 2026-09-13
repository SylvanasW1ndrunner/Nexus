import { describe, expect, it } from 'vitest';
import { createDatabaseTestHost } from './database-host-fixture.js';

describe('database Capability host boundary', () => {
  it('injects the database Capability as a normal module without a public database facade', async () => {
    const host = createDatabaseTestHost();
    try {
      expect(host.agent.status().capabilities.modules).toEqual(expect.arrayContaining([
        expect.objectContaining({ moduleId: 'schemanaut.database', instanceId: 'primary' }),
      ]));
      expect('database' in host.agent).toBe(false);
    } finally {
      await host.close();
    }
  });
});
