import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../src/connection-store.js';

const tempDirs: string[] = [];

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-connections-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'connections.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ConnectionStore', () => {
  it('creates a read-only PostgreSQL connection without persisting password', async () => {
    const store = new ConnectionStore(await storePath());

    const connection = await store.create({
      name: 'Analytics warehouse',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'analytics',
      username: 'analyst',
      password: 'secret',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 8000,
      statementTimeoutMs: 45000,
    });

    expect(connection).toMatchObject({
      name: 'Analytics warehouse',
      engine: 'postgres',
      database: 'analytics',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 8000,
      statementTimeoutMs: 45000,
      status: 'disconnected',
    });
    expect(JSON.stringify(await store.list())).not.toContain('secret');
  });

  it('updates connection metadata and preserves identity', async () => {
    const store = new ConnectionStore(await storePath());
    const created = await store.create({
      name: 'Local',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
    });

    const updated = await store.update(created.id, {
      name: 'Local readonly',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 12000,
      statementTimeoutMs: 90000,
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: 'Local readonly',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 12000,
      statementTimeoutMs: 90000,
    });
  });

  it('marks connection status for UI state restoration', async () => {
    const store = new ConnectionStore(await storePath());
    const created = await store.create({
      name: 'Ops',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'ops',
      username: 'postgres',
    });

    await expect(store.markStatus(created.id, 'connected')).resolves.toMatchObject({
      id: created.id,
      status: 'connected',
    });
  });

  it('treats corrupt connection metadata as empty so the app can start', async () => {
    const filePath = await storePath();
    const store = new ConnectionStore(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');

    await expect(store.list()).resolves.toEqual([]);
  });
});
