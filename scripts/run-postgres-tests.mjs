import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const localVitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const hasLocalVitest = existsSync(localVitest);
const command = hasLocalVitest ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const args = hasLocalVitest
  ? [
      localVitest,
      'run',
      'packages/core-db/test/postgres.integration.test.ts',
      'packages/core-auth/test/postgres.integration.test.ts',
    ]
  : [
      'exec',
      'vitest',
      'run',
      'packages/core-db/test/postgres.integration.test.ts',
      'packages/core-auth/test/postgres.integration.test.ts',
    ];

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    DBAGENT_RUN_POSTGRES_TESTS: '1',
  },
  shell: !hasLocalVitest && process.platform === 'win32',
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
