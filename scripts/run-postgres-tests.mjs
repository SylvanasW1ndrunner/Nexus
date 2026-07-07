import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'packages', 'core-db', 'package.json'));
const { Client } = require('pg');
const localVitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const hasLocalVitest = existsSync(localVitest);
const command = hasLocalVitest ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

await assertPostgresReachable();
await prepareDatabases();

await runVitest('packages/core-db/test/postgres.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await runVitest('apps/desktop/src/main/query-workflow.postgres.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await runVitest('packages/core-auth/test/postgres.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_auth_test',
  DBAGENT_TEST_AUTH_DATABASE_URL: databaseUrl('dbagent_core_auth_test'),
});
await runVitest('packages/core-tools/test/agent-rag-business-scenario.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_tools_test',
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

async function prepareDatabases() {
  const databases = ['dbagent_core_db_test', 'dbagent_core_auth_test', 'dbagent_core_tools_test'];
  const maintenance = new Client(connectionConfig(process.env.DBAGENT_TEST_PG_MAINTENANCE_DATABASE ?? 'postgres'));
  await maintenance.connect();
  try {
    for (const database of databases) {
      await recreateDatabase(maintenance, database);
    }
  } finally {
    await maintenance.end();
  }

  const coreDb = new Client(connectionConfig('dbagent_core_db_test'));
  await coreDb.connect();
  try {
    await coreDb.query(await readFile(join(root, 'scripts', 'dev-db', 'init.sql'), 'utf8'));
  } finally {
    await coreDb.end();
  }
}

async function recreateDatabase(client, database) {
  if (!/^dbagent_[a-z_]+_test$/.test(database)) {
    throw new Error(`Refusing to recreate non-test database: ${database}`);
  }
  const name = quoteIdent(database);
  await client.query(`drop database if exists ${name} with (force)`);
  await client.query(`create database ${name}`);
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function connectionConfig(database) {
  return {
    host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBAGENT_TEST_PG_PORT ?? '5432'),
    database,
    user: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  };
}

function databaseUrl(database) {
  const config = connectionConfig(database);
  return `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${database}`;
}

function runVitest(testFile, env) {
  const args = hasLocalVitest ? [localVitest, 'run', testFile] : ['exec', 'vitest', 'run', testFile];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        DBAGENT_RUN_POSTGRES_TESTS: '1',
      },
      shell: !hasLocalVitest && process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${testFile} failed with exit code ${code ?? 1}`));
    });
  });
}
