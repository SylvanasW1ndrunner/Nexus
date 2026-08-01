import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--live-llm')) {
  await loadEnvFile(join(root, '.env'));
  process.env.DBAGENT_RUN_SDK_LIVE = '1';
}
const require = createRequire(join(root, 'packages', 'core-db', 'package.json'));
const { Client } = require('pg');
const localVitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const hasLocalVitest = existsSync(localVitest);
const command = hasLocalVitest
  ? process.execPath
  : process.platform === 'win32'
    ? 'pnpm.cmd'
    : 'pnpm';
const scenarioReportDirectory = join(root, 'reports', 'postgres-scenarios');
const scenarioRunId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
process.env.DBAGENT_TEST_RUN_ID = scenarioRunId;

await resetScenarioReports();
await assertPostgresReachable();
await prepareDatabases();

await runVitest('packages/core-db/test/postgres.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await runVitest('packages/core-db/test/postgres-connector.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await runVitest('packages/sdk/test/postgres.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await runVitest('packages/sdk/test/postgres-scenarios.integration.test.ts', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
if (process.env.DBAGENT_RUN_SDK_LIVE === '1') {
  await runVitest('packages/sdk/test/general-agent.live.integration.test.ts', {
    DBAGENT_RUN_GENERAL_AGENT_LIVE: '1',
  });
}
await runNodeScript('scripts/tests/postgres-scenario-performance.mjs', {
  DBAGENT_TEST_PG_DATABASE: 'dbagent_core_db_test',
});
await writeScenarioManifest();

async function resetScenarioReports() {
  await mkdir(scenarioReportDirectory, { recursive: true });
  const reportNames = ['functional.json', 'performance.json', 'manifest.json'];
  if (process.env.DBAGENT_RUN_SDK_LIVE === '1') reportNames.push('live.json');
  for (const name of reportNames) {
    await rm(join(scenarioReportDirectory, name), { force: true });
  }
  if (process.env.DBAGENT_RUN_SDK_LIVE === '1') {
    await rm(join(root, 'reports', 'agent-runtime', 'live-project.json'), { force: true });
  }
}

async function writeScenarioManifest() {
  const functionalPath = join(scenarioReportDirectory, 'functional.json');
  const performancePath = join(scenarioReportDirectory, 'performance.json');
  const functionalText = await readFile(functionalPath, 'utf8');
  const performanceText = await readFile(performancePath, 'utf8');
  const functional = JSON.parse(functionalText);
  const performance = JSON.parse(performanceText);
  if (
    functional.runId !== scenarioRunId ||
    performance.runId !== scenarioRunId ||
    functional.passed !== true ||
    performance.passed !== true
  ) {
    throw new Error('Scenario reports do not belong to this successful test run.');
  }
  const fixtureFiles = [
    'scripts/dev-db/init.sql',
    'scripts/dev-db/scenarios/ecommerce.sql',
    'scripts/dev-db/scenarios/traffic-cleaning.sql',
    'scripts/dev-db/scenarios/big-science.sql',
  ];
  const fixtureDigest = createHash('sha256');
  for (const file of fixtureFiles) {
    fixtureDigest.update(file);
    fixtureDigest.update(await readFile(join(root, file)));
  }
  const git = gitState();
  let live;
  let generalAgent;
  const livePath = join(scenarioReportDirectory, 'live.json');
  if (process.env.DBAGENT_RUN_SDK_LIVE === '1') {
    const liveText = await readFile(livePath, 'utf8');
    const liveReport = JSON.parse(liveText);
    if (liveReport.runId !== scenarioRunId || liveReport.passed !== true) {
      throw new Error('Live scenario report does not belong to this successful test run.');
    }
    live = {
      path: 'live.json',
      sha256: sha256(liveText),
      runCount: liveReport.actualRunCount,
      passed: liveReport.passed,
    };
    const generalAgentPath = join(root, 'reports', 'agent-runtime', 'live-project.json');
    const generalAgentText = await readFile(generalAgentPath, 'utf8');
    const generalAgentReport = JSON.parse(generalAgentText);
    if (generalAgentReport.runId !== scenarioRunId || generalAgentReport.passed !== true) {
      throw new Error('General Agent live report does not belong to this successful test run.');
    }
    generalAgent = {
      path: '../agent-runtime/live-project.json',
      sha256: sha256(generalAgentText),
      passed: true,
    };
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    runId: scenarioRunId,
    database: 'dbagent_core_db_test',
    git,
    fixtures: {
      files: fixtureFiles,
      sha256: fixtureDigest.digest('hex'),
    },
    reports: {
      functional: {
        path: 'functional.json',
        sha256: sha256(functionalText),
        runCount: functional.actualRunCount,
        passed: functional.passed,
      },
      performance: {
        path: 'performance.json',
        sha256: sha256(performanceText),
        scenarioCount: performance.scenarios.length,
        passed: performance.passed,
      },
      ...(live === undefined ? {} : { live }),
      ...(generalAgent === undefined ? {} : { generalAgent }),
    },
    passed: true,
  };
  const temporaryPath = join(scenarioReportDirectory, `manifest-${scenarioRunId}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, join(scenarioReportDirectory, 'manifest.json'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitState() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : 'unavailable',
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : undefined,
  };
}

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
      'The runner recreates only the dedicated dbagent_core_db_test database.',
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
  const databases = ['dbagent_core_db_test'];
  const maintenance = new Client(
    connectionConfig(process.env.DBAGENT_TEST_PG_MAINTENANCE_DATABASE ?? 'postgres'),
  );
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
    for (const scenario of ['ecommerce.sql', 'traffic-cleaning.sql', 'big-science.sql']) {
      await coreDb.query(
        await readFile(join(root, 'scripts', 'dev-db', 'scenarios', scenario), 'utf8'),
      );
    }
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

function runVitest(testFile, env) {
  const cwd = resolveTestCwd(testFile);
  const relativeTestFile = testFile.slice(cwd.relative.length + 1).replaceAll('\\', '/');
  const args = hasLocalVitest
    ? [localVitest, 'run', relativeTestFile, '--pool=threads']
    : ['exec', 'vitest', 'run', relativeTestFile, '--pool=threads'];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd.absolute,
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

function runNodeScript(scriptFile, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, scriptFile)], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        DBAGENT_RUN_POSTGRES_TESTS: '1',
      },
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
      reject(new Error(`${scriptFile} failed with exit code ${code ?? 1}`));
    });
  });
}

function resolveTestCwd(testFile) {
  const normalized = testFile.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length < 3 || (parts[0] !== 'packages' && parts[0] !== 'apps')) {
    return { relative: '.', absolute: root };
  }
  const relative = `${parts[0]}/${parts[1]}`;
  return {
    relative,
    absolute: join(root, parts[0], parts[1]),
  };
}
