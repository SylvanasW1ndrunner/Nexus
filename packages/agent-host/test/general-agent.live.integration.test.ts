import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SqliteAgentJournal,
  agentProjectReference,
  agentProjectStorageIdentity,
  createAgentProjectContext,
} from '@dbagent/core-agent';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { afterAll, describe, expect, it } from 'vitest';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import { type AgentRunResult, type UserActivityEvent } from '../src/types.js';
import { testLlmRuntimeOptions, testModelSelection } from './llm-test-fixture.js';

const runLive = process.env.DBAGENT_RUN_GENERAL_AGENT_LIVE === '1';
const scenario = process.env.DBAGENT_LIVE_ACCEPTANCE_SCENARIO ?? 'code-repair';
const temporaryDirectories: string[] = [];
const reportPath = fileURLToPath(
  new URL(`../../../reports/agent-runtime/live-${scenario}.json`, import.meta.url),
);
const require = createRequire(import.meta.url);
let report: Record<string, unknown> | undefined;

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  if (!runLive || !report) return;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});

describe.skipIf(!runLive)('Agent Runtime real-model acceptance scenarios', () => {
  it.skipIf(scenario !== 'code-repair')('discovers project tools, patches code, runs a real test process, and delivers evidence', async () => {
    const apiKey = process.env.TEST_SILICONFLOW_API_KEY;
    if (!apiKey) throw new Error('需要 TEST_SILICONFLOW_API_KEY。');
    const model = process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash';
    const projectDirectory = await createBrokenProject();
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const host = await createBundledLiveRuntime(projectDirectory, stateDatabasePath);
    const startedAt = performance.now();
    let output: AgentRunResult | undefined;
    let activities: UserActivityEvent[] = [];
    let toolEvidence: Array<{
      name: string;
      state: string;
      terminal: string | undefined;
      evidenceRefs: string[];
    }> = [];
    let modelTurnCount = 0;
    let tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let failure: unknown;
    try {
      const handle = await host.startAgentRun({
        message:
          '这个项目的 src/calculate.mjs 有测试失败。请定位并实际修复代码，运行项目测试完成验证，最后说明修改内容和测试结果；不要只给建议。',
      });
      [output, activities] = await Promise.all([
        handle.result(),
        collectActivities(handle.events()),
      ]);
      if (output === undefined) throw new Error('The Agent Run did not produce a result.');
      const durationMs = Math.round(performance.now() - startedAt);
      const source = await readFile(join(projectDirectory, 'src', 'calculate.mjs'), 'utf8');
      const journal = new SqliteAgentJournal({ filePath: stateDatabasePath });
      const projectId = agentProjectStorageIdentity(
        agentProjectReference(createAgentProjectContext(projectDirectory)),
      ).projectKey;
      const rawEvents = await journal.readRunEvents({
        projectId,
        sessionId: output.sessionId,
        runId: output.runId,
        afterSequence: 0,
        limit: 1_000,
      });
      const invocations = await journal.listInvocations(output.runId);
      toolEvidence = invocations.map((invocation) => ({
        name: invocation.name,
        state: invocation.state,
        terminal: invocation.terminal?.kind,
        evidenceRefs: [...(invocation.terminal?.evidenceRefs ?? [])],
      }));
      modelTurnCount = rawEvents.events.filter(
        (event) => event.type === 'model_attempt_committed',
      ).length;
      const usage = await host.usage();
      tokenUsage = {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      };
      const process = [...invocations].reverse().find(
        (invocation) => invocation.name === 'process_exec' &&
          invocation.terminal?.kind === 'succeeded' &&
          isProjectTestCommand(invocation.arguments),
      );

      expect(output.status).toBe('completed');
      expect(output.deliveryStatus).toBe('not-required');
      expect(source).toContain('left + right');
      expect(process, '模型没有通过真实进程运行项目测试').toBeDefined();
      expect(toolEvidence.some((tool) => /sql|knowledge/i.test(tool.name))).toBe(false);
      expect(modelTurnCount).toBeLessThanOrEqual(15);
      expect(tokenUsage.totalTokens).toBeLessThanOrEqual(180_000);
      expect(durationMs).toBeLessThanOrEqual(300_000);
      expect(isProcessOnlyFinalText(output.finalText)).toBe(false);
      expect(activities.at(-1)).toMatchObject({ kind: 'final', phase: 'succeeded' });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      report = {
        generatedAt: new Date().toISOString(),
        runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
        provider: 'SiliconFlow OpenAI-compatible',
        model,
        passed: failure === undefined,
        durationMs,
        ...(failure === undefined ? {} : { error: errorMessage(failure) }),
        ...(output === undefined
          ? {}
          : {
              run: {
                runId: output.runId,
                sessionId: output.sessionId,
                status: output.status,
                modelTurnCount,
                tokenUsage,
                tools: toolEvidence,
                evidenceRefs: output.evidenceRefs,
                deliveryStatus: output.deliveryStatus,
                finalText: bounded(output.finalText, 4_000),
                userActivities: activities.map((activity) => ({
                  sourceSequence: activity.sourceSequence,
                  kind: activity.kind,
                  phase: activity.phase,
                  summary: bounded(activity.summary, 500),
                  evidenceRefs: activity.evidenceRefs ?? [],
                })),
              },
            }),
      };
      await host.close();
    }
  }, 360_000);

  it.skipIf(scenario !== 'git-dynamic')('activates the bundled Git Capability and proves its commit externally', async () => {
    const projectDirectory = await createGitProject();
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const startedAt = performance.now();
    let runtime: ReturnType<typeof createBundledAgentRuntime> | undefined;
    let result: AgentRunResult | undefined;
    let evidence: Awaited<ReturnType<typeof journalEvidence>> | undefined;
    let failure: unknown;
    try {
      runtime = await createBundledLiveRuntime(projectDirectory, stateDatabasePath);
      result = await runLiveAgent(
        runtime,
        'The untracked file agent-live-git.txt already exists with the required content; do not recreate or edit it. Use tool_search to query for Git, then call tool_search again with select to activate the matched Git Capability. Use only git_stage, git_commit, and git_status for the remaining work: commit only agent-live-git.txt with message "live: verify bundled git capability", then confirm the completed commit with git_status. Do not use process_exec for any Git operation. Finish only after git_status succeeds.',
        'live-git-dynamic',
      );
      evidence = await journalEvidence(runtime, stateDatabasePath, result);
      expect(result.status).toBe('completed');
      expect(await readFile(join(projectDirectory, 'agent-live-git.txt'), 'utf8')).toBe('bundled Git capability verified\n');
      expect(await runCommand('git', ['log', '-1', '--format=%s'], projectDirectory)).toBe('live: verify bundled git capability\n');
      expect(evidence.invocations.map(invocation => invocation.name)).toEqual(expect.arrayContaining([
        'tool_search', 'git_stage', 'git_commit', 'git_status',
      ]));
      expect(evidence.invocations.map(invocation => invocation.name)).not.toContain('process_exec');
      expect(evidence.discoveryActivated).toBe(true);
      expect(evidence.invocations.every(invocation => invocation.state === 'observed')).toBe(true);
      report = liveReport('git-dynamic', startedAt, true, 'Git commit, deferred tool_search activation, and Journal invocations matched.');
    } catch (error) {
      failure = error;
      result ??= timedOutRunResult(error);
      throw error;
    } finally {
      if (failure !== undefined) {
        if (runtime !== undefined && result !== undefined && evidence === undefined) {
          evidence = await journalEvidence(runtime, stateDatabasePath, result).catch(() => undefined);
        }
        report = liveReport(
          'git-dynamic', startedAt, false, errorMessage(failure),
          liveRunReportDetails(result, evidence),
        );
      }
      if (runtime !== undefined) await runtime.close();
    }
  }, 360_000);

  it.skipIf(scenario !== 'database-long-result')('activates the bundled Database Capability and proves a long query result externally', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for the Database/long-result live scenario.');
    const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-database-live-'));
    temporaryDirectories.push(projectDirectory);
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const tableName = `live_acceptance_${crypto.randomUUID().replaceAll('-', '')}`;
    const startedAt = performance.now();
    let runtime: ReturnType<typeof createBundledAgentRuntime> | undefined;
    let client: PostgresClient | undefined;
    let result: AgentRunResult | undefined;
    let evidence: Awaited<ReturnType<typeof journalEvidence>> | undefined;
    let failure: unknown;
    try {
      client = new (postgresClientConstructor())({ connectionString: databaseUrl });
      await client.connect();
      await client.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, payload text NOT NULL)`);
      await client.query(`INSERT INTO ${tableName} (id, payload) SELECT value, repeat('x', 2048) FROM generate_series(1, 300) AS value`);
      runtime = await createBundledLiveRuntime(projectDirectory, stateDatabasePath);
      result = await runLiveAgent(
        runtime,
        `Use tool_search to query for Database, then call tool_search again with select to activate the matched Database Capability or sql_execute tool. Use sql_execute exactly once, never process_exec, to run SELECT id, payload FROM ${tableName} ORDER BY id with maxRows 300. Use the returned result handle if needed. Report the row count only after the query succeeds.`,
        'live-database-long-result',
      );
      evidence = await journalEvidence(runtime, stateDatabasePath, result);
      const count = await client.query(`SELECT count(*)::text AS count FROM ${tableName}`);
      expect(result.status).toBe('completed');
      expect(count.rows[0]?.count).toBe('300');
      const sql = evidence.invocations.find(invocation => invocation.name === 'sql_execute');
      expect(sql).toBeDefined();
      expect(JSON.stringify(sql?.arguments)).toContain(tableName);
      expect(evidence.invocations.map(invocation => invocation.name)).toContain('tool_search');
      expect(evidence.discoveryActivated).toBe(true);
      expect(evidence.artifactHandles.length).toBeGreaterThan(0);
      expect(sql?.terminal?.resultRefs).toEqual(expect.arrayContaining(evidence.artifactHandles));
      expect(sql?.terminal?.evidenceRefs.length).toBeGreaterThan(0);
      expect(result.evidenceRefs).toEqual(expect.arrayContaining(sql?.terminal?.evidenceRefs ?? []));
      report = liveReport('database-long-result', startedAt, true, 'Independent PostgreSQL query, sql_execute invocation, result Artifact, and Journal evidence matched.');
    } catch (error) {
      failure = error;
      result ??= timedOutRunResult(error);
      throw error;
    } finally {
      if (failure !== undefined && runtime !== undefined && result !== undefined && evidence === undefined) {
        evidence = await journalEvidence(runtime, stateDatabasePath, result).catch(() => undefined);
      }
      if (runtime !== undefined) await runtime.close();
      if (client !== undefined) {
        try { await client.query(`DROP TABLE IF EXISTS ${tableName}`); } finally { await client.end(); }
      }
      if (failure !== undefined) {
        report = liveReport(
          'database-long-result', startedAt, false, errorMessage(failure),
          liveRunReportDetails(result, evidence),
        );
      }
    }
  }, 360_000);
});

async function createBrokenProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-general-live-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(
    join(directory, 'AGENTS.md'),
    [
      '# Project instructions',
      'Use the existing Node.js test command as the completion check.',
      'Make the smallest code change that satisfies the test.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'schemanaut-live-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node test.mjs' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(directory, 'src', 'calculate.mjs'),
    'export function add(left, right) {\n  return left - right;\n}\n',
    'utf8',
  );
  await writeFile(
    join(directory, 'test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from './src/calculate.mjs';",
      'assert.equal(add(7, 5), 12);',
      "process.stdout.write('tests passed\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
  return directory;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessOnlyFinalText(text: string): boolean {
  return /(?:let me|i(?:'ll| will)|让我|我来|接下来|下一步|正在).{0,60}(?:verify|check|验证|检查|继续|确认)/i.test(
    text,
  );
}

async function collectActivities(
  source: AsyncIterable<UserActivityEvent>,
): Promise<UserActivityEvent[]> {
  const activities: UserActivityEvent[] = [];
  for await (const activity of source) activities.push(activity);
  return activities;
}

async function createBundledLiveRuntime(projectDirectory: string, stateDatabasePath: string) {
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
        id: `bundled-live-${scenario}`,
        name: 'Bundled live provider',
        apiKey,
        baseUrl: process.env.TEST_SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        timeoutMs: 120_000,
        maxRetries: 2,
      }),
      model,
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
  sessionId: string,
): Promise<AgentRunResult> {
  const handle = await runtime.startAgentRun({ message, sessionId, clientRequestId: sessionId });
  const deadlineMs = liveAgentDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        await handle.cancel(`Live acceptance scenario exceeded its ${deadlineMs}ms Agent deadline.`);
        reject(new LiveRunDeadlineError(await handle.result()));
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
  if (configured === undefined) return 180_000;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error('DBAGENT_LIVE_AGENT_DEADLINE_MS must be an integer from 5000 through 300000.');
  }
  return parsed;
}

class LiveRunDeadlineError extends Error {
  constructor(readonly result: AgentRunResult) {
    super('Agent Run exceeded the 180 second live acceptance deadline and was cancelled.');
    this.name = 'LiveRunDeadlineError';
  }
}

function timedOutRunResult(error: unknown): AgentRunResult | undefined {
  return error instanceof LiveRunDeadlineError ? error.result : undefined;
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
  const discoveryActivated = events.events.some((event) =>
    event.type === 'runtime.command_applied' && event.payload.kind === 'discovery.activate',
  );
  const artifactHandles = events.events.flatMap((event) =>
    event.type === 'artifact.created' && event.payload.availability === 'available'
      ? [event.payload.handle]
      : [],
  );
  const deliveryDecisions = events.events.flatMap((event) =>
    event.type === 'delivery.decided'
      ? [{
          outcome: event.payload.outcome,
          reason: event.payload.reason,
          verifierId: event.payload.verifierId,
          observation: event.payload.observation,
        }]
      : [],
  );
  const turnTools = events.events.flatMap((event) => event.type === 'turn.started'
    ? [{
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        turnId: event.turnId,
        tools: modelToolNames(event.payload.snapshot),
      }]
    : []);
  const diagnosticEventTypes = new Set([
    'run.started', 'run.cancel_requested', 'run.completed', 'run.failed', 'run.cancelled',
    'turn.started', 'turn.closed', 'model_attempt_started', 'model_attempt_committed',
    'model_attempt_discarded', 'model_failed', 'runtime.command_applied', 'tool.proposed',
    'tool.started', 'tool.succeeded', 'tool.failed', 'tool.cancelled', 'tool.unknown', 'tool.observed',
  ]);
  const timeline = events.events
    .filter((event) => diagnosticEventTypes.has(event.type))
    .map((event) => ({
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      turnId: event.turnId,
      invocationId: event.invocationId,
    }));
  return {
    invocations, artifactHandles, discoveryActivated, deliveryDecisions, turnTools, timeline,
  };
}

function modelToolNames(snapshot: unknown): string[] {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const tools = (snapshot as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return [];
    const name = (tool as Record<string, unknown>).name;
    return typeof name === 'string' ? [name] : [];
  }).slice(0, 128);
}

async function createGitProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-git-live-'));
  temporaryDirectories.push(directory);
  await runCommand('git', ['init'], directory);
  await runCommand('git', ['config', 'user.email', 'live@example.test'], directory);
  await runCommand('git', ['config', 'user.name', 'SchemaNaut Live'], directory);
  await writeFile(join(directory, 'README.md'), '# bundled live Git fixture\n', 'utf8');
  await runCommand('git', ['add', 'README.md'], directory);
  await runCommand('git', ['commit', '-m', 'initial fixture'], directory);
  await writeFile(
    join(directory, 'agent-live-git.txt'),
    'bundled Git capability verified\n',
    'utf8',
  );
  return directory;
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}.`));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed with exit code ${code ?? 1}: ${stderr}`));
    });
  });
}

function liveReport(
  scenarioName: string,
  startedAt: number,
  passed: boolean,
  evidence: string,
  details: Record<string, unknown> = {},
) {
  return {
    generatedAt: new Date().toISOString(),
    scenario: scenarioName,
    provider: 'SiliconFlow OpenAI-compatible',
    model: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash',
    passed,
    durationMs: Math.round(performance.now() - startedAt),
    evidence,
    ...details,
  };
}

function liveRunReportDetails(
  result: AgentRunResult | undefined,
  evidence: Awaited<ReturnType<typeof journalEvidence>> | undefined,
): Record<string, unknown> {
  if (result === undefined) return {};
  return {
    run: {
      runId: result.runId,
      sessionId: result.sessionId,
      status: result.status,
      error: result.error,
      finalText: bounded(result.finalText, 4_000),
      deliveryStatus: result.deliveryStatus,
      evidenceRefs: result.evidenceRefs,
      discoveryActivated: evidence?.discoveryActivated ?? false,
      artifactHandles: evidence?.artifactHandles ?? [],
      deliveryDecisions: evidence?.deliveryDecisions ?? [],
      turnTools: evidence?.turnTools ?? [],
      timeline: evidence?.timeline ?? [],
      tools: evidence?.invocations.map((invocation) => ({
        name: invocation.name,
        arguments: invocation.arguments,
        state: invocation.state,
        terminal: invocation.terminal?.kind,
        terminalSummary: invocation.terminal?.summary,
        terminalError: invocation.terminal?.error,
      })) ?? [],
    },
  };
}

function isProjectTestCommand(argumentsValue: unknown): boolean {
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return false;
  }
  const command = (argumentsValue as Record<string, unknown>).command;
  return typeof command === 'string' &&
    /(?:^|\s)(?:(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?test\b|node(?:\.exe)?\s+(?:\.\/?|\.\\)?test\.mjs\b)/iu.test(command);
}

type PostgresQueryResult = Readonly<{ rows: readonly { count?: string }[] }>;
type PostgresClient = Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<PostgresQueryResult>;
}>;
type PostgresClientConstructor = new (input: { connectionString: string }) => PostgresClient;

function postgresClientConstructor(): PostgresClientConstructor {
  const module = require('pg') as { Client?: unknown };
  if (typeof module.Client !== 'function') throw new Error('The pg Client is unavailable for the Database/long-result live scenario.');
  return module.Client as PostgresClientConstructor;
}
