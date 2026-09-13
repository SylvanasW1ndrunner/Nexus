import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAgentJournal } from '@dbagent/core-agent';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { afterAll, describe, expect, it } from 'vitest';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import type { AgentRunResult } from '../src/types.js';
import {
  DATABASE_ANALYSIS_SCENARIOS,
  createDatabaseAnalysisFixture,
  dropDatabaseAnalysisFixture,
  parseAnalysisResult,
  type DatabaseAnalysisFixture,
  type DatabaseAnalysisScenarioName,
  type PortableJsonObject,
  type PostgresClient as FixturePostgresClient,
} from './database-analysis-live-fixtures.js';
import { testLlmRuntimeOptions, testModelSelection } from './llm-test-fixture.js';

const runLive = process.env.DBAGENT_RUN_GENERAL_AGENT_LIVE === '1';
const requestedScenario = process.env.DBAGENT_LIVE_ACCEPTANCE_SCENARIO;
const scenario = isAnalysisScenario(requestedScenario) ? requestedScenario : undefined;
const databaseUrl = process.env.DATABASE_URL;
const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const reportPath = scenario === undefined
  ? undefined
  : fileURLToPath(new URL(`../../../reports/agent-runtime/live-${scenario}.json`, import.meta.url));
let report: Record<string, unknown> | undefined;

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
  if (!runLive || reportPath === undefined || report === undefined) return;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});

describe.skipIf(!runLive || scenario === undefined)('Agent Runtime real-model database analysis projects', () => {
  it('completes SQL and optional Python analysis with independent posterior evidence', async () => {
    if (scenario === undefined) throw new Error('A Database analysis scenario is required.');
    if (!databaseUrl) throw new Error('DATABASE_URL is required for Database analysis live scenarios.');
    const projectDirectory = await mkdtemp(join(tmpdir(), `schemanaut-${scenario}-`));
    temporaryDirectories.push(projectDirectory);
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const client = new (postgresClientConstructor())({ connectionString: databaseUrl });
    const startedAt = performance.now();
    let fixture: DatabaseAnalysisFixture | undefined;
    let runtime: ReturnType<typeof createBundledAgentRuntime> | undefined;
    let result: AgentRunResult | undefined;
    let evidence: Awaited<ReturnType<typeof journalEvidence>> | undefined;
    let analysisResult: PortableJsonObject | undefined;
    let failure: unknown;
    const cleanupFailures: string[] = [];

    try {
      await client.connect();
      fixture = await createDatabaseAnalysisFixture(client, scenario);
      runtime = await createBundledLiveRuntime(projectDirectory, stateDatabasePath, scenario);
      result = await runLiveAgent(runtime, fixture.prompt);
      evidence = await journalEvidence(runtime, stateDatabasePath, result);

      expect(result.status).toBe('completed');
      analysisResult = parseAnalysisResult(result.finalText);
      expect(evidence.discoveryActivated).toBe(true);
      expect(evidence.invocations.map(invocation => invocation.name)).toContain('tool_search');
      expect(evidence.invocations.every(invocation => invocation.state === 'observed')).toBe(true);
      expect(result.evidenceRefs.length).toBeGreaterThan(0);
      await verifyScenarioOutcome({ fixture, projectDirectory, result, analysisResult, evidence });
    } catch (error) {
      failure = error;
      if (error instanceof LiveRunDeadlineError) result = error.result;
      if (runtime !== undefined && result !== undefined && evidence === undefined) {
        evidence = await journalEvidence(runtime, stateDatabasePath, result).catch(() => undefined);
      }
    } finally {
      if (runtime !== undefined) {
        try { await runtime.close(); } catch (error) { cleanupFailures.push(errorMessage(error)); }
      }
      if (fixture !== undefined) {
        try { await dropDatabaseAnalysisFixture(client, fixture); } catch (error) { cleanupFailures.push(errorMessage(error)); }
      }
      try { await client.end(); } catch (error) { cleanupFailures.push(errorMessage(error)); }
      if (cleanupFailures.length > 0 && failure === undefined) {
        failure = new Error(`Database analysis cleanup failed: ${cleanupFailures.join('; ')}`);
      }
      report = liveAnalysisReport({
        scenario,
        startedAt,
        passed: failure === undefined,
        ...(failure === undefined ? {} : { error: errorMessage(failure) }),
        ...(fixture === undefined ? {} : { oracle: fixture.oracle }),
        ...(analysisResult === undefined ? {} : { analysisResult }),
        cleanupFailures,
        ...liveRunReportDetails(result, evidence, fixture),
      });
    }

    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(errorMessage(failure));
    }
  }, 360_000);
});

async function verifyScenarioOutcome(input: Readonly<{
  fixture: DatabaseAnalysisFixture;
  projectDirectory: string;
  result: AgentRunResult;
  analysisResult: PortableJsonObject;
  evidence: Awaited<ReturnType<typeof journalEvidence>>;
}>): Promise<void> {
  const { fixture, projectDirectory, result, analysisResult, evidence } = input;
  expect(analysisResult.scenario).toBe(fixture.scenario);
  const metrics = objectField(analysisResult, 'metrics');
  const sqlInvocations = succeededInvocations(evidence, 'sql_execute');
  const minimumSqlCalls = fixture.scenario === 'database-churn-ml' ? 1 : 2;
  expect(sqlInvocations.length).toBeGreaterThanOrEqual(minimumSqlCalls);
  for (const invocation of sqlInvocations) {
    expect(JSON.stringify(invocation.arguments)).toContain(fixture.schemaName);
    expect(invocation.terminal?.evidenceRefs.length).toBeGreaterThan(0);
  }

  if (fixture.scenario === 'database-commerce-analysis') {
    expect(evidence.invocations.map(invocation => invocation.name)).not.toContain('process_exec');
    expect(result.finalText.slice(0, result.finalText.lastIndexOf('ANALYSIS_RESULT')).trim().length)
      .toBeGreaterThan(40);
    expectPortableSubset(metrics, fixture.oracle);
    return;
  }

  const resultReads = succeededInvocations(evidence, 'result_read');
  if (fixture.scenario === 'database-churn-ml') {
    expect(resultReads).toHaveLength(1);
    const resultRead = resultReads[0]!;
    expect(resultRead.arguments).toMatchObject({ mode: 'record' });
    expect(numberArgumentOrDefault(resultRead.arguments, 'limit', 40)).toBeLessThanOrEqual(40);
    expect(objectStringField(resultRead.arguments, 'cursor')).toBeUndefined();
    const materializations = succeededInvocations(evidence, 'result_materialize');
    expect(materializations.length).toBeGreaterThanOrEqual(1);
    expect(materializations.some(materialization =>
      objectStringField(materialization.arguments, 'contentRef') === objectStringField(resultRead.arguments, 'contentRef'),
    )).toBe(true);
  }
  const patches = succeededInvocations(evidence, 'workspace_apply_patch');
  expect(patches.length).toBeGreaterThanOrEqual(fixture.expectedWorkspaceFiles?.length ?? 0);
  const processRuns = succeededInvocations(evidence, 'process_exec').filter(invocation => {
    const command = objectStringField(invocation.arguments, 'command');
    return command !== undefined && /(?:^|\s)python(?:\.exe)?(?:\s|$)/iu.test(command);
  });
  expect(processRuns.length).toBeGreaterThan(0);
  expect(processRuns.every(invocation => !/\b(?:pip|install)\b/iu.test(JSON.stringify(invocation.arguments))))
    .toBe(true);

  for (const relativePath of fixture.expectedWorkspaceFiles ?? []) {
    const path = join(projectDirectory, relativePath);
    expect((await stat(path)).isFile()).toBe(true);
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  }

  if (fixture.scenario === 'database-churn-ml') {
    const fileMetrics = await readJsonObject(join(projectDirectory, 'churn_metrics.json'));
    expect(metrics).toEqual(fileMetrics);
    const oracle = fixture.oracle;
    const accuracy = numberField(metrics, 'accuracy');
    const majorityBaseline = numberField(metrics, 'majorityBaseline');
    expect(numberField(metrics, 'sampleCount')).toBe(numberField(oracle, 'sampleCount'));
    expect(majorityBaseline).toBeCloseTo(numberField(oracle, 'majorityBaseline'), 6);
    expect(accuracy).toBeGreaterThanOrEqual(numberField(oracle, 'minimumAccuracy'));
    expect(accuracy).toBeGreaterThan(majorityBaseline);
    expectRiskFactors(metrics, stringArrayField(oracle, 'expectedRiskFactors'));
    const script = await readFile(join(projectDirectory, 'churn_analysis.py'), 'utf8');
    expect(script).toMatch(/\bjson\b/u);
    expect(script).not.toMatch(/\b(?:csv|DictReader)\b/u);
    const pythonCommand = objectStringField(processRuns[0]!.arguments, 'command');
    expect(`${script}\n${pythonCommand ?? ''}`).toContain('.schemanaut/runtime/materialized/');
    return;
  }

  const fileMetrics = await readJsonObject(join(projectDirectory, 'fraud_scores.json'));
  expect(metrics).toEqual(fileMetrics);
  expect(numberField(metrics, 'totalTransactions')).toBe(numberField(fixture.oracle, 'totalTransactions'));
  expect(numberField(metrics, 'totalChargebacks')).toBe(numberField(fixture.oracle, 'totalChargebacks'));
  expect(numberField(metrics, 'chargebackRate')).toBeCloseTo(numberField(fixture.oracle, 'chargebackRate'), 6);
  const topK = numberField(fixture.oracle, 'topK');
  const topMerchantIds = merchantIds(metrics).slice(0, topK);
  expect(topMerchantIds).toEqual(
    expect.arrayContaining(stringArrayField(fixture.oracle, 'injectedMerchantIds')),
  );
  for (const merchantId of stringArrayField(fixture.oracle, 'injectedMerchantIds')) {
    expect(result.finalText).toContain(merchantId);
  }
}

async function createBundledLiveRuntime(
  projectDirectory: string,
  stateDatabasePath: string,
  scenarioName: DatabaseAnalysisScenarioName,
) {
  const apiKey = process.env.TEST_SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('TEST_SILICONFLOW_API_KEY is required.');
  const model = process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash';
  const configPath = join(projectDirectory, '.live-global-config.toml');
  await writeFile(configPath, 'version = 1\n\n[agent]\npermission_mode = "full-access"\n', 'utf8');
  const runtime = createBundledAgentRuntime({
    projectDirectory,
    stateDatabasePath,
    ...testLlmRuntimeOptions(
      new OpenAICompatibleProvider({
        id: `bundled-live-${scenarioName}`,
        name: 'Bundled live database analysis provider',
        apiKey,
        baseUrl: process.env.TEST_SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        timeoutMs: 120_000,
        maxRetries: 2,
      }),
      model,
      { parameters: { temperature: 0 } },
    ),
    globalConfigStore: new GlobalConfigStore({ path: configPath }),
  });
  await runtime.ready();
  await runtime.discoverLlmConnection({
    connectionId: testModelSelection(model).connectionId,
    inspectModelIds: [model],
  });
  return runtime;
}

async function runLiveAgent(
  runtime: ReturnType<typeof createBundledAgentRuntime>,
  message: string,
): Promise<AgentRunResult> {
  if (scenario === undefined) throw new Error('A Database analysis scenario is required.');
  const sessionId = `live-${scenario}`;
  const handle = await runtime.startAgentRun({ message, sessionId, clientRequestId: sessionId });
  const deadlineMs = liveAgentDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        await handle.cancel(`Live analysis exceeded its ${deadlineMs}ms Agent deadline.`);
        reject(new LiveRunDeadlineError(deadlineMs, await handle.result()));
      })().catch(reject);
    }, deadlineMs);
  });
  try {
    return await Promise.race([handle.result(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function liveAgentDeadlineMs(): number {
  const configured = process.env.DBAGENT_LIVE_AGENT_DEADLINE_MS;
  if (configured === undefined) return 300_000;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error('DBAGENT_LIVE_AGENT_DEADLINE_MS must be an integer from 5000 through 300000.');
  }
  return parsed;
}

class LiveRunDeadlineError extends Error {
  constructor(readonly deadlineMs: number, readonly result: AgentRunResult) {
    super(`Agent Run exceeded the ${deadlineMs}ms live analysis deadline and was cancelled.`);
    this.name = 'LiveRunDeadlineError';
  }
}

async function journalEvidence(
  runtime: ReturnType<typeof createBundledAgentRuntime>,
  stateDatabasePath: string,
  result: AgentRunResult,
) {
  const services = requireAgentRuntimeHostServices(runtime);
  const journal = new SqliteAgentJournal({ filePath: stateDatabasePath });
  const events = await journal.readRunEvents({
    projectId: services.project.projectId,
    sessionId: result.sessionId,
    runId: result.runId,
    afterSequence: 0,
    limit: 1_000,
  });
  const invocations = await journal.listInvocations(result.runId);
  return {
    invocations,
    discoveryActivated: events.events.some(event =>
      event.type === 'runtime.command_applied' && event.payload.kind === 'discovery.activate'),
    artifactHandles: events.events.flatMap(event =>
      event.type === 'artifact.created' && event.payload.availability === 'available'
        ? [event.payload.handle]
        : []),
    timeline: events.events
      .filter(event => /^(?:run|turn|model|runtime|tool)\./u.test(event.type))
      .map(event => ({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: event.type,
        turnId: event.turnId,
        invocationId: event.invocationId,
      })),
  };
}

function succeededInvocations(
  evidence: Awaited<ReturnType<typeof journalEvidence>>,
  name: string,
) {
  return evidence.invocations.filter(invocation =>
    invocation.name === name && invocation.terminal?.kind === 'succeeded');
}

function liveAnalysisReport(input: Readonly<{
  scenario: DatabaseAnalysisScenarioName;
  startedAt: number;
  passed: boolean;
}> & Record<string, unknown>) {
  return {
    generatedAt: new Date().toISOString(),
    provider: 'SiliconFlow OpenAI-compatible',
    model: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash',
    durationMs: Math.round(performance.now() - input.startedAt),
    evidence: 'PostgreSQL Oracle, Agent Journal, workspace files, and Python process posterior checks.',
    ...input,
    startedAt: undefined,
  };
}

function liveRunReportDetails(
  result: AgentRunResult | undefined,
  evidence: Awaited<ReturnType<typeof journalEvidence>> | undefined,
  fixture: DatabaseAnalysisFixture | undefined,
): Record<string, unknown> {
  if (result === undefined) return {};
  return {
    run: {
      runId: result.runId,
      sessionId: result.sessionId,
      status: result.status,
      error: result.error,
      finalText: bounded(result.finalText, 6_000),
      deliveryStatus: result.deliveryStatus,
      evidenceRefs: result.evidenceRefs,
      schemaName: fixture?.schemaName,
      discoveryActivated: evidence?.discoveryActivated ?? false,
      artifactHandles: evidence?.artifactHandles ?? [],
      timeline: evidence?.timeline ?? [],
      tools: evidence?.invocations.map(invocation => ({
        name: invocation.name,
        arguments: reportArguments(invocation.name, invocation.arguments),
        state: invocation.state,
        terminal: invocation.terminal?.kind,
        terminalSummary: invocation.terminal?.summary,
        terminalError: invocation.terminal?.error,
        resultRefs: invocation.terminal?.resultRefs ?? [],
        evidenceRefs: invocation.terminal?.evidenceRefs ?? [],
      })) ?? [],
    },
  };
}

function isAnalysisScenario(value: string | undefined): value is DatabaseAnalysisScenarioName {
  return value !== undefined && (DATABASE_ANALYSIS_SCENARIOS as readonly string[]).includes(value);
}

function objectField(input: PortableJsonObject, name: string): PortableJsonObject {
  const value = input[name];
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Expected ${name} to be a JSON object.`);
  }
  return value as PortableJsonObject;
}

function numberField(input: PortableJsonObject, name: string): number {
  const value = input[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${name} to be a finite number.`);
  }
  return value;
}

function stringArrayField(input: PortableJsonObject, name: string): string[] {
  const value = input[name];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Expected ${name} to be an array of strings.`);
  }
  return value.map(item => {
    if (typeof item !== 'string') throw new Error(`Expected ${name} to contain only strings.`);
    return item;
  });
}

function merchantIds(metrics: PortableJsonObject): string[] {
  const value = metrics.topMerchants;
  if (!Array.isArray(value)) throw new Error('Expected topMerchants to be an array.');
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (item !== null && !Array.isArray(item) && typeof item === 'object') {
      const record = item as PortableJsonObject;
      const id = record.merchantId ?? record.merchant_id ?? record.id;
      if (typeof id === 'string') return id;
    }
    throw new Error('Each topMerchants item must identify a merchant.');
  });
}

function expectRiskFactors(metrics: PortableJsonObject, expected: readonly string[]): void {
  const riskFactors = stringArrayField(metrics, 'riskFactors').map(normalizeName);
  const hits = expected.filter(factor => {
    const words = normalizeName(factor).split('_');
    return riskFactors.some(candidate => words.every(word => candidate.includes(word)));
  });
  expect(hits.length).toBeGreaterThanOrEqual(2);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_').replaceAll(/^_+|_+$/gu, '');
}

function expectPortableSubset(actual: unknown, expected: unknown, path = 'metrics'): void {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') throw new Error(`Expected ${path} to be numeric.`);
    expect(actual).toBeCloseTo(expected, 6);
    return;
  }
  if (Array.isArray(expected)) {
    expect(actual).toEqual(expected);
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || Array.isArray(actual) || typeof actual !== 'object') {
      throw new Error(`Expected ${path} to be an object.`);
    }
    for (const [key, value] of Object.entries(expected)) {
      expectPortableSubset((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual).toBe(expected);
}

async function readJsonObject(path: string): Promise<PortableJsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as PortableJsonObject;
}

function objectStringField(value: unknown, name: string): string | undefined {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[name];
  return typeof field === 'string' ? field : undefined;
}

function numberArgument(value: unknown, name: string): number {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Expected ${name} to be a numeric tool argument.`);
  }
  const field = (value as Record<string, unknown>)[name];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Error(`Expected ${name} to be a finite numeric tool argument.`);
  }
  return field;
}

function numberArgumentOrDefault(value: unknown, name: string, fallback: number): number {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return fallback;
  return (value as Record<string, unknown>)[name] === undefined
    ? fallback
    : numberArgument(value, name);
}

function reportArguments(toolName: string, value: unknown): Record<string, unknown> | undefined {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (toolName === 'workspace_apply_patch') {
    const content = typeof input.content === 'string' ? input.content : undefined;
    return {
      action: input.action,
      path: input.path,
      ...(content === undefined ? {} : { contentBytes: Buffer.byteLength(content, 'utf8') }),
    };
  }
  if (toolName === 'sql_execute') {
    const sql = typeof input.sql === 'string' ? input.sql : undefined;
    return { ...input, ...(sql === undefined ? {} : { sql: bounded(sql, 2_000) }) };
  }
  if (toolName === 'process_exec') {
    const command = typeof input.command === 'string' ? input.command : undefined;
    return { ...input, ...(command === undefined ? {} : { command: bounded(command, 1_000) }) };
  }
  return input;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LivePostgresClient = FixturePostgresClient & Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
}>;
type PostgresClientConstructor = new (input: { connectionString: string }) => LivePostgresClient;

function postgresClientConstructor(): PostgresClientConstructor {
  const module = require('pg') as { Client?: unknown };
  if (typeof module.Client !== 'function') {
    throw new Error('The pg Client is unavailable for Database analysis live scenarios.');
  }
  return module.Client as PostgresClientConstructor;
}
