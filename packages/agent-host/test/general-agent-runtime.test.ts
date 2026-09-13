import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('generic Agent runtime composition', () => {
  it('does not load a professional database Capability by default', async () => {
    const projectDirectory = await project();
    const runtime = new AgentRuntime({ projectDirectory, stateDatabasePath: join(projectDirectory, '.schemanaut', 'state.db') });
    try {
      await runtime.ready();
      expect(runtime.status().capabilities.modules).toEqual([]);
      expect(runtime.listAgentTools().some(({ source }) => source === 'database')).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('loads the 14 base Tools in order and reaps orphaned materializations before ready', async () => {
    const projectDirectory = await project();
    const materializedRoot = join(projectDirectory, '.schemanaut', 'runtime', 'materialized');
    const orphan = join(materializedRoot, 'run-11111111-1111-4111-8111-111111111111');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'partial.bin'), 'orphan', 'utf8');
    const runtime = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: join(projectDirectory, '.schemanaut', 'state.db'),
    });
    try {
      await runtime.ready();
      expect(runtime.listAgentTools().slice(0, 14).map(({ name }) => name)).toEqual([
        'ask_user', 'tool_search', 'result_read', 'result_materialize', 'result_save', 'skill',
        'workspace_list', 'workspace_read', 'workspace_search', 'workspace_apply_patch',
        'process_exec', 'process_control', 'web_search', 'web_fetch',
      ]);
      await expect(readdir(materializedRoot)).resolves.toEqual([]);
    } finally {
      await runtime.close();
    }
  });
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-generic-host-'));
  directories.push(directory);
  return directory;
}
