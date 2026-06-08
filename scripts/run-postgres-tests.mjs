import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(command, ['exec', 'vitest', 'run', 'test/postgres.integration.test.ts'], {
  cwd: fileURLToPath(new URL('../packages/core-db/', import.meta.url)),
  env: {
    ...process.env,
    DBAGENT_RUN_POSTGRES_TESTS: '1',
  },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
