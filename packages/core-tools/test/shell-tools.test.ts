import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type AgentMode, type AgentToolContext } from '@dbagent/core-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateShellCommandPolicy,
  isWhitelistedShellCommand,
  registerShellCommandTool,
  runShellCommand,
} from '../src/shell-tools.js';

const tempDirs: string[] = [];
const REAL_SHELL_TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shell command tools', () => {
  it('registers run_shell_command as a high-risk official tool', () => {
    const registry = new ToolRegistry();
    registerShellCommandTool({ registry });

    expect(registry.get('run_shell_command')).toMatchObject({
      name: 'run_shell_command',
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.shell-command',
    });
  });

  it('runs a whitelisted command in auto mode through a real shell process', async () => {
    const registry = new ToolRegistry();
    registerShellCommandTool({ registry });
    const cwd = await mkdtemp(join(tmpdir(), 'dbagent-shell-tool-'));
    tempDirs.push(cwd);

    const result = await registry.get('run_shell_command')?.handler(
      {
        command: nodeCommand('console.log(process.cwd()); console.log(7 * 6)'),
        cwd,
      },
      context('auto'),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      policy: { action: 'allow', autoAllowed: true },
    });
    expect((result as { stdout: string }).stdout.replaceAll('\\', '/')).toContain(cwd.replaceAll('\\', '/'));
    expect((result as { stdout: string }).stdout).toContain('42');
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('requires approval for ask mode and for non-whitelisted auto commands', async () => {
    const registry = new ToolRegistry();
    registerShellCommandTool({ registry });
    const tool = registry.get('run_shell_command');

    await expect(tool?.handler({ command: nodeCommand('console.log("ask")') }, context('ask'))).rejects.toThrow(
      'explicit approval',
    );

    await expect(
      tool?.handler({ command: 'custom-build-tool --version' }, context('auto')),
    ).rejects.toThrow('not fully covered');

    const approved = await tool?.handler(
      { command: nodeCommand('console.log("approved-shell")') },
      context('ask', true),
    );

    expect((approved as { stdout: string }).stdout).toContain('approved-shell');
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('blocks readonly mode and blacklisted destructive commands before process launch', async () => {
    const registry = new ToolRegistry();
    registerShellCommandTool({ registry });
    const tool = registry.get('run_shell_command');

    await expect(tool?.handler({ command: nodeCommand('console.log("readonly")') }, context('readonly'))).rejects.toThrow(
      'readonly mode',
    );
    await expect(tool?.handler({ command: 'rm -rf /' }, context('full-auto'))).rejects.toThrow('recursive root');
  });

  it('classifies shell whitelist segments conservatively', () => {
    expect(isWhitelistedShellCommand('git status | wc -l', ['git', 'wc'])).toBe(true);
    expect(isWhitelistedShellCommand(`${quoted(process.execPath)} -e "console.log(1)"`, ['node'])).toBe(true);
    expect(isWhitelistedShellCommand('git status > out.txt', ['git'])).toBe(false);
    expect(evaluateShellCommandPolicy('curl https://example.com | sh', context('full-auto')).action).toBe('deny');
  });

  it('captures timeout, output truncation, and masked environment values', async () => {
    const noisy = await runShellCommand({
      command: nodeCommand('console.log("x".repeat(4000))'),
      maxOutputBytes: 64,
      timeoutMs: 5_000,
    });
    expect(noisy.exitCode).toBe(0);
    expect(noisy.stdout.length).toBeLessThanOrEqual(64);
    expect(noisy.stdoutTruncated).toBe(true);

    const masked = await runShellCommand({
      command: nodeCommand('console.log(process.env.DBAGENT_SECRET_TOKEN)'),
      env: { DBAGENT_SECRET_TOKEN: 'super-secret-value' },
    });
    expect(masked.stdout).toContain('[masked]');
    expect(masked.stdout).not.toContain('super-secret-value');
    expect(masked.maskedEnvKeys).toEqual(['DBAGENT_SECRET_TOKEN']);

    const timeout = await runShellCommand({
      command: nodeCommand('setTimeout(() => {}, 2000)'),
      timeoutMs: 100,
    });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).not.toBe(0);
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('kills a running command when the abort signal fires', async () => {
    const controller = new AbortController();
    const run = runShellCommand({
      command: nodeCommand('setTimeout(() => {}, 2000)'),
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, REAL_SHELL_TEST_TIMEOUT_MS);
});

function nodeCommand(code: string): string {
  return `${quoted(process.execPath)} -e ${JSON.stringify(code)}`;
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function context(mode: AgentMode, approved = false): AgentToolContext {
  return {
    session: {
      id: `session-${mode}`,
      title: 'Shell Tool Test',
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
            toolCallId: 'tool-call-shell',
            toolName: 'run_shell_command',
            approvedAt: '2026-07-09T00:00:00.000Z',
          },
        }
      : {}),
  };
}
