import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { WorkspaceCore } from '@dbagent/core-workspace';
import {
  registerWorkspaceScriptTools,
  type WorkspaceScriptRunRequest,
  type WorkspaceScriptRunner,
} from '../src/workspace-script-tools.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('workspace Python script Agent tools', () => {
  it('discovers a declared Python script and executes it through an injected real process runner', async () => {
    const python = await availablePython();
    if (!python) return;
    const { registry, rootPath } = await scriptWorkspace();

    const tools = await registerWorkspaceScriptTools({
      registry,
      workspace: new WorkspaceCore(),
      getWorkspaceRoot: () => rootPath,
      runner: pythonRunner(python),
      timeoutMs: 10_000,
    });

    expect(tools).toMatchObject([
      {
        name: 'workspace_script:summarize_orders',
        relativePath: 'scripts/summarize_orders.py',
        params: [
          { name: 'count', type: 'int', description: '订单数量' },
          { name: 'region', type: 'str', description: '区域' },
        ],
      },
    ]);
    const tool = registry.get('workspace_script:summarize_orders');
    expect(tool).toMatchObject({
      dangerLevel: 'medium',
      readonly: false,
    });

    await expect(tool?.handler({ count: 42, region: '华东' }, context())).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'region=华东 count=42\n',
    });
  });

  it('validates declared script tool arguments before launching the runner', async () => {
    const { registry, rootPath } = await scriptWorkspace();
    let launched = false;
    await registerWorkspaceScriptTools({
      registry,
      workspace: new WorkspaceCore(),
      getWorkspaceRoot: () => rootPath,
      runner: async () => {
        launched = true;
        return { exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 };
      },
    });

    await expect(
      registry.get('workspace_script:summarize_orders')?.handler({ count: '42', region: '华东' }, context()),
    ).rejects.toThrow('Tool argument "count" must be an integer.');
    expect(launched).toBe(false);
  });

  it('requires an active workspace before discovering script tools', async () => {
    await expect(
      registerWorkspaceScriptTools({
        registry: new ToolRegistry(),
        workspace: new WorkspaceCore(),
        getWorkspaceRoot: () => undefined,
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }),
      }),
    ).rejects.toThrow('No active workspace.');
  });
});

async function scriptWorkspace(): Promise<{ registry: ToolRegistry; rootPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-workspace-script-tools-'));
  tempDirs.push(rootPath);
  const workspace = new WorkspaceCore();
  await workspace.create({
    name: '脚本工具项目',
    rootPath,
  });
  await workspace.writeFile(
    rootPath,
    'scripts/summarize_orders.py',
    [
      '"""',
      'DBAgent Tool: summarize_orders',
      '汇总订单数量。',
      '@param count: int 订单数量',
      '@param region: str 区域',
      '"""',
      'import json',
      'import sys',
      'payload = json.loads(sys.argv[1])',
      'print(f"region={payload[\'region\']} count={payload[\'count\']}")',
      '',
    ].join('\n'),
  );
  return {
    registry: new ToolRegistry(),
    rootPath,
  };
}

function pythonRunner(python: string): WorkspaceScriptRunner {
  return async (request: WorkspaceScriptRunRequest) => {
    const startedAt = Date.now();
    const output = await execFileAsync(
      python,
      [resolve(request.rootPath, request.relativePath), JSON.stringify(request.args)],
      {
        cwd: request.rootPath,
        timeout: request.timeoutMs ?? 30_000,
      },
    );
    return {
      command: `${python} ${request.relativePath}`,
      cwd: request.rootPath,
      exitCode: 0,
      stdout: output.stdout,
      stderr: output.stderr,
      elapsedMs: Date.now() - startedAt,
    };
  };
}

async function availablePython(): Promise<string | undefined> {
  for (const candidate of ['python', 'python3']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5_000 });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function context() {
  return {
    session: {
      id: 'session_workspace_script_tools',
      title: 'workspace script tools',
      mode: 'full-auto' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
