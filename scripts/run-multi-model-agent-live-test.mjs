import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNotRunLiveReport,
  summarizeLiveAgentRun,
} from './lib/live-agent-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiKey = process.env.TEST_SILICONFLOW_API_KEY;
const cases = [
  { scenario: 'schema-catalog-live', model: 'Qwen/Qwen3.6-35B-A3B' },
  { scenario: 'ecommerce-live', model: 'MiniMaxAI/MiniMax-M2.5' },
  { scenario: 'traffic-cleaning-live', model: 'deepseek-ai/DeepSeek-V4-Pro' },
  { scenario: 'big-science-live', model: 'Qwen/Qwen3.6-35B-A3B' },
];
const reportsRoot = join(root, 'reports', 'postgres-scenarios');
const matrixDirectory = join(reportsRoot, 'live-model-matrix');
const reportPath = join(reportsRoot, 'live-model-matrix.json');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const agentHostDirectory = join(root, 'packages', 'agent-host');
const selectedCases = selectCases(cases, process.env.DBAGENT_MULTI_MODEL_AGENT_SCENARIOS);
const mergePrevious = process.env.DBAGENT_MULTI_MODEL_MERGE_REPORT === '1';
const expectedCases = mergePrevious ? cases : selectedCases;

const report = !apiKey
  ? createNotRunLiveReport({
      kind: 'multi-model-postgres-agent-acceptance',
      reason: 'TEST_SILICONFLOW_API_KEY is required.',
      provider: 'siliconflow',
      protocol: 'openai-chat',
      expectedRunCount: expectedCases.length,
      actualRunCount: 0,
      runs: [],
    })
  : await executeAcceptance();

await mkdir(reportsRoot, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
if (report.status === 'failed') process.exitCode = 1;

async function executeAcceptance() {
  if (!mergePrevious) await rm(matrixDirectory, { recursive: true, force: true });
  await mkdir(matrixDirectory, { recursive: true });

  const preparation = {
    attempted: process.env.DBAGENT_MULTI_MODEL_SKIP_POSTGRES_PREPARE !== '1',
    passed: true,
  };
  if (preparation.attempted) {
    try {
      preparation.exitCode = await run(
        process.execPath,
        [join(root, 'scripts', 'run-postgres-tests.mjs')],
        { cwd: root, env: { ...process.env, DBAGENT_RUN_AGENT_LIVE: '0' } },
      );
      preparation.passed = preparation.exitCode === 0;
    } catch (error) {
      preparation.passed = false;
      preparation.error = describeError(error);
    }
  }

  const runs = mergePrevious ? await readPreviousRuns(reportPath) : [];
  if (preparation.passed) {
    for (const testCase of selectedCases) {
      const runResult = await runCase(testCase);
      const previousIndex = runs.findIndex(
        (candidate) =>
          candidate.scenario === runResult.scenario && candidate.model === runResult.model,
      );
      if (previousIndex === -1) runs.push(runResult);
      else runs.splice(previousIndex, 1, runResult);
    }
  }

  runs.sort(
    (left, right) =>
      cases.findIndex((testCase) => testCase.scenario === left.scenario) -
      cases.findIndex((testCase) => testCase.scenario === right.scenario),
  );
  const passed =
    preparation.passed &&
    runs.length === expectedCases.length &&
    expectedCases.every((testCase) =>
      runs.some(
        (runResult) =>
          runResult.scenario === testCase.scenario &&
          runResult.model === testCase.model &&
          runResult.passed,
      ),
    );
  return {
    kind: 'multi-model-postgres-agent-acceptance',
    generatedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    provider: 'siliconflow',
    protocol: 'openai-chat',
    postgresPreparation: preparation,
    expectedRunCount: expectedCases.length,
    actualRunCount: runs.length,
    passed,
    runs,
  };
}

async function runCase(testCase) {
  const startedAt = Date.now();
  const casePath = join(reportsRoot, 'live-cases', `${testCase.scenario}.json`);
  let exitCode = null;
  let evidence;
  let error;
  try {
    exitCode = await run(
      process.execPath,
      [
        vitest,
        'run',
        'test/postgres-scenarios.integration.test.ts',
        '--pool=threads',
        '-t',
        testCase.scenario,
      ],
      {
        cwd: agentHostDirectory,
        env: {
          ...process.env,
          DBAGENT_RUN_POSTGRES_TESTS: '1',
          DBAGENT_RUN_AGENT_LIVE: '1',
          DBAGENT_LIVE_SCENARIO: testCase.scenario,
          TEST_SILICONFLOW_MODEL: testCase.model,
        },
      },
    );
    evidence = JSON.parse(await readFile(casePath, 'utf8'));
    await writeFile(
      join(matrixDirectory, `${testCase.scenario}--${fileSafe(testCase.model)}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
  } catch (cause) {
    error = describeError(cause);
  }

  let run;
  if (!error) {
    try {
      run = summarizeLiveAgentRun(evidence?.run);
    } catch (cause) {
      error = describeError(cause);
    }
  }
  return {
    scenario: testCase.scenario,
    model: testCase.model,
    passed: exitCode === 0 && error === undefined,
    exitCode,
    durationMs: Date.now() - startedAt,
    ...(run === undefined ? {} : { run }),
    report: `live-model-matrix/${testCase.scenario}--${fileSafe(testCase.model)}.json`,
    ...(error === undefined ? {} : { error }),
  };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Child process terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function fileSafe(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
}

function selectCases(allCases, value) {
  if (!value?.trim()) return allCases;
  const requested = new Set(
    value
      .split(',')
      .map((scenario) => scenario.trim())
      .filter(Boolean),
  );
  const selected = allCases.filter((testCase) => requested.has(testCase.scenario));
  assert.equal(
    selected.length,
    requested.size,
    `未知 Agent 场景：${[...requested]
      .filter((scenario) => !allCases.some((testCase) => testCase.scenario === scenario))
      .join(', ')}`,
  );
  return selected;
}

async function readPreviousRuns(path) {
  try {
    const previous = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(previous.runs) ? previous.runs : [];
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
