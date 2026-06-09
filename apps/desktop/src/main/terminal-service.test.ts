import { describe, expect, it } from 'vitest';
import { TerminalService } from './terminal-service.js';

describe('TerminalService', () => {
  it('creates, lists, runs, and closes terminal sessions', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Python' });

    expect(service.list()).toHaveLength(1);

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
        data: 'echo dbagent-terminal-ready\n',
      });

      const output = await waitForOutput(service, terminal.id, 'dbagent-terminal-ready');
      expect(output).toContain('dbagent-terminal-ready');
      expect(service.list()[0]?.status).toBe('running');
    } finally {
      service.close(terminal.id);
    }
  });

  it('clears buffered output without closing the terminal', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Shell' });

    try {
      service.write({
        terminalId: terminal.id,
        data: 'echo dbagent-clear-output\n',
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
});

async function waitForOutput(service: TerminalService, terminalId: string, expected: string): Promise<string> {
  let cursor = 0;
  let output = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = service.read({ terminalId, cursor });
    cursor = result.cursor;
    output += result.chunk;
    if (output.includes(expected)) return output;
  }
  return output;
}
