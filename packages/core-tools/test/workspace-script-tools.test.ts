import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { WorkspaceCore } from '@dbagent/core-workspace';
import {
  registerWorkspaceScriptTools,
  runWorkspacePythonScript,
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
      runner: (request) => runWorkspacePythonScript({ ...request, pythonPath: python }),
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

  it('returns stderr tail and a structured result when a Python script exits nonzero', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/fail.py',
      [
        'import sys',
        'print("准备处理订单")',
        'print("字段 amount_missing 不存在", file=sys.stderr)',
        'raise SystemExit(2)',
        '',
      ].join('\n'),
    );

    await expect(
      runWorkspacePythonScript({
        rootPath,
        relativePath: 'scripts/fail.py',
        args: {},
        pythonPath: python,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Python 脚本执行失败，退出码 2'),
      result: {
        exitCode: 2,
        stdout: '准备处理订单\n',
        stderr: expect.stringContaining('字段 amount_missing 不存在'),
      },
    });
  });

  it('archives successful Python script stdout, stderr, manifest, and workspace history', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/archive_success.py',
      [
        'import json',
        'import sys',
        'payload = json.loads(sys.argv[1])',
        'print(f"region={payload[\'region\']}")',
        'print("warning: sampled result", file=sys.stderr)',
        '',
      ].join('\n'),
    );

    const result = await runWorkspacePythonScript({
      rootPath,
      relativePath: 'scripts/archive_success.py',
      args: { region: '华东', secret: 'do-not-log' },
      pythonPath: python,
      runId: 'run_success',
      now: () => '2026-06-23T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      exitCode: 0,
      runId: 'run_success',
      stdoutRelativePath: 'scripts/_runs/run_success/stdout.log',
      stderrRelativePath: 'scripts/_runs/run_success/stderr.log',
      resultRelativePath: 'scripts/_runs/run_success/result.json',
      historyRelativePath: '.dbagent/history.jsonl',
    });
    await expect(readFile(join(rootPath, 'scripts/_runs/run_success/stdout.log'), 'utf8')).resolves.toBe('region=华东\n');
    await expect(readFile(join(rootPath, 'scripts/_runs/run_success/stderr.log'), 'utf8')).resolves.toBe(
      'warning: sampled result\n',
    );
    const manifest = JSON.parse(await readFile(join(rootPath, 'scripts/_runs/run_success/result.json'), 'utf8')) as {
      script: string;
      stdoutPath: string;
      stderrPath: string;
    };
    expect(manifest).toMatchObject({
      script: 'scripts/archive_success.py',
      stdoutPath: 'scripts/_runs/run_success/stdout.log',
      stderrPath: 'scripts/_runs/run_success/stderr.log',
    });
    const history = await readFile(join(rootPath, '.dbagent/history.jsonl'), 'utf8');
    expect(history).toContain('"action":"run_script"');
    expect(history).toContain('"path":"scripts/archive_success.py"');
    expect(history).toContain('"exit_code":0');
    expect(history).not.toContain('do-not-log');
  });

  it('archives failed Python script output before returning the execution error', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/archive_failure.py',
      ['import sys', 'print("partial stdout")', 'print("failure detail", file=sys.stderr)', 'raise SystemExit(7)', ''].join('\n'),
    );

    await expect(
      runWorkspacePythonScript({
        rootPath,
        relativePath: 'scripts/archive_failure.py',
        args: {},
        pythonPath: python,
        runId: 'run_failure',
      }),
    ).rejects.toMatchObject({
      result: {
        exitCode: 7,
        runId: 'run_failure',
        stdoutRelativePath: 'scripts/_runs/run_failure/stdout.log',
        stderrRelativePath: 'scripts/_runs/run_failure/stderr.log',
      },
    });
    await expect(readFile(join(rootPath, 'scripts/_runs/run_failure/stdout.log'), 'utf8')).resolves.toBe(
      'partial stdout\n',
    );
    await expect(readFile(join(rootPath, 'scripts/_runs/run_failure/stderr.log'), 'utf8')).resolves.toBe(
      'failure detail\n',
    );
    const history = await readFile(join(rootPath, '.dbagent/history.jsonl'), 'utf8');
    expect(history).toContain('"exit_code":7');
  });

  it('kills a Python script that exceeds its timeout', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/slow.py',
      ['import time', 'print("started", flush=True)', 'time.sleep(5)', ''].join('\n'),
    );

    await expect(
      runWorkspacePythonScript({
        rootPath,
        relativePath: 'scripts/slow.py',
        args: {},
        pythonPath: python,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({
      message: 'Python 脚本执行超时（50ms）。',
      result: {
        timedOut: true,
        timeoutMs: 50,
        stdout: 'started\n',
      },
    });
  });

  it('cancels a running Python script through AbortSignal', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/cancel.py',
      ['import time', 'print("waiting", flush=True)', 'time.sleep(5)', ''].join('\n'),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      runWorkspacePythonScript({
        rootPath,
        relativePath: 'scripts/cancel.py',
        args: {},
        pythonPath: python,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      message: 'Python 脚本执行已取消。',
      result: {
        aborted: true,
        stdout: 'waiting\n',
      },
    });
  });

  it('captures only the tail of very large stdout to protect Agent context', async () => {
    const python = await availablePython();
    if (!python) return;
    const { rootPath } = await scriptWorkspace();
    const workspace = new WorkspaceCore();
    await workspace.writeFile(
      rootPath,
      'scripts/noisy.py',
      ['print("x" * 200)', ''].join('\n'),
    );

    await expect(
      runWorkspacePythonScript({
        rootPath,
        relativePath: 'scripts/noisy.py',
        args: {},
        pythonPath: python,
        outputLimitBytes: 20,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      stdout: expect.stringContaining('[output truncated to last 20 bytes]'),
    });
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
