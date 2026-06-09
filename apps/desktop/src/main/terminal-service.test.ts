import { describe, expect, it } from 'vitest';
import { TerminalService } from './terminal-service.js';

describe('TerminalService', () => {
  it('creates, lists, runs, and closes terminal sessions', async () => {
    const service = new TerminalService();
    const terminal = service.create({ name: 'Python' });

    expect(service.list()).toHaveLength(1);

    const result = await service.run({
      terminalId: terminal.id,
      command: 'node -e "console.log(21 * 2)"',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
    expect(service.list()[0]?.lastCommand).toContain('node -e');

    service.close(terminal.id);
    expect(service.list()).toHaveLength(0);
  });
});
