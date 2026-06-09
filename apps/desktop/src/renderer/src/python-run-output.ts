import type { PythonRunResult } from '@dbagent/shared';

export function formatPythonRunTranscript(result: PythonRunResult): string {
  const lines = [`$ ${result.command}`, `cwd: ${result.cwd}`];
  if (result.stdout.trim()) {
    lines.push('', result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    lines.push('', result.stderr.trimEnd());
  }
  lines.push('', `[python exit ${result.exitCode ?? 'unknown'} / ${result.elapsedMs} ms]`);
  return `${lines.join('\n')}\n`;
}

export function pythonRunSucceeded(result: PythonRunResult): boolean {
  return result.exitCode === 0;
}
