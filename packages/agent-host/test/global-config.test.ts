import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigStore, GlobalConfigValidationError } from '../src/global-config.js';

const directories: string[] = [];

async function temporaryConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-global-config-'));
  directories.push(directory);
  return join(directory, 'config.toml');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('GlobalConfigStore', () => {
  it('loads a missing file as immutable safe defaults', async () => {
    const path = await temporaryConfig();
    const snapshot = await new GlobalConfigStore({ path }).load();

    expect(snapshot).toMatchObject({
      path,
      exists: false,
      settings: {
        version: 1,
        models: { connections: [], parameters: {} },
        agent: { permission_mode: 'default' },
        permissions: { rules: [] },
      },
    });
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
  });

  it('resolves only environment referenced model credentials without exposing them in snapshots', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nname = "work"\nendpoint = "https://relay.example/v1"\napi_key_env = "WORK_KEY"\n`,
      'utf8',
    );
    const store = new GlobalConfigStore({ path });
    const snapshot = await store.load();

    expect(snapshot.settings.models.connections[0]).toMatchObject({ api_key_env: 'WORK_KEY' });
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    expect(store.resolveModelConnections({ WORK_KEY: 'fixture-secret' })[0]).toMatchObject({
      name: 'work',
      endpoint: 'https://relay.example/v1',
      apiKey: 'fixture-secret',
    });
    expect(() => store.resolveModelConnections({})).toThrow(/WORK_KEY/);
  });

  it('resolves model credentials from the supplied immutable snapshot', async () => {
    const path = await temporaryConfig();
    const store = new GlobalConfigStore({ path });
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nendpoint = "https://first.example/v1"\napi_key_env = "FIRST_KEY"\n`,
      'utf8',
    );
    const first = await store.load();
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nendpoint = "https://second.example/v1"\napi_key_env = "SECOND_KEY"\n`,
      'utf8',
    );
    await store.load();

    expect(store.resolveModelConnections({ FIRST_KEY: 'first-secret' }, undefined, first))
      .toMatchObject([{ endpoint: 'https://first.example/v1', apiKey: 'first-secret' }]);
  });

  it('normalizes omitted sections and resolves host-owned secure references without persisting values', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nendpoint = "https://relay.example/v1"\napi_key_ref = "vault:model-key"\nheaders = { Authorization = { ref = "vault:auth-header" } }\n`,
      'utf8',
    );
    const store = new GlobalConfigStore({ path });
    const snapshot = await store.load();

    expect(snapshot.settings).toMatchObject({
      agent: { permission_mode: 'default' },
      permissions: { rules: [] },
      models: { parameters: {} },
    });
    const resolved = store.resolveModelConnections(
      {},
      (reference) =>
        ({
          'vault:model-key': 'model-secret',
          'vault:auth-header': 'Bearer header-secret',
        })[reference],
    );
    expect(resolved[0]).toMatchObject({
      apiKey: 'model-secret',
      headers: { Authorization: 'Bearer header-secret' },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/model-secret|header-secret/u);
  });

  it('rejects ambiguous API key references', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nendpoint = "https://relay.example/v1"\napi_key_env = "MODEL_KEY"\napi_key_ref = "vault:model-key"\n`,
      'utf8',
    );
    await expect(new GlobalConfigStore({ path }).load()).rejects.toBeInstanceOf(
      GlobalConfigValidationError,
    );
  });

  it('accepts and resolves a plaintext api_key alongside the supported env and ref forms', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[models.connections]]\nendpoint = "https://relay.example/v1"\napi_key = "do-not-store"\n`,
      'utf8',
    );

    const store = new GlobalConfigStore({ path });
    const snapshot = await store.load();
    expect(snapshot.settings.models.connections[0]).toMatchObject({ api_key: 'do-not-store' });
    expect(store.resolveModelConnections()[0]).toMatchObject({ apiKey: 'do-not-store' });
  });

  it('accepts constrained enterprise rules and keeps header references structural', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[agent]\npermission_mode = "full-access"\n\n[[permissions.rules]]\nid = "protect-prod"\ndecision = "deny"\ntools = ["database.execute"]\nactions = ["delete"]\nhosts = ["prod.example.test"]\n\n[[models.connections]]\nendpoint = "https://relay.example/v1"\nheaders = { Authorization = { env = "RELAY_AUTH" } }\n`,
      'utf8',
    );
    const snapshot = await new GlobalConfigStore({ path }).load();
    expect(snapshot.settings).toMatchObject({
      agent: { permission_mode: 'full-access' },
      permissions: { rules: [{ decision: 'deny' }] },
    });

  });

  it('rejects duplicate enterprise rule identities', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[permissions.rules]]\nid = "protect-prod"\ndecision = "ask"\n\n[[permissions.rules]]\nid = "protect-prod"\ndecision = "deny"\n`,
      'utf8',
    );
    const failure = await new GlobalConfigStore({ path }).load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GlobalConfigValidationError);
    if (!(failure instanceof GlobalConfigValidationError)) throw new Error('Expected config validation failure.');
    expect(failure.diagnostics.some((diagnostic) =>
      diagnostic.path === '/permissions/rules/1/id' && /unique/i.test(diagnostic.message),
    )).toBe(true);
  });

  it('rejects explicitly empty enterprise selectors', async () => {
    const path = await temporaryConfig();
    await writeFile(
      path,
      `version = 1\n\n[[permissions.rules]]\nid = "empty-selector"\ndecision = "deny"\ntools = []\n`,
      'utf8',
    );
    await expect(new GlobalConfigStore({ path }).load()).rejects.toBeInstanceOf(
      GlobalConfigValidationError,
    );
  });

  it('reconciles an edit made before subscription and recovers after an invalid edit', async () => {
    const path = await temporaryConfig();
    const store = new GlobalConfigStore({ path });
    const initial = await store.load();
    await writeFile(path, 'version = 1\n\n[agent]\npermission_mode = "auto"\n', 'utf8');

    const deliveries: string[] = [];
    const errors: Error[] = [];
    const stop = await store.watch(
      (snapshot) => {
        deliveries.push(snapshot.settings.agent.permission_mode);
      },
      { initialSnapshot: initial, onError: (error) => { errors.push(error); } },
    );
    expect(deliveries).toEqual(['auto']);

    await writeFile(path, 'version = 1\n\n[agent]\npermission_mode = "invalid"\n', 'utf8');
    await waitUntil(() => errors.length === 1);
    expect(deliveries).toEqual(['auto']);

    await writeFile(
      path,
      'version = 1\n\n[agent]\npermission_mode = "full-access"\n',
      'utf8',
    );
    await waitUntil(() => deliveries.includes('full-access'));
    stop();
    expect(deliveries).toEqual(['auto', 'full-access']);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for config watcher.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
