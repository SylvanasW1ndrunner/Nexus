import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ToolRegistry, type AgentMode, type AgentToolContext } from '@dbagent/core-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installWorkspacePythonDependencies,
  registerPythonRuntimeTools,
  runPythonReplSnippet,
} from '../src/python-runtime-tools.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const REAL_PYTHON_TOOL_TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('python runtime tools', () => {
  it('registers high-risk official Python runtime tools', () => {
    const registry = new ToolRegistry();
    registerPythonRuntimeTools({ registry, getWorkspace: () => workspaceRuntime('C:/workspace') });

    expect(registry.get('run_python_script')).toMatchObject({
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.workspace-python',
    });
    expect(registry.get('python_repl')).toMatchObject({ dangerLevel: 'high', readonly: false });
    expect(registry.get('install_python_deps')).toMatchObject({ dangerLevel: 'high', readonly: false });
  });

  it('runs workspace Python scripts through the active workspace runtime', async () => {
    const python = await availablePython();
    if (!python) return;
    const rootPath = await testWorkspace();
    await writeFile(
      join(rootPath, 'scripts', 'analyze.py'),
      [
        'import json',
        'import sys',
        'payload = json.loads(sys.argv[1])',
        'print(f"orders={payload[\'orders\']}")',
        '',
      ].join('\n'),
      'utf8',
    );
    const registry = new ToolRegistry();
    registerPythonRuntimeTools({
      registry,
      getWorkspace: () => workspaceRuntime(rootPath, python),
    });

    const result = await registry.get('run_python_script')?.handler(
      { path: 'scripts/analyze.py', args: { orders: 42 } },
      context('ask', 'run_python_script'),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'orders=42\n',
      historyRelativePath: '.dbagent/history.jsonl',
    });
  }, REAL_PYTHON_TOOL_TEST_TIMEOUT_MS);

  it('runs Python REPL snippets and truncates large output through a real interpreter', async () => {
    const python = await availablePython();
    if (!python) return;
    const rootPath = await testWorkspace();

    const result = await runPythonReplSnippet({
      rootPath,
      pythonPath: python,
      code: 'print(6 * 7)',
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: '42\n' });

    const noisy = await runPythonReplSnippet({
      rootPath,
      pythonPath: python,
      code: 'print("x" * 4000)',
      outputLimitBytes: 80,
    });
    expect(noisy.stdout.length).toBeLessThanOrEqual(80);
    expect(noisy.stdoutTruncated).toBe(true);
  }, REAL_PYTHON_TOOL_TEST_TIMEOUT_MS);

  it('installs an empty requirements file and rejects pip option injection', async () => {
    const python = await availablePython();
    if (!python) return;
    await execFileAsync(python, ['-m', 'pip', '--version']);
    const rootPath = await testWorkspace();
    await writeFile(join(rootPath, 'scripts', 'requirements.txt'), '# intentionally empty\n', 'utf8');

    const result = await installWorkspacePythonDependencies({
      rootPath,
      pythonPath: python,
      requirementsPath: 'scripts/requirements.txt',
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.requirementsRelativePath).toBe('scripts/requirements.txt');
    expect(result.command).toContain('-m pip install');

    await expect(
      installWorkspacePythonDependencies({
        rootPath,
        pythonPath: python,
        packages: ['--index-url=https://example.invalid/simple'],
      }),
    ).rejects.toThrow('Invalid Python package spec');
  }, REAL_PYTHON_TOOL_TEST_TIMEOUT_MS);

  it('enforces approval and active workspace before launching Python', async () => {
    const registry = new ToolRegistry();
    registerPythonRuntimeTools({ registry, getWorkspace: () => undefined });

    await expect(
      registry.get('python_repl')?.handler({ code: 'print("blocked")' }, context('readonly', 'python_repl', true)),
    ).rejects.toThrow('readonly mode');
    await expect(
      registry.get('python_repl')?.handler({ code: 'print("blocked")' }, context('ask', 'python_repl')),
    ).rejects.toThrow('requires explicit approval');
    await expect(
      registry.get('python_repl')?.handler({ code: 'print("blocked")' }, context('ask', 'python_repl', true)),
    ).rejects.toThrow('active workspace');
  });

  it('aborts running Python snippets with AbortSignal', async () => {
    const python = await availablePython();
    if (!python) return;
    const rootPath = await testWorkspace();
    const controller = new AbortController();
    const run = runPythonReplSnippet({
      rootPath,
      pythonPath: python,
      code: 'import time; time.sleep(2)',
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, REAL_PYTHON_TOOL_TEST_TIMEOUT_MS);
});

async function availablePython(): Promise<string | undefined> {
  for (const candidate of ['python', 'python3']) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function testWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-python-runtime-tools-'));
  tempDirs.push(rootPath);
  await mkdir(join(rootPath, 'scripts'), { recursive: true });
  return rootPath;
}

function workspaceRuntime(rootPath: string, pythonPath = 'python') {
  return {
    rootPath,
    requirementsPath: 'scripts/requirements.txt',
    pythonPath,
    timeoutMs: 30_000,
  };
}

function context(mode: AgentMode, toolName: string, approved = false): AgentToolContext {
  return {
    session: {
      id: `session-${mode}`,
      title: 'Python Runtime Tool Test',
      mode,
      strategy: 'react',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
    ...(approved
      ? {
          approval: {
            granted: true,
            source: 'approval-provider',
            toolCallId: `tool-call-${toolName}`,
            toolName,
            approvedAt: '2026-07-09T00:00:00.000Z',
          },
        }
      : {}),
  };
}
