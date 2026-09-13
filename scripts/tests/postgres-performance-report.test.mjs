import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePostgresFunctionalReport } from '../lib/postgres-functional-report.mjs';
import { buildPostgresTestUrl } from '../lib/postgres-test-url.mjs';
import { mergePostgresPerformanceReports } from '../lib/postgres-performance-report.mjs';

test('builds the Agent PostgreSQL URL from test defaults and URL-encodes credentials', () => {
  assert.equal(
    buildPostgresTestUrl({}, 'dbagent_core_db_test'),
    'postgres://postgres:postgres@127.0.0.1:5432/dbagent_core_db_test',
  );
  assert.equal(
    buildPostgresTestUrl({
      DBAGENT_TEST_PG_HOST: 'postgres.example.test',
      DBAGENT_TEST_PG_PORT: '5544',
      DBAGENT_TEST_PG_USER: 'agent:user',
      DBAGENT_TEST_PG_PASSWORD: 'pa:ss@word',
    }, 'dbagent_core_db_test'),
    'postgres://agent%3Auser:pa%3Ass%40word@postgres.example.test:5544/dbagent_core_db_test',
  );
});

test('writes an honest functional report for the three executed PostgreSQL integration suites', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-postgres-functional-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, 'functional.json');
  const runId = 'postgres-contract-run';
  const testFiles = [
    'packages/core-db/test/postgres.integration.test.ts',
    'packages/core-db/test/postgres-connector.integration.test.ts',
    'packages/agent-host/test/database-agent-postgres.integration.test.ts',
  ];

  await writePostgresFunctionalReport({
    reportPath,
    runId,
    database: 'dbagent_core_db_test',
    testFiles,
  });

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.runId, runId);
  assert.equal(report.database, 'dbagent_core_db_test');
  assert.equal(report.expectedSuiteCount, 3);
  assert.equal(report.actualSuiteCount, 3);
  assert.equal(report.expectedRunCount, undefined);
  assert.equal(report.actualRunCount, undefined);
  assert.equal(report.passed, true);
  assert.deepEqual(report.suites, testFiles.map((testFile) => ({
    testFile,
    database: 'dbagent_core_db_test',
    passed: true,
  })));
});

test('merges isolated scenario reports without changing their measurements', () => {
  const common = {
    runId: 'run-1',
    environment: { node: 'v24', os: 'windows', cpu: 'test', postgres: '17' },
    scale: { ecommerce_orders: 20_000, raw_events: 20_000, science_observations: 24_000 },
  };
  const ecommerce = {
    generatedAt: '2026-08-07T00:00:00.000Z',
    ...common,
    configuration: {
      warmupDurationMs: 10_000,
      measuredIterations: 40,
      comparedPaths: [
        'pg.Client.query',
        'PostgresConnector durable submit + complete cursor paging + release',
        'DatabaseAccessRuntime + PostgresConnector end-to-end',
      ],
      gate: 'paired outer DatabaseAccessRuntime time minus the same in-call connector boundary P95',
      pairing: 'mirrored ABBA durable runs; exact platform timing brackets each runtime connector call',
      platformOverheadP95ThresholdMs: 50,
      scenarioFilter: ['ecommerce-finance'],
    },
    scenarios: [{
      name: 'ecommerce-finance',
      directPg: { p50Ms: 10, p95Ms: 12 },
      durableReference: { p50Ms: 40, p95Ms: 45 },
      schemanaut: { p50Ms: 43, p95Ms: 49 },
      platformOverhead: { p50Ms: 2, p95Ms: 4, rawSamplesMs: [2, 4] },
      phases: { submit: { p95Ms: 30 }, page: { p95Ms: 14 }, release: { p95Ms: 5 } },
      pagination: { publicPageLimit: 1_000, rawPageCounts: { schemanaut: [1, 1] } },
      platformOverheadP95Ms: 4,
      passed: true,
    }],
    passed: true,
  };
  const science = {
    ...structuredClone(ecommerce),
    generatedAt: '2026-08-07T00:01:00.000Z',
    configuration: {
      ...ecommerce.configuration,
      scenarioFilter: ['big-science-statistics'],
    },
    scenarios: [{
      name: 'big-science-statistics',
      directPg: { p50Ms: 20, p95Ms: 24 },
      durableReference: { p50Ms: 50, p95Ms: 55 },
      schemanaut: { p50Ms: 53, p95Ms: 59 },
      platformOverhead: { p50Ms: 3, p95Ms: 5, rawSamplesMs: [3, 5] },
      phases: { submit: { p95Ms: 35 }, page: { p95Ms: 18 }, release: { p95Ms: 6 } },
      pagination: { publicPageLimit: 1_000, rawPageCounts: { schemanaut: [1, 1] } },
      platformOverheadP95Ms: 5,
      passed: true,
    }],
  };

  const merged = mergePostgresPerformanceReports([ecommerce, science], {
    generatedAt: '2026-08-07T00:02:00.000Z',
  });

  assert.equal(merged.generatedAt, '2026-08-07T00:02:00.000Z');
  assert.equal(merged.runId, 'run-1');
  assert.deepEqual(merged.configuration.scenarioFilter, []);
  assert.equal(merged.configuration.scenarioIsolation, 'fresh-process-per-scenario');
  assert.deepEqual(merged.scenarios, [ecommerce.scenarios[0], science.scenarios[0]]);
  assert.equal(merged.configuration.gate, ecommerce.configuration.gate);
  assert.equal(merged.configuration.pairing, ecommerce.configuration.pairing);
  assert.equal(merged.scenarios[0].durableReference.p95Ms, 45);
  assert.equal(merged.scenarios[0].schemanaut.p95Ms, 49);
  assert.equal(merged.scenarios[0].platformOverhead.p95Ms, 4);
  assert.deepEqual(merged.scenarios[0].pagination.rawPageCounts.schemanaut, [1, 1]);
  assert.equal(merged.passed, true);
});

test('rejects reports from different fixture runs', () => {
  const report = {
    generatedAt: '2026-08-07T00:00:00.000Z',
    runId: 'run-1',
    environment: {},
    configuration: { scenarioFilter: ['one'] },
    scale: {},
    scenarios: [{ name: 'one', passed: true }],
    passed: true,
  };

  assert.throws(
    () => mergePostgresPerformanceReports([report, { ...report, runId: 'run-2' }]),
    /same test run/,
  );
});
