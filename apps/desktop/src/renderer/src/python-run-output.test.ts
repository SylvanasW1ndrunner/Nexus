import { describe, expect, it } from 'vitest';
import { formatPythonRunTranscript, pythonRunSucceeded } from './python-run-output.js';

describe('python run output formatting', () => {
  it('formats command, cwd, stdout, stderr, and exit metadata for the terminal panel', () => {
    const transcript = formatPythonRunTranscript({
      command: 'python scripts/job.py',
      cwd: 'C:/Projects/Analytics',
      exitCode: 1,
      stdout: 'loaded 10 rows\n',
      stderr: 'failed validation\n',
      elapsedMs: 45,
    });

    expect(transcript).toContain('$ python scripts/job.py');
    expect(transcript).toContain('cwd: C:/Projects/Analytics');
    expect(transcript).toContain('loaded 10 rows');
    expect(transcript).toContain('failed validation');
    expect(transcript).toContain('[python exit 1 / 45 ms]');
  });

  it('treats only zero exit code as success', () => {
    expect(pythonRunSucceeded({ command: 'python -c pass', cwd: '/', exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 })).toBe(
      true,
    );
    expect(
      pythonRunSucceeded({ command: 'python -c fail', cwd: '/', exitCode: null, stdout: '', stderr: 'error', elapsedMs: 1 }),
    ).toBe(false);
  });
});
