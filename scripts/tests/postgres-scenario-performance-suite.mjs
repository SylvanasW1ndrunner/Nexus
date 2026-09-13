#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePostgresPerformanceReports } from '../lib/postgres-performance-report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const worker = join(root, 'scripts', 'tests', 'postgres-scenario-performance.mjs');
const reportPath = join(root, 'reports', 'postgres-scenarios', 'performance.json');
const scenarioNames = [
  'ecommerce-finance',
  'traffic-cleaning-anomaly',
  'big-science-statistics',
  'big-science-result-page',
];
const reports = [];

for (const scenarioName of scenarioNames) {
  const exitCode = await runWorker(scenarioName);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(
    report.configuration?.scenarioFilter,
    [scenarioName],
    `Performance worker did not produce the requested scenario: ${scenarioName}`,
  );
  assert.deepEqual(
    report.scenarios?.map((scenario) => scenario.name),
    [scenarioName],
    `Performance worker report contains the wrong scenario: ${scenarioName}`,
  );
  if (exitCode !== 0 && report.passed === true) {
    throw new Error(`Performance worker ${scenarioName} exited ${exitCode} with a passing report.`);
  }
  reports.push(report);
}

const merged = mergePostgresPerformanceReports(reports);
await writeFile(reportPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.info(
  `[postgres-scenarios] ${JSON.stringify({
    report: reportPath,
    passed: merged.passed,
    isolation: merged.configuration.scenarioIsolation,
    scenarios: merged.scenarios.map((scenario) => ({
      name: scenario.name,
      directPgP95Ms: scenario.directPg.p95Ms,
      schemanautP95Ms: scenario.schemanaut.p95Ms,
      platformOverheadP95Ms: scenario.platformOverheadP95Ms,
      thresholdMs: scenario.platformOverheadP95ThresholdMs,
      passed: scenario.passed,
    })),
  })}`,
);
if (!merged.passed) process.exitCode = 1;

function runWorker(scenarioName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      cwd: root,
      env: {
        ...process.env,
        DBAGENT_SCENARIO_PERF_FILTER: scenarioName,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Performance worker ${scenarioName} terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
