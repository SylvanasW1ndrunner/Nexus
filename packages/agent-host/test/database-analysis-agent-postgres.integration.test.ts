import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmChatRequest, LlmChatResponse, LlmProvider } from '@dbagent/core-llm';
import { SqliteAgentJournal } from '@dbagent/core-agent';
import { createEnvironmentConnectionProvider } from '@dbagent/database-capability';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import { testLlmRuntimeOptions } from './llm-test-fixture.js';
import {
  createDatabaseAnalysisFixture,
  dropDatabaseAnalysisFixture,
  parseAnalysisResult,
  type PortableJsonObject,
  type PostgresClient,
} from './database-analysis-live-fixtures.js';

const databaseUrl = process.env.SCHEMANAUT_TEST_POSTGRES_URL;
const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!databaseUrl)('Database churn analysis through the deterministic Agent and real PostgreSQL', () => {
  it('retains SQL features, reads them, writes a standard-library analysis, and runs it', async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-database-churn-agent-'));
    temporaryDirectories.push(projectDirectory);
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const configPath = join(projectDirectory, '.global-config.toml');
    await mkdir(join(projectDirectory, '.state'), { recursive: true });
    await writeFile(configPath, 'version = 1\n\n[agent]\npermission_mode = "full-access"\n', 'utf8');

    const client = new (postgresClientConstructor())({ connectionString: databaseUrl! });
    await client.connect();
    const fixture = await createDatabaseAnalysisFixture(client, 'database-churn-ml');
    const provider = new ChurnScenarioProvider(fixture.schemaName);
    const runtime = createBundledAgentRuntime({
      projectDirectory,
      stateDatabasePath,
      ...testLlmRuntimeOptions(provider),
      globalConfigStore: new GlobalConfigStore({ path: configPath }),
    }, {
      database: {
        connectionProvider: createEnvironmentConnectionProvider({ DATABASE_URL: databaseUrl }),
      },
    });
    let result: Awaited<ReturnType<Awaited<ReturnType<typeof runtime.startAgentRun>>['result']>> | undefined;
    try {
      await runtime.ready();
      const handle = await runtime.startAgentRun({
        message: fixture.prompt,
        sessionId: 'deterministic-database-churn',
        clientRequestId: 'deterministic-database-churn',
      });
      result = await resultWithin(handle, 90_000);
      const services = requireAgentRuntimeHostServices(runtime);
      const journal = new SqliteAgentJournal({ filePath: stateDatabasePath });
      const invocations = await journal.listInvocations(result.runId);
      const diagnostic = JSON.stringify({
        result: { status: result.status, error: result.error, finalText: result.finalText },
        invocations: invocations.map(invocation => ({
          name: invocation.name,
          arguments: boundedJson(invocation.arguments),
          state: invocation.state,
          terminal: invocation.terminal === undefined ? undefined : {
            kind: invocation.terminal.kind,
            summary: invocation.terminal.summary,
            resultRefs: invocation.terminal.resultRefs,
            evidenceRefs: invocation.terminal.evidenceRefs,
            modelProjection: boundedJson(invocation.terminal.modelProjection),
          },
          observation: invocation.observation === undefined ? undefined : {
            outcome: invocation.observation.outcome,
            summary: invocation.observation.summary,
            modelProjection: boundedJson(invocation.observation.modelProjection),
          },
        })),
      }, null, 2);

      expect(result.status, diagnostic).toBe('completed');
      expect(services.project.rootPath).toBe(projectDirectory);
      expect(provider.contentRefRead, diagnostic).toBe(true);
      expect(invocations.map(invocation => invocation.name), diagnostic).toEqual(expect.arrayContaining([
        'tool_search', 'sql_execute', 'result_read', 'workspace_apply_patch', 'process_exec',
      ]));
      expect(invocations.every(invocation => invocation.state === 'observed'), diagnostic).toBe(true);

      const sql = required(invocations.find(invocation => invocation.name === 'sql_execute'), 'sql_execute');
      const resultReads = invocations.filter(invocation => invocation.name === 'result_read');
      const resultRead = required(resultReads[0], 'result_read');
      const process = required(invocations.find(invocation => invocation.name === 'process_exec'), 'process_exec');
      const patches = invocations.filter(invocation => invocation.name === 'workspace_apply_patch');
      expect(sql.terminal?.kind, diagnostic).toBe('succeeded');
      expect(resultReads.length, diagnostic).toBeGreaterThan(1);
      expect(resultReads.every(read => read.terminal?.kind === 'succeeded'), diagnostic).toBe(true);
      expect(process.terminal?.kind, diagnostic).toBe('succeeded');
      expect(JSON.stringify(sql.arguments), diagnostic).toContain(fixture.schemaName);
      const sqlContentRef = contentRefFrom(sql.terminal?.modelProjection);
      expect(sqlContentRef, diagnostic).toEqual(expect.any(String));
      expect(resultRead.arguments, diagnostic).toMatchObject({ contentRef: sqlContentRef, mode: 'record' });
      expect(patches, diagnostic).toHaveLength(3);
      expect(patches.every(patch => patch.terminal?.kind === 'succeeded'), diagnostic).toBe(true);
      expect(patches.map(patch => pathArgument(patch.arguments)).sort(), diagnostic).toEqual([
        'churn_analysis.py', 'churn_features.csv', 'churn_metrics.json',
      ]);

      const [features, script, metricsText] = await Promise.all([
        readFile(join(projectDirectory, 'churn_features.csv'), 'utf8'),
        readFile(join(projectDirectory, 'churn_analysis.py'), 'utf8'),
        readFile(join(projectDirectory, 'churn_metrics.json'), 'utf8'),
      ]);
      expect(features.trim().split(/\r?\n/u)).toHaveLength(Number(fixture.oracle.sampleCount) + 1);
      expect(script).toContain('import csv');
      expect(script).toContain('import json');
      expect(script).not.toMatch(/\b(?:pip|pandas|sklearn|numpy)\b/iu);
      const metrics = parseJsonObject(metricsText, 'churn_metrics.json');
      const final = parseAnalysisResult(result.finalText);
      expect(final).toMatchObject({ scenario: 'database-churn-ml', metrics });
      expect(final.metrics).toEqual(metrics);
      expect(metrics.sampleCount).toBe(fixture.oracle.sampleCount);
      expect(numberMetric(metrics, 'accuracy')).toBeGreaterThanOrEqual(numberMetric(fixture.oracle, 'minimumAccuracy'));
      expect(numberMetric(metrics, 'accuracy')).toBeGreaterThan(numberMetric(metrics, 'majorityBaseline'));
      expect(numberMetric(metrics, 'majorityBaseline')).toBeCloseTo(numberMetric(fixture.oracle, 'majorityBaseline'), 12);
      expect(arrayMetric(metrics, 'riskFactors')).toEqual(expect.arrayContaining([...arrayMetric(fixture.oracle, 'expectedRiskFactors')]));
      expect(JSON.stringify(process.terminal?.modelProjection), diagnostic).toContain('sampleCount');
    } finally {
      await runtime.close();
      try {
        await dropDatabaseAnalysisFixture(client, fixture);
      } finally {
        await client.end();
      }
    }
  }, 120_000);
});

class ChurnScenarioProvider implements LlmProvider {
  readonly id = 'deterministic-database-churn-provider';
  readonly name = 'Deterministic database churn provider';
  readonly mode = 'byok' as const;
  readonly capabilities = { chat: 'supported' as const, toolCalling: 'supported' as const };
  contentRefRead = false;
  private call = 0;
  private awaitingResultPage = false;
  private contentRef: string | undefined;
  private readonly featureRows: Array<Record<string, unknown>> = [];
  private workspaceStep = 0;

  constructor(private readonly schemaName: string) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const step = this.nextStep(request);
    return Promise.resolve(step === undefined
      ? { text: `ANALYSIS_RESULT ${JSON.stringify({ scenario: 'database-churn-ml', metrics: churnMetrics(), sqlEvidence: { accountId: 1, plan: 'Growth' } })}`, toolCalls: [] }
      : { text: '', toolCalls: [{ id: `deterministic-churn-${this.call}`, name: step.name, arguments: step.arguments }] });
  }

  isAvailable() {
    return Promise.resolve({ available: true as const });
  }

  getModelMetadata(model: string) {
    return Promise.resolve({
      model,
      source: 'provider-declaration' as const,
      capabilities: this.capabilities,
      contextTokens: 1_000_000,
      maxInputTokens: 1_000_000,
    });
  }

  private nextStep(request: LlmChatRequest): { name: string; arguments: Record<string, unknown> } | undefined {
    const call = this.call++;
    if (call === 0) return { name: 'tool_search', arguments: { query: 'Database' } };
    if (call === 1) return { name: 'tool_search', arguments: { select: [{ name: 'database.query' }] } };
    if (call === 2) return { name: 'tool_search', arguments: { select: [{ name: 'sql_execute' }] } };
    if (call === 3) return { name: 'sql_execute', arguments: { sql: churnFeatureSql(this.schemaName), maxRows: 150, previewRows: 5 } };
    if (call === 4) {
      const contentRef = latestContentRef(request);
      this.contentRefRead = true;
      this.contentRef = contentRef;
      this.awaitingResultPage = true;
      return { name: 'result_read', arguments: { contentRef, mode: 'record', limit: 30 } };
    }
    if (this.awaitingResultPage) {
      const page = latestResultReadPage(request);
      this.featureRows.push(...page.rows);
      if (!page.eof) {
        if (page.nextCursor === undefined) throw new Error('The result_read page ended without eof or nextCursor.');
        return { name: 'result_read', arguments: { contentRef: required(this.contentRef, 'sql contentRef'), cursor: page.nextCursor, mode: 'record', limit: 30 } };
      }
      this.awaitingResultPage = false;
    }
    if (this.workspaceStep === 0) {
      this.workspaceStep += 1;
      return { name: 'workspace_apply_patch', arguments: { action: 'create', path: 'churn_features.csv', content: churnCsv(this.featureRows) } };
    }
    if (this.workspaceStep === 1) {
      this.workspaceStep += 1;
      return { name: 'workspace_apply_patch', arguments: { action: 'create', path: 'churn_analysis.py', content: churnScript() } };
    }
    if (this.workspaceStep === 2) {
      this.workspaceStep += 1;
      return { name: 'workspace_apply_patch', arguments: { action: 'create', path: 'churn_metrics.json', content: '{}\n' } };
    }
    if (this.workspaceStep === 3) {
      this.workspaceStep += 1;
      return { name: 'process_exec', arguments: { command: 'python churn_analysis.py', cwd: '.' } };
    }
    return undefined;
  }
}

function churnFeatureSql(schemaName: string): string {
  const schema = `"${schemaName.replaceAll('"', '""')}"`;
  return `WITH usage_features AS (
    SELECT account_id,
      SUM(active_events) FILTER (WHERE usage_date >= DATE '2025-06-16') AS recent_usage,
      SUM(active_events) FILTER (WHERE usage_date < DATE '2025-06-16') AS prior_usage
    FROM ${schema}."usage_daily"
    GROUP BY account_id
  ), ticket_features AS (
    SELECT account_id, COUNT(*) AS support_tickets
    FROM ${schema}."support_tickets"
    GROUP BY account_id
  )
  SELECT a.account_id AS id, (s.status = 'cancelled') AS churn,
    (DATE '2025-06-30' - a.created_at) AS tenure,
    COALESCE(u.recent_usage, 0)::integer AS recent,
    COALESCE(u.prior_usage, 0)::integer AS prior,
    COALESCE(t.support_tickets, 0)::integer AS tickets,
    a.plan AS p
  FROM ${schema}."accounts" a
  JOIN ${schema}."subscriptions" s ON s.account_id = a.account_id
  LEFT JOIN usage_features u ON u.account_id = a.account_id
  LEFT JOIN ticket_features t ON t.account_id = a.account_id
  ORDER BY a.account_id`;
}

function latestContentRef(request: LlmChatRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const contentRef = contentRefFrom(parseJson(message.content));
    if (contentRef !== undefined) return contentRef;
  }
  throw new Error('The real sql_execute observation did not contain a Runtime contentRef.');
}

function latestResultReadPage(request: LlmChatRequest): ResultReadPage {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const page = resultReadPageFromProjection(parseJson(message.content));
    if (page !== undefined) return page;
  }
  throw new Error('The real result_read observation did not expose its Runtime projection preview.');
}

type ResultReadPage = Readonly<{
  rows: readonly Record<string, unknown>[];
  eof: boolean;
  nextCursor?: string;
}>;

function resultReadPageFromProjection(value: unknown): ResultReadPage | undefined {
  if (!isRecord(value)) return undefined;
  const preview = value.preview;
  if (typeof preview !== 'string') return undefined;
  const payload = parseJson(preview);
  if (!isRecord(payload)) throw new Error('result_read Runtime preview is not a JSON object.');
  const data = payload.data;
  if (!Array.isArray(data)) return undefined;
  const rows = data.flatMap(item => {
    if (!isRecord(item)) return [];
    const row = item.row;
    return isRecord(row) ? [row] : [];
  });
  if (typeof payload.eof !== 'boolean') throw new Error('result_read payload is missing eof.');
  const nextCursor = payload.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== 'string') throw new Error('result_read nextCursor is invalid.');
  return { rows, eof: payload.eof, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function churnCsv(rows: readonly Record<string, unknown>[]): string {
  const columns = [
    ['account_id', 'id'], ['churned', 'churn'], ['tenure_days', 'tenure'],
    ['recent_usage', 'recent'], ['prior_usage', 'prior'], ['support_tickets', 'tickets'],
  ] as const;
  if (rows.length !== 150) throw new Error(`Expected 150 account-level SQL feature rows, received ${rows.length}.`);
  return `${columns.map(([csvColumn]) => csvColumn).join(',')}\n${rows.map(row => columns.map(([, resultColumn]) => csvCell(row[resultColumn])).join(',')).join('\n')}\n`;
}

function csvCell(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  throw new Error('The SQL feature row contains an unsupported CSV value.');
}

function churnScript(): string {
  return `import csv
import json

with open('churn_features.csv', newline='', encoding='utf-8') as source:
    rows = list(csv.DictReader(source))

predictions = []
labels = []
for row in rows:
    recent = int(row['recent_usage'])
    prior = int(row['prior_usage'])
    tickets = int(row['support_tickets'])
    tenure = int(row['tenure_days'])
    prediction = (prior - recent >= 80 and tickets >= 2 and tenure < 100)
    predictions.append(prediction)
    labels.append(row['churned'].lower() == 'true')

sample_count = len(rows)
accuracy = sum(prediction == label for prediction, label in zip(predictions, labels)) / sample_count
majority_baseline = max(sum(labels), sample_count - sum(labels)) / sample_count
metrics = {
    'sampleCount': sample_count,
    'accuracy': accuracy,
    'majorityBaseline': majority_baseline,
    'riskFactors': ['usage_drop', 'support_tickets', 'short_tenure'],
}
with open('churn_metrics.json', 'w', encoding='utf-8') as target:
    json.dump(metrics, target, sort_keys=True)
print(json.dumps(metrics, sort_keys=True))
`;
}

function churnMetrics(): PortableJsonObject {
  return {
    sampleCount: 150,
    accuracy: 1,
    majorityBaseline: 100 / 150,
    riskFactors: ['usage_drop', 'support_tickets', 'short_tenure'],
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function boundedJson(value: unknown, limit = 1_200): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentRefFrom(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contentRef = (value as Record<string, unknown>).contentRef;
  return typeof contentRef === 'string' ? contentRef : undefined;
}

function parseJsonObject(text: string, label: string): PortableJsonObject {
  const parsed = parseJson(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as PortableJsonObject;
}

function numberMetric(metrics: PortableJsonObject, name: string): number {
  const value = metrics[name];
  if (typeof value !== 'number') throw new Error(`${name} must be numeric.`);
  return value;
}

function arrayMetric(metrics: PortableJsonObject, name: string): readonly string[] {
  const value = metrics[name];
  if (!Array.isArray(value)) throw new Error(`${name} must be a string array.`);
  return value.map((item): string => {
    if (typeof item !== 'string') throw new Error(`${name} must be a string array.`);
    return item;
  });
}

function pathArgument(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).path !== 'string') {
    throw new Error('workspace_apply_patch is missing a path argument.');
  }
  return (value as Record<string, unknown>).path as string;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is unavailable.`);
  return value;
}

async function resultWithin(
  handle: Awaited<ReturnType<ReturnType<typeof createBundledAgentRuntime>['startAgentRun']>>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void handle.cancel(`Deterministic churn Agent scenario exceeded ${timeoutMs}ms.`)
            .then(() => handle.result())
            .then(result => reject(new Error(`Agent timed out with status ${result.status}.`)))
            .catch(reject);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type PostgresClientConstructor = new (input: { connectionString: string }) => PostgresClient & Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
}>;

function postgresClientConstructor(): PostgresClientConstructor {
  const module = require('pg') as { Client?: PostgresClientConstructor };
  if (module.Client === undefined) throw new Error('The pg Client constructor is unavailable.');
  return module.Client;
}
