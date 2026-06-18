import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpConfigStore,
  defaultBuiltinMcpServers,
  normalizeConfigFile,
  normalizeServerInput,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('McpConfigStore', () => {
  it('loads built-in MCP defaults for a fresh user profile without writing secrets', async () => {
    const store = new McpConfigStore(await configPath(), {
      now: () => '2026-06-18T10:00:00.000Z',
    });

    const config = await store.load();

    expect(config.version).toBe(1);
    expect(config.servers.map((server) => server.id)).toEqual(['builtin-fetch', 'builtin-memory', 'builtin-time']);
    expect(config.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin-memory',
          source: 'builtin',
          transport: 'stdio',
          command: 'npx',
          autoStart: false,
          enabled: true,
        }),
      ]),
    );
    expect(config.servers.find((server) => server.id === 'builtin-memory')?.env).toBeUndefined();
    expect(defaultBuiltinMcpServers).toHaveLength(3);
  });

  it('persists user stdio MCP servers atomically and preserves keychain refs', async () => {
    const path = await configPath();
    const store = new McpConfigStore(path, {
      includeBuiltinDefaults: false,
      now: () => '2026-06-18T10:00:00.000Z',
      createId: () => 'company-tools',
    });

    const server = await store.upsert({
      name: 'Company Tools',
      source: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['-m', 'company_mcp.server'],
      env: {
        ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' },
        LOG_LEVEL: 'info',
      },
      autoStart: true,
    });

    expect(server).toMatchObject({
      id: 'company-tools',
      name: 'Company Tools',
      transport: 'stdio',
      command: 'python',
      args: ['-m', 'company_mcp.server'],
      autoStart: true,
      enabled: true,
      env: {
        ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' },
        LOG_LEVEL: 'info',
      },
    });
    await expect(readFile(path, 'utf8')).resolves.toContain('"company-tools"');
    await expect(new McpConfigStore(path, { includeBuiltinDefaults: false }).list()).resolves.toMatchObject([
      { id: 'company-tools', env: { ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' } } },
    ]);
  });

  it('rejects sensitive env values unless they are stored as keychain refs', async () => {
    const store = new McpConfigStore(await configPath(), { includeBuiltinDefaults: false });

    await expect(
      store.upsert({
        id: 'bad',
        name: 'Bad Server',
        command: 'node',
        env: {
          API_KEY: 'plain-secret-value',
        },
      }),
    ).rejects.toThrow('must be stored as a keychain ref');

    await expect(
      store.upsert({
        id: 'also-bad',
        name: 'Also Bad',
        command: 'node',
        env: {
          SAFE_NAME: ['sk', 'secretsecretsecret'].join('-'),
        },
      }),
    ).rejects.toThrow('must be stored as a keychain ref');
  });

  it('validates stdio commands and remote MCP URLs', () => {
    expect(() =>
      normalizeServerInput(
        {
          id: 'missing-command',
          name: 'Missing Command',
          transport: 'stdio',
        },
        '2026-06-18T10:00:00.000Z',
        'fallback',
      ),
    ).toThrow('requires a command');

    const remote = normalizeServerInput(
      {
        id: 'remote',
        name: 'Remote MCP',
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
      },
      '2026-06-18T10:00:00.000Z',
      'fallback',
    );
    expect(remote).toMatchObject({
      id: 'remote',
      url: 'https://mcp.example.com/sse',
    });
    expect(remote.command).toBeUndefined();
    expect(remote.args).toBeUndefined();

    expect(() =>
      normalizeServerInput(
        {
          id: 'remote',
          name: 'Remote MCP',
          transport: 'sse',
          url: 'file:///tmp/socket',
        },
        '2026-06-18T10:00:00.000Z',
        'fallback',
      ),
    ).toThrow('URL must use http or https');
  });

  it('recovers from missing or corrupt mcp.json so the app can still start', async () => {
    const path = await configPath();
    await writeFile(path, '{not-json', 'utf8');

    const store = new McpConfigStore(path, { includeBuiltinDefaults: false });

    await expect(store.load()).resolves.toEqual({ version: 1, servers: [] });
  });

  it('enables, disables and toggles autoStart without changing unrelated servers', async () => {
    const store = new McpConfigStore(await configPath(), {
      includeBuiltinDefaults: false,
      now: () => '2026-06-18T10:00:00.000Z',
    });

    await store.upsert({ id: 'a', name: 'A', command: 'node', enabled: true, autoStart: false });
    await store.upsert({ id: 'b', name: 'B', command: 'node', enabled: true, autoStart: false });

    await expect(store.setEnabled('a', false)).resolves.toMatchObject({ id: 'a', enabled: false });
    await expect(store.setAutoStart('b', true)).resolves.toMatchObject({ id: 'b', autoStart: true });
    await expect(store.list()).resolves.toMatchObject([
      { id: 'a', enabled: false, autoStart: false },
      { id: 'b', enabled: true, autoStart: true },
    ]);
  });

  it('removes a server and only returns secret refs when explicitly requested', async () => {
    const store = new McpConfigStore(await configPath(), { includeBuiltinDefaults: false });

    await store.upsert({
      id: 'company-tools',
      name: 'Company Tools',
      command: 'python',
      env: {
        ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' },
      },
    });

    await expect(store.remove('company-tools')).resolves.toMatchObject({
      removed: true,
      secretRefs: [],
    });

    await store.upsert({
      id: 'company-tools',
      name: 'Company Tools',
      command: 'python',
      env: {
        ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' },
      },
    });
    await expect(store.remove('company-tools', { deleteSecrets: true })).resolves.toMatchObject({
      removed: true,
      secretRefs: ['mcp:company-tools:env:ENCRYPT_KEY'],
    });
    await expect(store.list()).resolves.toEqual([]);
  });

  it('rejects duplicate ids in existing config instead of silently choosing one', () => {
    expect(() =>
      normalizeConfigFile({
        version: 1,
        servers: [
          { id: 'dup', name: 'One', source: 'user', transport: 'stdio', command: 'node', autoStart: false, enabled: true, installedAt: '2026-06-18T10:00:00.000Z', updatedAt: '2026-06-18T10:00:00.000Z' },
          { id: 'dup', name: 'Two', source: 'user', transport: 'stdio', command: 'node', autoStart: false, enabled: true, installedAt: '2026-06-18T10:00:00.000Z', updatedAt: '2026-06-18T10:00:00.000Z' },
        ],
      }),
    ).toThrow('duplicate server id dup');
  });
});

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-config-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}
