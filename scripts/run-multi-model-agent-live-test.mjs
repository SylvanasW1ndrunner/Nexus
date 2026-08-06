import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await loadEnvFile(join(root, '.env'));

const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
assert.ok(apiKey, '需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY。');

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
const sdkDirectory = join(root, 'packages', 'sdk');
const selectedCases = selectCases(cases, process.env.DBAGENT_MULTI_MODEL_AGENT_SCENARIOS);
const mergePrevious = process.env.DBAGENT_MULTI_MODEL_MERGE_REPORT === '1';

if (!mergePrevious) await rm(matrixDirectory, { recursive: true, force: true });
await mkdir(matrixDirectory, { recursive: true });

if (process.env.DBAGENT_MULTI_MODEL_SKIP_POSTGRES_PREPARE !== '1') {
  const prepareExitCode = await run(process.execPath, [join(root, 'scripts', 'run-postgres-tests.mjs')], {
    cwd: root,
    env: { ...process.env, DBAGENT_RUN_SDK_LIVE: '0' },
  });
  assert.equal(prepareExitCode, 0, 'PostgreSQL 场景准备与确定性回归失败。');
}

const runs = mergePrevious ? await readPreviousRuns(reportPath) : [];
for (const testCase of selectedCases) {
  const startedAt = Date.now();
  const exitCode = await run(
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
      cwd: sdkDirectory,
      env: {
        ...process.env,
        DBAGENT_RUN_POSTGRES_TESTS: '1',
        DBAGENT_RUN_SDK_LIVE: '1',
        DBAGENT_LIVE_SCENARIO: testCase.scenario,
        TEST_SILICONFLOW_MODEL: testCase.model,
      },
    },
  );
  const casePath = join(reportsRoot, 'live-cases', `${testCase.scenario}.json`);
  const evidence = JSON.parse(await readFile(casePath, 'utf8'));
  const outputName = `${testCase.scenario}--${fileSafe(testCase.model)}.json`;
  await writeFile(
    join(matrixDirectory, outputName),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
  const runResult = {
    scenario: testCase.scenario,
    model: testCase.model,
    passed: exitCode === 0 && evidence.run?.passed === true,
    exitCode,
    durationMs: Date.now() - startedAt,
    iterations: evidence.run?.iterations ?? null,
    tokenUsage: evidence.run?.tokenUsage ?? null,
    toolCount: Array.isArray(evidence.run?.tools) ? evidence.run.tools.length : 0,
    report: `live-model-matrix/${outputName}`,
    ...(typeof evidence.run?.error === 'string' ? { error: evidence.run.error } : {}),
  };
  const previousIndex = runs.findIndex(
    (candidate) =>
      candidate.scenario === runResult.scenario && candidate.model === runResult.model,
  );
  if (previousIndex === -1) runs.push(runResult);
  else runs.splice(previousIndex, 1, runResult);
}

runs.sort(
  (left, right) =>
    cases.findIndex((testCase) => testCase.scenario === left.scenario) -
    cases.findIndex((testCase) => testCase.scenario === right.scenario),
);

const report = {
  kind: 'multi-model-postgres-agent-acceptance',
  generatedAt: new Date().toISOString(),
  provider: 'siliconflow',
  protocol: 'openai-chat',
  expectedRunCount: cases.length,
  actualRunCount: runs.length,
  passed: runs.length === cases.length && runs.every((runResult) => runResult.passed),
  runs,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
if (!report.passed) process.exitCode = 1;

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
