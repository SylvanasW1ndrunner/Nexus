import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  boundedLiveMaxOutputTokens,
  liveConfigurationNotRunReason,
  normalizeLiveMaxOutputTokens,
  resolveSiliconFlowLiveConfiguration,
  SILICONFLOW_DEFAULT_MODEL,
  SILICONFLOW_OPENAI_COMPATIBLE_ENDPOINT,
} from '../lib/live-llm-acceptance.mjs';
import {
  runUnifiedAgentLiveAcceptance,
  scenarioTestFileFor,
} from '../run-unified-agent-live-test.mjs';

test('uses a reasoning-safe default output limit', () => {
  assert.equal(normalizeLiveMaxOutputTokens(undefined), 4_096);
  assert.equal(normalizeLiveMaxOutputTokens('2048'), 2_048);
  assert.throws(() => normalizeLiveMaxOutputTokens('96'), /128 through 65536/);
});

test('reads the structured discovered output limit without coercing metadata to NaN', () => {
  assert.equal(
    boundedLiveMaxOutputTokens(4_096, { value: 2_048, source: 'models-dev', confidence: 'high' }),
    2_048,
  );
  assert.equal(
    boundedLiveMaxOutputTokens(4_096, { value: null, source: 'unknown', confidence: 'unknown' }),
    4_096,
  );
});

test('centralizes SiliconFlow process-environment defaults without inspecting a key value', () => {
  const absent = resolveSiliconFlowLiveConfiguration({});
  assert.equal(absent.endpoint, SILICONFLOW_OPENAI_COMPATIBLE_ENDPOINT);
  assert.equal(absent.model, SILICONFLOW_DEFAULT_MODEL);
  assert.equal(absent.apiKey, undefined);
  assert.match(liveConfigurationNotRunReason(absent), /TEST_SILICONFLOW_API_KEY/);

  const configured = resolveSiliconFlowLiveConfiguration({
    TEST_SILICONFLOW_API_KEY: 'synthetic-test-key',
    TEST_SILICONFLOW_BASE_URL: 'https://example.test/v1/',
    TEST_SILICONFLOW_MODEL: 'example/model',
  });
  assert.equal(configured.endpoint, 'https://example.test/v1');
  assert.equal(configured.model, 'example/model');
  assert.equal(liveConfigurationNotRunReason(configured), undefined);
  assert.throws(
    () => resolveSiliconFlowLiveConfiguration({ TEST_SILICONFLOW_BASE_URL: 'ftp://example.test' }),
    /HTTP\(S\)/,
  );
});

test('unified live acceptance reports missing process prerequisites without issuing a provider request', async () => {
  const report = await runUnifiedAgentLiveAcceptance({ environment: {}, scope: 'all' });
  assert.equal(report.status, 'not-run');
  assert.equal(report.passed, false);
  assert.deepEqual(report.requiredScenarios, [
    'code-repair',
    'git-dynamic',
    'database-long-result',
    'database-commerce-analysis',
    'database-churn-ml',
    'database-fraud-investigation',
  ]);
  assert.deepEqual(report.selectedScenarios, report.requiredScenarios);
  assert.ok(report.scenarios.every((scenario) => scenario.status === 'not-run'));
  assert.ok(report.scenarios.every((scenario) => /TEST_SILICONFLOW_API_KEY/.test(scenario.reason)));
});

test('database live acceptance reports a missing external PostgreSQL environment without issuing a provider request', async () => {
  const report = await runUnifiedAgentLiveAcceptance({
    environment: { TEST_SILICONFLOW_API_KEY: 'synthetic-test-key' },
    scope: 'database-long-result',
  });
  assert.equal(report.status, 'not-run');
  assert.equal(report.passed, false);
  assert.deepEqual(report.scenarios, [{
    scenario: 'database-long-result',
    status: 'not-run',
    reason: 'SCHEMANAUT_TEST_POSTGRES_URL is required for the Database/long-result scenario.',
  }]);
});

test('each database analysis scope reports its PostgreSQL prerequisite without issuing a provider request', async () => {
  for (const scenario of [
    'database-commerce-analysis',
    'database-churn-ml',
    'database-fraud-investigation',
  ]) {
    const report = await runUnifiedAgentLiveAcceptance({
      environment: { TEST_SILICONFLOW_API_KEY: 'synthetic-test-key' },
      scope: scenario,
    });
    assert.deepEqual(report.scenarios, [{
      scenario,
      status: 'not-run',
      reason: 'SCHEMANAUT_TEST_POSTGRES_URL is required for the Database analysis live scenario.',
    }]);
  }
});

test('acceptance scope selects comma-separated database analysis scenarios', async () => {
  const report = await runUnifiedAgentLiveAcceptance({
    environment: {},
    scope: 'database-commerce-analysis,database-fraud-investigation',
  });
  assert.deepEqual(report.selectedScenarios, [
    'database-commerce-analysis',
    'database-fraud-investigation',
  ]);
  assert.ok(report.scenarios.every((scenario) => scenario.status === 'not-run'));
});

test('invalid acceptance scope lists every available scenario', async () => {
  await assert.rejects(
    runUnifiedAgentLiveAcceptance({ environment: {}, scope: 'not-a-live-scenario' }),
    /code-repair, git-dynamic, database-long-result, database-commerce-analysis, database-churn-ml, database-fraud-investigation, or all/u,
  );
});

test('database analysis scenarios dispatch to their dedicated Host integration suite', () => {
  assert.equal(
    scenarioTestFileFor('database-commerce-analysis'),
    'test/database-analysis.live.integration.test.ts',
  );
  assert.equal(
    scenarioTestFileFor('database-churn-ml'),
    'test/database-analysis.live.integration.test.ts',
  );
  assert.equal(
    scenarioTestFileFor('database-fraud-investigation'),
    'test/database-analysis.live.integration.test.ts',
  );
  assert.equal(scenarioTestFileFor('database-long-result'), 'test/general-agent.live.integration.test.ts');
  assert.equal(scenarioTestFileFor('code-repair'), 'test/general-agent.live.integration.test.ts');
});

test('database analysis dispatch maps the PostgreSQL URL into every Host subprocess', async () => {
  const subprocesses = [];
  const report = await runUnifiedAgentLiveAcceptance({
    environment: {
      TEST_SILICONFLOW_API_KEY: 'synthetic-test-key',
      SCHEMANAUT_TEST_POSTGRES_URL: 'postgres://test.example/acceptance',
    },
    scope: 'database-commerce-analysis,database-churn-ml,database-fraud-investigation',
    commandAvailable: async () => true,
    runProcess: async (_command, args, options) => { subprocesses.push({ args, options }); },
    readScenarioReport: async () => JSON.stringify({ passed: true, evidence: 'synthetic posterior evidence' }),
  });

  assert.equal(report.status, 'passed');
  assert.equal(subprocesses.length, 3);
  for (const subprocess of subprocesses) {
    assert.ok(subprocess.args.includes('test/database-analysis.live.integration.test.ts'));
    assert.equal(subprocess.options.env.DATABASE_URL, 'postgres://test.example/acceptance');
  }
});

test('Python-dependent database analyses report a missing external runtime without dispatching model tests', async () => {
  let dispatched = false;
  const report = await runUnifiedAgentLiveAcceptance({
    environment: {
      TEST_SILICONFLOW_API_KEY: 'synthetic-test-key',
      SCHEMANAUT_TEST_POSTGRES_URL: 'postgres://test.example/acceptance',
    },
    scope: 'database-churn-ml,database-fraud-investigation',
    commandAvailable: async (command) => command !== 'python',
    runProcess: async () => { dispatched = true; },
  });

  assert.equal(dispatched, false);
  assert.deepEqual(report.scenarios, [
    {
      scenario: 'database-churn-ml',
      status: 'not-run',
      reason: 'An external Python runtime is required for this Database analysis live scenario.',
    },
    {
      scenario: 'database-fraud-investigation',
      status: 'not-run',
      reason: 'An external Python runtime is required for this Database analysis live scenario.',
    },
  ]);
});

test('live acceptance entrypoints use explicit test inputs and never load product .env files', async () => {
  const entrypoints = [
    '../run-postgres-tests.mjs',
    '../run-general-agent-live-test.mjs',
    '../run-unified-agent-live-test.mjs',
    '../run-multi-model-tool-live-test.mjs',
    '../run-multi-model-agent-live-test.mjs',
    '../run-capability-runtime-live-test.mjs',
    '../run-llm-live-performance.mjs',
    '../../packages/agent-host/test/general-agent.live.integration.test.ts',
    '../../packages/agent-host/test/database-analysis.live.integration.test.ts',
    '../../packages/agent-host/test/postgres.integration.test.ts',
    '../../packages/agent-host/test/postgres-scenarios.integration.test.ts',
  ];

  for (const entrypoint of entrypoints) {
    const source = await readFile(new URL(entrypoint, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /loadEnvFile|join\(root, ['"]\.env['"]\)/u, entrypoint);
    assert.doesNotMatch(
      source,
      /DBAGENT_LLM_(?:API_KEY|BASE_URL|MODEL|CANONICAL_MODEL)/u,
      entrypoint,
    );
  }
});

test('live runners target the internal Agent host and use the Agent live switch', async () => {
  const runners = [
    '../run-postgres-tests.mjs',
    '../run-general-agent-live-test.mjs',
    '../run-multi-model-tool-live-test.mjs',
    '../run-multi-model-agent-live-test.mjs',
    '../run-capability-runtime-live-test.mjs',
    '../run-llm-live-performance.mjs',
    '../run-ollama-connection-live-test.mjs',
    '../run-llm-platform-benchmark.mjs',
  ];

  for (const runner of runners) {
    const source = await readFile(new URL(runner, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /packages\/sdk|DBAGENT_RUN_SDK_LIVE/u, runner);
  }

  for (const runner of [
    '../run-postgres-tests.mjs',
    '../run-multi-model-agent-live-test.mjs',
    '../run-unified-agent-live-test.mjs',
  ]) {
    const source = await readFile(new URL(runner, import.meta.url), 'utf8');
    assert.match(source, /DBAGENT_RUN_(?:AGENT|GENERAL_AGENT)_LIVE/u, runner);
  }
});

test('unified live runner owns configuration and scenario reporting while legacy scripts are thin selectors', async () => {
  const unified = await readFile(new URL('../run-unified-agent-live-test.mjs', import.meta.url), 'utf8');
  assert.match(unified, /resolveSiliconFlowLiveConfiguration/);
  assert.match(unified, /code-repair.*git-dynamic.*database-long-result/s);
  assert.match(unified, /DBAGENT_LIVE_ACCEPTANCE_SCENARIO/);
  assert.match(unified, /SCHEMANAUT_TEST_POSTGRES_URL/);
  assert.match(unified, /process\.argv\.includes\('--require'\)/u);
  assert.doesNotMatch(unified, /TEST_CAPABILITY_LIVE_MODEL|MiniMaxAI\/MiniMax-M2\.5|Qwen\/Qwen3-32B/u);
  assert.doesNotMatch(unified, /process\.argv.*API_KEY|--api-key/u);

  for (const [entrypoint, scope] of [
    ['../run-general-agent-live-test.mjs', 'code-repair'],
    ['../run-capability-runtime-live-test.mjs', 'database-long-result'],
  ]) {
    const source = await readFile(new URL(entrypoint, import.meta.url), 'utf8');
    assert.match(source, /run-unified-agent-live-test\.mjs/u, entrypoint);
    assert.match(source, new RegExp(`DBAGENT_LIVE_ACCEPTANCE_SCOPE: '${scope}'`, 'u'), entrypoint);
    assert.doesNotMatch(source, /TEST_SILICONFLOW_(?:API_KEY|BASE_URL|MODEL)/u, entrypoint);
  }
});

test('gated Host scenario test uses the bundled runtime and posterior Git/Database evidence', async () => {
  const source = await readFile(new URL('../../packages/agent-host/test/general-agent.live.integration.test.ts', import.meta.url), 'utf8');
  assert.match(source, /createBundledAgentRuntime/);
  assert.match(source, /git_stage.*git_commit.*git_status/s);
  assert.match(source, /sql_execute/);
  assert.match(source, /artifact\.created/);
  assert.match(source, /discoveryActivated/);
  assert.match(source, /DBAGENT_LIVE_ACCEPTANCE_SCENARIO/);
  assert.doesNotMatch(source, /process\.argv.*API_KEY|--api-key/u);
});

test('database analysis live scenario test uses the bundled runtime and posterior Oracle/Journal evidence', async () => {
  const source = await readFile(new URL('../../packages/agent-host/test/database-analysis.live.integration.test.ts', import.meta.url), 'utf8');
  assert.match(source, /createBundledAgentRuntime/);
  assert.match(source, /DATABASE_ANALYSIS_SCENARIOS/);
  assert.match(source, /database-commerce-analysis.*database-churn-ml.*fraud_scores\.json/s);
  assert.match(source, /fixture\.oracle/);
  assert.match(source, /SqliteAgentJournal/);
  assert.match(source, /DBAGENT_RUN_GENERAL_AGENT_LIVE/);
  assert.match(source, /DBAGENT_LIVE_ACCEPTANCE_SCENARIO/);
  assert.doesNotMatch(source, /process\.argv.*API_KEY|--api-key/u);
});
