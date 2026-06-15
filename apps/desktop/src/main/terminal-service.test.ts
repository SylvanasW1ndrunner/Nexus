import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TerminalService } from './terminal-service.js';

describe('TerminalService', () => {
  it('creates, lists, runs, and closes terminal sessions', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Python' });

    expect(service.list()).toHaveLength(1);
    if (process.platform === 'win32') expect(terminal.shell).toBe('powershell.exe');

    const result = await service.run({
      terminalId: terminal.id,
      command: `"${process.execPath}" -e "console.log(21 * 2)"`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
    expect(service.list()[0]?.lastCommand).toContain(process.execPath);

    service.close(terminal.id);
    expect(service.list()).toHaveLength(0);
  });

  it('keeps a shell session alive for write/read terminal output', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Shell' });

    try {
      service.write({
        terminalId: terminal.id,
        data: 'echo dbagent-terminal-ready\r',
      });

      const output = await waitForOutput(service, terminal.id, 'dbagent-terminal-ready');
      expect(output).toContain('dbagent-terminal-ready');
      expect(service.list()[0]?.status).toBe('running');
    } finally {
      service.close(terminal.id);
    }
  });

  it('falls back to the system shell when a configured shell cannot start', async () => {
    const service = new TerminalService({ defaultShell: 'dbagent-missing-shell-for-test' });
    const terminal = service.create({ name: 'Fallback Shell' });

    try {
      if (process.platform === 'win32') expect(terminal.shell).toBe('powershell.exe');
      service.write({
        terminalId: terminal.id,
        data: 'echo dbagent-terminal-fallback\r',
      });
      const output = await waitForOutput(service, terminal.id, 'dbagent-terminal-fallback');
      expect(output).toContain('dbagent-terminal-fallback');
    } finally {
      service.close(terminal.id);
    }
  });

  it('accepts character-by-character interactive input', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Interactive Shell' });

    try {
      for (const char of 'echo dbagent-char-input\r') {
        service.write({
          terminalId: terminal.id,
          data: char,
        });
      }

      const output = await waitForOutput(service, terminal.id, 'dbagent-char-input');
      expect(output).toContain('dbagent-char-input');
      expect(service.list()[0]?.status).toBe('running');
    } finally {
      service.close(terminal.id);
    }
  });

  it('starts interactive shell sessions in the requested working directory', async () => {
    const service = new TerminalService();
    const cwd = await mkdtemp(join(tmpdir(), 'dbagent-terminal-cwd-'));
    const terminal = service.create({ cwd, name: 'Project Shell' });

    try {
      service.write({
        terminalId: terminal.id,
        data: 'pwd\r',
      });

      const output = await waitForOutput(service, terminal.id, cwd);
      expect(output.replaceAll('\\', '/')).toContain(cwd.replaceAll('\\', '/'));
      expect(service.list()[0]).toMatchObject({
        cwd,
        name: 'Project Shell',
        status: 'running',
      });
    } finally {
      service.close(terminal.id);
      await removeWhenUnlocked(cwd);
    }
  });

  it('clears buffered output without closing the terminal', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Shell' });

    try {
      service.write({
        terminalId: terminal.id,
        data: 'echo dbagent-clear-output\r',
      });
      await waitForOutput(service, terminal.id, 'dbagent-clear-output');

      expect(service.clear(terminal.id)).toEqual({ id: terminal.id });
      expect(service.read({ terminalId: terminal.id, cursor: 0 })).toMatchObject({
        terminalId: terminal.id,
        chunk: '',
        cursor: 0,
        status: 'running',
      });
      expect(service.list()[0]?.status).toBe('running');
    } finally {
      service.close(terminal.id);
    }
  });

  it('resizes an interactive PTY session', () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Resizable Shell' });

    try {
      expect(service.resize({ terminalId: terminal.id, cols: 120.8, rows: 36.2 })).toEqual({
        id: terminal.id,
        cols: 120,
        rows: 36,
      });
    } finally {
      service.close(terminal.id);
    }
  });
});

async function waitForOutput(service: TerminalService, terminalId: string, expected: string): Promise<string> {
  let cursor = 0;
  let output = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = service.read({ terminalId, cursor });
    cursor = result.cursor;
    output += result.chunk;
    if (output.includes(expected)) return output;
  }
  return output;
}

async function removeWhenUnlocked(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(path, { force: true, recursive: true });
}
