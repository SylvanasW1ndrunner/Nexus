import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Socket } from 'node:net';
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

await assertPostgresReachable();

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

async function assertPostgresReachable() {
  const host = process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1';
  const port = Number(process.env.DBAGENT_TEST_PG_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid DBAGENT_TEST_PG_PORT: ${process.env.DBAGENT_TEST_PG_PORT}`);
    process.exit(1);
  }
  const reachable = await canOpenTcpConnection(host, port, 1500);
  if (reachable) return;
  console.error(
    [
      `PostgreSQL test database is not reachable at ${host}:${port}.`,
      'Start the local fixture or set DBAGENT_TEST_PG_HOST / DBAGENT_TEST_PG_PORT / DBAGENT_TEST_PG_DATABASE / DBAGENT_TEST_PG_USER / DBAGENT_TEST_PG_PASSWORD.',
      'Auth tests can also use DBAGENT_TEST_AUTH_DATABASE_URL for a dedicated account database.',
    ].join('\n'),
  );
  process.exit(1);
}

function canOpenTcpConnection(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
