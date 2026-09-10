import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpConfigStore, normalizeConfigFile, normalizeServerInput } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('McpConfigStore', () => {
  it('starts with no implicit third-party MCP servers for a fresh project', async () => {
    const store = new McpConfigStore(await configPath(), {
      now: () => '2026-06-18T10:00:00.000Z',
    });

    const config = await store.load();

    expect(config.version).toBe(1);
    expect(config.servers).toEqual([]);
  });

  it('keeps autoStart off unless the user explicitly enables it', async () => {
    const store = new McpConfigStore(await configPath());

    const server = await store.upsert({
      id: 'manual-by-default',
      name: 'Manual by default',
      command: 'node',
    });

    expect(server.autoStart).toBe(false);
    await expect(store.list()).resolves.toMatchObject([
      { id: 'manual-by-default', autoStart: false },
    ]);
  });

  it('persists user stdio MCP servers atomically and preserves keychain refs', async () => {
    const path = await configPath();
    const store = new McpConfigStore(path, {
      now: () => '2026-06-18T10:00:00.000Z',
      createId: () => 'company-tools',
    });

    const server = await store.upsert({
      name: 'Company Tools',
      source: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['-m', 'company_mcp.server'],
      cwd: 'C:\\workspace\\company-tools',
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
      command: 'node',
      args: ['-m', 'company_mcp.server'],
      cwd: 'C:\\workspace\\company-tools',
      autoStart: true,
      enabled: true,
      env: {
        ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' },
        LOG_LEVEL: 'info',
      },
    });
    await expect(readFile(path, 'utf8')).resolves.toContain('"company-tools"');
    await expect(new McpConfigStore(path).list()).resolves.toMatchObject([
      { id: 'company-tools', env: { ENCRYPT_KEY: { ref: 'mcp:company-tools:env:ENCRYPT_KEY' } } },
    ]);
  });

  it('round-trips string and reference MCP environment values without content inference', async () => {
    const store = new McpConfigStore(await configPath());
    const server = await store.upsert({
      id: 'literal-env',
      name: 'Literal environment',
      command: 'node',
      env: {
        API_KEY: 'fixture-value',
        DATABASE_URL: 'postgresql://app:pass@db.example.test/example',
        REFERENCE: { ref: 'mcp:literal-env:reference' },
      },
    });
    expect(server.env).toEqual({
      API_KEY: 'fixture-value',
      DATABASE_URL: 'postgresql://app:pass@db.example.test/example',
      REFERENCE: { ref: 'mcp:literal-env:reference' },
    });
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ env: server.env })]);
  });

  it('retains literal stdio commands and arguments', async () => {
    const store = new McpConfigStore(await configPath());
    await expect(store.upsert({
      id: 'literal-args',
      name: 'Literal arguments',
      command: 'node --token=fixture',
      args: ['server.mjs', 'postgresql://app:pass@db.example.test/example', '--password=fixture'],
    })).resolves.toMatchObject({
      command: 'node --token=fixture',
      args: ['server.mjs', 'postgresql://app:pass@db.example.test/example', '--password=fixture'],
    });
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
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          Authorization: { ref: 'mcp:remote:header:authorization' },
          'X-Client-Version': '1',
        },
      },
      '2026-06-18T10:00:00.000Z',
      'fallback',
    );
    expect(remote).toMatchObject({
      id: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: { ref: 'mcp:remote:header:authorization' },
        'X-Client-Version': '1',
      },
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

  it('accepts literal remote headers and still validates header syntax', () => {
    expect(normalizeServerInput(
        {
          id: 'plaintext-auth',
          name: 'Plaintext Auth',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer fixture-value' },
        },
        '2026-07-25T10:00:00.000Z',
        'fallback',
      )).toMatchObject({ headers: { Authorization: 'Bearer fixture-value' } });

    expect(() =>
      normalizeServerInput(
        {
          id: 'invalid-header',
          name: 'Invalid Header',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { 'Bad Header': 'value' },
        },
        '2026-07-25T10:00:00.000Z',
        'fallback',
      ),
    ).toThrow('Invalid MCP HTTP header name');
  });

  it('retains remote URL userinfo and query strings while preserving transport policy', () => {
    const normalizeRemote = (url: string) =>
      normalizeServerInput(
        {
          id: 'remote',
          name: 'Remote MCP',
          transport: 'streamable-http',
          url,
        },
        '2026-07-25T10:00:00.000Z',
        'fallback',
      );

    expect(normalizeRemote('https://user:password@mcp.example.com/mcp').url).toBe('https://user:password@mcp.example.com/mcp');
    expect(normalizeRemote('https://mcp.example.com/mcp?access_token=plaintext').url).toBe('https://mcp.example.com/mcp?access_token=plaintext');
    expect(normalizeRemote('https://mcp.example.com/mcp?dsn=postgresql%3A%2F%2Fapp%3Apassword%40db.example.com%2Fapp').url)
      .toBe('https://mcp.example.com/mcp?dsn=postgresql%3A%2F%2Fapp%3Apassword%40db.example.com%2Fapp');
    expect(() => normalizeRemote('http://mcp.example.com/mcp')).toThrow(
      'must use HTTPS unless it targets loopback',
    );
    expect(normalizeRemote('http://localhost:3000/mcp').url).toBe('http://localhost:3000/mcp');
    expect(normalizeRemote('http://127.42.0.1:3000/mcp').url).toBe('http://127.42.0.1:3000/mcp');
    expect(normalizeRemote('http://[::1]:3000/mcp').url).toBe('http://[::1]:3000/mcp');
  });

  it('serializes concurrent mutations so no configured server is lost', async () => {
    const path = await configPath();
    const firstStore = new McpConfigStore(path);
    const secondStore = new McpConfigStore(path);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? firstStore : secondStore).upsert({
          id: `server-${index.toString().padStart(2, '0')}`,
          name: `Server ${index}`,
          command: 'node',
        }),
      ),
    );

    const servers = await new McpConfigStore(path).list();
    expect(servers).toHaveLength(40);
    expect(servers.map((server) => server.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `server-${index.toString().padStart(2, '0')}`),
    );
  });

  it('starts empty when mcp.json is missing', async () => {
    const store = new McpConfigStore(await configPath());

    await expect(store.load()).resolves.toEqual({ version: 1, servers: [] });
  });

  it('fails closed on corrupt mcp.json and never overwrites the damaged file', async () => {
    const path = await configPath();
    await writeFile(path, '{not-json', 'utf8');

    const store = new McpConfigStore(path);

    await expect(store.load()).rejects.toThrow('Invalid mcp.json');
    await expect(
      store.upsert({ id: 'replacement', name: 'Replacement', command: 'node' }),
    ).rejects.toThrow('Invalid mcp.json');
    await expect(readFile(path, 'utf8')).resolves.toBe('{not-json');
  });

  it('enables, disables and toggles autoStart without changing unrelated servers', async () => {
    const store = new McpConfigStore(await configPath(), {
      now: () => '2026-06-18T10:00:00.000Z',
    });

    await store.upsert({ id: 'a', name: 'A', command: 'node', enabled: true, autoStart: false });
    await store.upsert({ id: 'b', name: 'B', command: 'node', enabled: true, autoStart: false });

    await expect(store.setEnabled('a', false)).resolves.toMatchObject({ id: 'a', enabled: false });
    await expect(store.setAutoStart('b', true)).resolves.toMatchObject({
      id: 'b',
      autoStart: true,
    });
    await expect(store.list()).resolves.toMatchObject([
      { id: 'a', enabled: false, autoStart: false },
      { id: 'b', enabled: true, autoStart: true },
    ]);
  });

  it('removes a server and only returns secret refs when explicitly requested', async () => {
    const store = new McpConfigStore(await configPath());

    await store.upsert({
      id: 'company-tools',
      name: 'Company Tools',
      command: 'node',
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
      command: 'node',
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

  it('returns remote header secret refs only when secret deletion is explicitly requested', async () => {
    const store = new McpConfigStore(await configPath());
    await store.upsert({
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: { ref: 'mcp:remote:header:authorization' },
      },
    });

    await expect(store.remove('remote', { deleteSecrets: true })).resolves.toMatchObject({
      removed: true,
      secretRefs: ['mcp:remote:header:authorization'],
    });
  });

  it('rejects duplicate ids in existing config instead of silently choosing one', () => {
    expect(() =>
      normalizeConfigFile({
        version: 1,
        servers: [
          {
            id: 'dup',
            name: 'One',
            source: 'user',
            transport: 'stdio',
            command: 'node',
            autoStart: false,
            enabled: true,
            installedAt: '2026-06-18T10:00:00.000Z',
            updatedAt: '2026-06-18T10:00:00.000Z',
          },
          {
            id: 'dup',
            name: 'Two',
            source: 'user',
            transport: 'stdio',
            command: 'node',
            autoStart: false,
            enabled: true,
            installedAt: '2026-06-18T10:00:00.000Z',
            updatedAt: '2026-06-18T10:00:00.000Z',
          },
        ],
      }),
    ).toThrow('duplicate server id dup');
  });

  it('rejects unknown transports instead of silently launching them as stdio', () => {
    expect(() =>
      normalizeConfigFile({
        version: 1,
        servers: [
          {
            id: 'unknown-transport',
            name: 'Unknown transport',
            source: 'user',
            transport: 'websocket',
            command: 'node',
            autoStart: false,
            enabled: true,
            installedAt: '2026-06-18T10:00:00.000Z',
            updatedAt: '2026-06-18T10:00:00.000Z',
          },
        ],
      }),
    ).toThrow('Invalid MCP transport');
  });
});

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-config-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}
