import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'packages', 'core-db', 'package.json'));
const { Client } = require('pg');
const defaultReportDir = join(root, 'tmp', 'agent-rag-live-report');
const reportDir = process.env.DBAGENT_AGENT_RAG_REPORT_DIR ?? defaultReportDir;
const runLivePostgres = process.env.DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES === '1';
const livePostgresDatabase = process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_tools_test';
const localVitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const hasLocalVitest = existsSync(localVitest);
const command = hasLocalVitest
  ? process.execPath
  : process.platform === 'win32'
    ? 'pnpm.cmd'
    : 'pnpm';
const args = hasLocalVitest
  ? [
      localVitest,
      'run',
      'packages/core-tools/test/agent-rag-business-scenario.test.ts',
      '--reporter=verbose',
      '--maxWorkers=1',
      '--minWorkers=1',
    ]
  : [
      'exec',
      'vitest',
      'run',
      'packages/core-tools/test/agent-rag-business-scenario.test.ts',
      '--reporter=verbose',
      '--maxWorkers=1',
      '--minWorkers=1',
    ];

const hasApiKey = Boolean(process.env.TEST_SILICONFLOW_API_KEY || process.env.DBAGENT_LLM_API_KEY);
if (!hasApiKey) {
  console.error(
    [
      'SiliconFlow live Agent/RAG tests require TEST_SILICONFLOW_API_KEY or DBAGENT_LLM_API_KEY.',
      'Set the key in your shell environment; do not commit it to files.',
      'Example: $env:TEST_SILICONFLOW_API_KEY=<本机临时密钥>',
    ].join('\n'),
  );
  process.exit(1);
}

if (runLivePostgres) {
  console.log(`Preparing PostgreSQL live Agent/RAG test database: ${livePostgresDatabase}`);
  await assertPostgresReachable();
  await prepareLivePostgresDatabase(livePostgresDatabase);
}

console.log(
  `Running Agent/RAG live tests with model ${
    process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro'
  }${runLivePostgres ? ' and PostgreSQL' : ''}.`,
);

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    DBAGENT_RUN_AGENT_RAG_LIVE: '1',
    ...(runLivePostgres
      ? {
          DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES: '1',
          DBAGENT_TEST_PG_DATABASE: livePostgresDatabase,
        }
      : {}),
    DBAGENT_AGENT_RAG_REPORT_DIR: reportDir,
    TEST_SILICONFLOW_MODEL: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
  },
  shell: !hasLocalVitest && process.platform === 'win32',
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code === 0) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'run.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          command,
          args,
          model: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
          reportDir,
          postgres: runLivePostgres,
          ...(runLivePostgres
            ? {
                postgresTarget: {
                  host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
                  port: Number(process.env.DBAGENT_TEST_PG_PORT ?? '5432'),
                  database: livePostgresDatabase,
                },
              }
            : {}),
          status: 'passed',
        },
        null,
        2,
      ),
    );
    console.log(`Agent/RAG live test report written to ${reportDir}`);
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
      'Start local PostgreSQL or set DBAGENT_TEST_PG_HOST / DBAGENT_TEST_PG_PORT / DBAGENT_TEST_PG_USER / DBAGENT_TEST_PG_PASSWORD.',
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

async function prepareLivePostgresDatabase(database) {
  if (!/^dbagent_[a-z_]+_test$/.test(database)) {
    throw new Error(`Refusing to recreate non-test database: ${database}`);
  }

  const maintenance = new Client(connectionConfig(process.env.DBAGENT_TEST_PG_MAINTENANCE_DATABASE ?? 'postgres'));
  await maintenance.connect();
  try {
    const name = quoteIdent(database);
    await maintenance.query(`drop database if exists ${name} with (force)`);
    await maintenance.query(`create database ${name}`);
  } finally {
    await maintenance.end();
  }
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
