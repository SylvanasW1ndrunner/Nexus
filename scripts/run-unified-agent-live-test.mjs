#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  liveConfigurationNotRunReason,
  publicLiveEndpoint,
  resolveSiliconFlowLiveConfiguration,
} from './lib/live-llm-acceptance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'reports', 'agent-runtime', 'live-acceptance.json');
const SCENARIOS = Object.freeze([
  'code-repair',
  'git-dynamic',
  'database-long-result',
  'database-commerce-analysis',
  'database-churn-ml',
  'database-fraud-investigation',
]);
const DATABASE_SCENARIOS = new Set([
  'database-long-result',
  'database-commerce-analysis',
  'database-churn-ml',
  'database-fraud-investigation',
]);

export async function runUnifiedAgentLiveAcceptance(options = {}) {
  const environment = options.environment ?? process.env;
  const configuration = resolveSiliconFlowLiveConfiguration(environment);
  const selected = selectScenarios(options.scope ?? environment.DBAGENT_LIVE_ACCEPTANCE_SCOPE);
  const notRunReason = liveConfigurationNotRunReason(configuration);
  const scenarios = notRunReason === undefined
    ? await runScenarios(selected, configuration, environment, options)
    : selected.map((scenario) => notRun(scenario, notRunReason));
  const passed = scenarios.every((scenario) => scenario.status === 'passed');
  return {
    schemaVersion: 1,
    kind: 'unified-siliconflow-agent-acceptance',
    generatedAt: new Date().toISOString(),
    endpoint: publicLiveEndpoint(configuration.endpoint),
    transportUnderTest: 'openai-compatible',
    model: configuration.model,
    status: passed ? 'passed' : scenarios.some((scenario) => scenario.status === 'failed') ? 'failed' : 'not-run',
    passed,
    requiredScenarios: SCENARIOS,
    selectedScenarios: selected,
    scenarios,
  };
}

async function executeScenario(scenario, configuration, environment, options = {}) {
  const isCommandAvailable = options.commandAvailable ?? commandAvailable;
  const runProcess = options.runProcess ?? run;
  const readScenarioReport = options.readScenarioReport ?? readFile;
  if (scenario === 'git-dynamic' && !await isCommandAvailable('git', ['--version'])) {
    return notRun(scenario, 'The Git CLI is unavailable for the bundled Git/dynamic-capability live scenario.');
  }
  if (DATABASE_SCENARIOS.has(scenario) && !environment.SCHEMANAUT_TEST_POSTGRES_URL) {
    return notRun(
      scenario,
      scenario === 'database-long-result'
        ? 'SCHEMANAUT_TEST_POSTGRES_URL is required for the Database/long-result scenario.'
        : 'SCHEMANAUT_TEST_POSTGRES_URL is required for the Database analysis live scenario.',
    );
  }
  if ((scenario === 'database-churn-ml' || scenario === 'database-fraud-investigation')
    && !await isCommandAvailable('python', ['--version'])) {
    return notRun(scenario, 'An external Python runtime is required for this Database analysis live scenario.');
  }
  const startedAt = Date.now();
  try {
    await runProcess(process.execPath, [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', scenarioTestFileFor(scenario), '--pool=threads',
    ], {
      cwd: join(root, 'packages', 'agent-host'),
      env: liveEnvironment(environment, configuration, {
        DBAGENT_RUN_GENERAL_AGENT_LIVE: '1',
        DBAGENT_LIVE_ACCEPTANCE_SCENARIO: scenario,
        ...(DATABASE_SCENARIOS.has(scenario)
          ? { DATABASE_URL: environment.SCHEMANAUT_TEST_POSTGRES_URL }
          : {}),
      }),
    });
    const reportName = `live-${scenario}.json`;
    const report = JSON.parse(await readScenarioReport(join(root, 'reports', 'agent-runtime', reportName), 'utf8'));
    return report?.passed === true
      ? passed(scenario, startedAt, { report: reportName, evidence: String(report.evidence ?? 'host test and posterior oracle') })
      : failed(scenario, startedAt, `The ${scenario} report did not pass its posterior evidence checks.`);
  } catch (error) {
    return failed(scenario, startedAt, error instanceof Error ? error.message : String(error));
  }
}

export function scenarioTestFileFor(scenario) {
  return scenario === 'database-commerce-analysis'
    || scenario === 'database-churn-ml'
    || scenario === 'database-fraud-investigation'
    ? 'test/database-analysis.live.integration.test.ts'
    : 'test/general-agent.live.integration.test.ts';
}

async function runScenarios(selected, configuration, environment, options) {
  const scenarios = [];
  for (const scenario of selected) scenarios.push(await executeScenario(scenario, configuration, environment, options));
  return scenarios;
}

function liveEnvironment(environment, configuration, extra = {}) {
  return {
    ...environment,
    ...extra,
    TEST_SILICONFLOW_API_KEY: configuration.apiKey,
    TEST_SILICONFLOW_BASE_URL: configuration.endpoint,
    TEST_SILICONFLOW_MODEL: configuration.model,
  };
}

function selectScenarios(value) {
  if (value === undefined || value === '' || value === 'all') return [...SCENARIOS];
  const selected = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
  if (selected.length === 0 || selected.some((scenario) => !SCENARIOS.includes(scenario))) {
    throw new Error(`DBAGENT_LIVE_ACCEPTANCE_SCOPE must select: ${SCENARIOS.join(', ')}, or all.`);
  }
  return selected;
}

function notRun(scenario, reason) { return { scenario, status: 'not-run', reason }; }
function passed(scenario, startedAt, detail) { return { scenario, status: 'passed', durationMs: Date.now() - startedAt, ...detail }; }
function failed(scenario, startedAt, error) { return { scenario, status: 'failed', durationMs: Date.now() - startedAt, error }; }

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Live scenario stopped by ${signal}.`)) : code === 0 ? resolve() : reject(new Error(`Live scenario failed with exit code ${code ?? 1}.`)));
  });
}

function commandAvailable(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const report = await runUnifiedAgentLiveAcceptance();
  await mkdir(join(root, 'reports', 'agent-runtime'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nUnified live report: ${reportPath}\n`);
  if ((process.argv.includes('--require') || process.env.DBAGENT_REQUIRE_LIVE_ACCEPTANCE === '1') && !report.passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
