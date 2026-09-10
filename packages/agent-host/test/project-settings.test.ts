import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectSettingsStore, ProjectSettingsValidationError } from '../src/project-settings.js';

const directories: string[] = [];
async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-project-settings-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('ProjectSettingsStore', () => {
  it('loads only version and MCP defaults when project settings are absent', async () => {
    const projectDirectory = await temporaryProject();
    const snapshot = await new ProjectSettingsStore(projectDirectory).load();
    expect(snapshot.settings).toEqual({ version: 1, mcp: { servers: {} } });
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
  });

  it.each([
    ['llm', { version: 1, llm: { connections: [] } }, '/llm'],
    ['modules', { version: 1, modules: {} }, '/modules'],
  ])('rejects legacy %s with an actionable migration diagnostic', async (
    _field: string,
    settings: Record<string, unknown>,
    path: string,
  ) => {
    const store = new ProjectSettingsStore(await temporaryProject());
    expect(store.validate(settings).some((diagnostic) =>
      diagnostic.code === 'legacy_project_setting' &&
      diagnostic.path === path &&
      /remove|moved/i.test(diagnostic.message),
    )).toBe(true);
    await expect(store.replace(settings as never)).rejects.toBeInstanceOf(ProjectSettingsValidationError);
  });

  it('accepts string and reference MCP values with structural validation', async () => {
    const store = new ProjectSettingsStore(await temporaryProject());
    const plaintext: Parameters<typeof store.replace>[0] = {
      version: 1,
      mcp: {
        servers: {
          local: {
            transport: 'stdio', command: 'node',
            env: { API_KEY: 'sk-project-secret-value' },
          },
          remote: {
            transport: 'streamable-http', url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer project-secret-token' },
          },
        },
      },
    };
    expect(store.validate(plaintext)).toEqual([]);
    await expect(store.replace(plaintext)).resolves.toMatchObject({
      settings: { mcp: { servers: { remote: { headers: { Authorization: 'Bearer project-secret-token' } } } } },
    });

    await expect(store.replace({
      version: 1,
      mcp: {
        servers: {
          local: {
            transport: 'stdio', command: 'node',
            env: { NODE_ENV: 'test', API_KEY: { ref: 'mcp:local:env:API_KEY' } },
          },
          remote: {
            transport: 'streamable-http', url: 'https://mcp.example.test',
            headers: { Authorization: { ref: 'mcp:remote:header:authorization' } },
          },
        },
      },
    })).resolves.toMatchObject({ exists: true });
  });

  it('persists MCP server declarations and retains atomic backups', async () => {
    const store = new ProjectSettingsStore(await temporaryProject());
    await store.replace({ version: 1, mcp: { servers: { first: { transport: 'stdio', command: 'node' } } } });
    await store.replaceMcpServers({ second: { transport: 'streamable-http', url: 'https://mcp.example.test' } });
    expect((await store.load()).settings.mcp?.servers).toHaveProperty('second');
    expect(JSON.parse(await readFile(store.settingsPath, 'utf8'))).toMatchObject({ version: 1 });
    expect(await readdir(join(store.projectDirectory, '.schemanaut'))).toContain('settings.json.bak');
  });

  it('recovers a malformed project file from its most recent valid backup', async () => {
    const store = new ProjectSettingsStore(await temporaryProject());
    await store.replace({ version: 1, mcp: { servers: {} } });
    await store.replace({ version: 1, mcp: { servers: { ok: { transport: 'stdio', command: 'node' } } } });
    await writeFile(store.settingsPath, '{broken', 'utf8');
    const snapshot = await store.load();
    expect(snapshot.recoveredFromBackup).toBe(true);
    expect(snapshot.settings.mcp?.servers).toEqual({});
  });
});
