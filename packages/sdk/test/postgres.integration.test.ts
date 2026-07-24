import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const runLiveModel = process.env.DBAGENT_RUN_SDK_LIVE === '1';
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!runPostgresTests)('DatabaseAgentRuntime real PostgreSQL AI SQL Agent', () => {
  it('retrieves related English schema, explains and executes a complex window query', async () => {
    const sql = `
      WITH ranked_orders AS (
        SELECT
          u.city,
          o.order_no,
          o.total_amount - o.refunded_amount AS net_revenue,
          row_number() OVER (
            PARTITION BY u.city
            ORDER BY o.total_amount - o.refunded_amount DESC, o.id
          ) AS revenue_rank
        FROM public.orders o
        JOIN public.users u ON u.id = o.user_id
        WHERE o.status IN ('paid', 'refunded')
      )
      SELECT
        city,
        count(*)::bigint AS order_count,
        sum(net_revenue)::numeric(14, 2) AS net_revenue,
        max(net_revenue) FILTER (WHERE revenue_rank = 1)::numeric(14, 2)
          AS top_order_revenue
      FROM ranked_orders
      GROUP BY city
      ORDER BY net_revenue DESC, city
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('knowledge', 'knowledge_search', {
        query: 'public.orders public.users 用户 城市 订单',
        limit: 20,
        expandHops: 2,
      }),
      toolCall('explain', 'sql_explain', { sql }),
      toolCall('execute', 'sql_execute', { sql, previewRows: 20 }),
      finalAnswer('上海净收入 1726.50，北京 2000.00，深圳 799.00。'),
    ]);
    const runtime = await connectedRuntime(provider, 'english-agent');

    try {
      const index = await runtime.indexSchema();
      expect(index).toMatchObject({
        ready: true,
      });
      expect(typeof index.tableCount).toBe('number');
      expect(typeof index.columnCount).toBe('number');
      expect(index.tableCount).toBeGreaterThanOrEqual(10);
      expect(index.columnCount).toBeGreaterThanOrEqual(40);
      const databaseMetricsBefore = runtime.database.metrics();
      const llmMetricsBefore = runtime.llmMetrics();
      expect(databaseMetricsBefore.discoveryPages).toBeGreaterThan(0);
      expect(databaseMetricsBefore.resources).toBeGreaterThan(0);
      expect(
        runtime.resources.query({ kinds: ['table'], limit: 500 }).items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ canonicalName: 'public.orders' }),
          expect.objectContaining({ canonicalName: 'public.users' }),
        ]),
      );

      const output = await runtime.runAgent({
        userId: 'integration-user',
        message: '统计每个城市已支付或退款订单的净收入、订单数和最大单笔净收入。',
        mode: 'read',
      });

      expect(output.selectedSkill).toBe('query-and-answer');
      expect(output.result.status).toBe('done');
      expect(output.result.toolExecutions.map((item) => item.toolName)).toEqual([
        'knowledge_search',
        'sql_explain',
        'sql_execute',
      ]);
      expect(output.result.toolExecutions.every((item) => item.status === 'success')).toBe(true);
      const searchPreview = output.result.toolExecutions[0]!.resultPreview;
      expect(searchPreview).toContain('public.orders');
      expect(searchPreview).toContain('public.users');
      const executionPreview = output.result.toolExecutions[2]!.resultPreview;
      expect(executionPreview).toContain('Shanghai');
      expect(executionPreview).toContain('Beijing');
      expect(executionPreview).toContain('Shenzhen');
      expect(executionPreview).toContain('1726.50');
      expect(
        output.result.session.knowledgeSnapshot?.knowledgeSnapshotId,
      ).toMatch(/^knowledge:/);
      expect(
        typeof output.result.session.knowledgeSnapshot?.catalogRootHash,
      ).toBe('string');
      expect(
        typeof output.result.session.knowledgeSnapshot?.retrievalProfileId,
      ).toBe('string');
      expect(provider.requests).toHaveLength(4);
      expectModelRequestsToExcludeKnowledgeInternals(provider.requests, [
        runtime.status().connection!.id,
      ]);
      const databaseMetricsAfter = runtime.database.metrics();
      const llmMetricsAfter = runtime.llmMetrics();
      const queryAudit = runtime.database
        .listAuditEvents({ limit: 50 })
        .filter((event) => event.action === 'database.query.submit');
      expect(
        databaseMetricsAfter.submittedQueries -
          databaseMetricsBefore.submittedQueries,
      ).toBe(2);
      expect(queryAudit).toHaveLength(2);
      expect(queryAudit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'succeeded',
            authorization: {
              actorId: 'integration-user',
              permissionMode: 'all-writes-approved',
            },
          }),
        ]),
      );
      expect(llmMetricsAfter.requests - llmMetricsBefore.requests).toBe(4);
      expect(llmMetricsAfter.completed - llmMetricsBefore.completed).toBe(4);
      expect(llmMetricsAfter.totalPromptTokens).toBeGreaterThan(
        llmMetricsBefore.totalPromptTokens,
      );
      await printAgentScenarioLog(
        'real-postgres-complex-english',
        output,
        provider.requests,
        {
          llmGateway: {
            requests:
              llmMetricsAfter.requests - llmMetricsBefore.requests,
            completed:
              llmMetricsAfter.completed - llmMetricsBefore.completed,
            promptTokens:
              llmMetricsAfter.totalPromptTokens -
              llmMetricsBefore.totalPromptTokens,
            completionTokens:
              llmMetricsAfter.totalCompletionTokens -
              llmMetricsBefore.totalCompletionTokens,
          },
          databaseAccess: {
            discoveryPages: databaseMetricsAfter.discoveryPages,
            submittedQueries:
              databaseMetricsAfter.submittedQueries -
              databaseMetricsBefore.submittedQueries,
            successfulQueryAudits: queryAudit.filter(
              (event) => event.status === 'succeeded',
            ).length,
          },
          resourceState: {
            resources: databaseMetricsAfter.resources,
            relations: databaseMetricsAfter.relations,
          },
          publicContracts: {
            connectionProfile: 'validated by DatabaseAccessRuntime',
            discoveredResources: 'validated by ResourceRegistry',
            querySubmissions: 'validated by DatabaseAccessRuntime',
          },
        },
      );
    } finally {
      await runtime.close();
    }
  });

  it('retrieves and executes SQL across Chinese schema, table and column identifiers', async () => {
    const sql = `
      WITH 供应商采购 AS (
        SELECT
          s."所在省份" AS 省份,
          s."供应商名称" AS 供应商,
          p."采购单号" AS 采购单号,
          p."含税金额" AS 含税金额,
          p."扩展信息" ->> '交付方式' AS 交付方式
        FROM "供应链"."采购订单" p
        JOIN "供应链"."供应商" s
          ON s."供应商ID" = p."供应商ID"
      )
      SELECT
        省份,
        count(DISTINCT 供应商)::bigint AS 供应商数,
        count(*)::bigint AS 采购单数,
        sum(含税金额)::numeric(14, 2) AS 采购总额,
        string_agg(DISTINCT 交付方式, ',' ORDER BY 交付方式) AS 交付方式
      FROM 供应商采购
      GROUP BY 省份
      ORDER BY 采购总额 DESC
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('knowledge-cn', 'knowledge_search', {
        query: '供应链 采购订单 供应商 所在省份 含税金额 扩展信息 交付方式',
        limit: 24,
        expandHops: 2,
      }),
      toolCall('execute-cn', 'sql_execute', { sql, previewRows: 20 }),
      finalAnswer('江苏采购总额 56000.00，广东采购总额 18000.00。'),
    ]);
    const runtime = await connectedRuntime(provider, 'chinese-agent');

    try {
      await runtime.indexSchema();
      const output = await runtime.runAgent({
        userId: 'integration-user',
        message: '按供应商所在省份统计采购单数、供应商数、采购总额和支付方式。',
        mode: 'read',
      });

      expect(output.result.status).toBe('done');
      expect(output.result.toolExecutions.map((item) => item.toolName)).toEqual([
        'knowledge_search',
        'sql_execute',
      ]);
      const searchPreview = output.result.toolExecutions[0]!.resultPreview;
      expect(searchPreview).toContain('供应链');
      expect(searchPreview).toContain('采购订单');
      expect(searchPreview).toContain('供应商');
      const executionPreview = output.result.toolExecutions[1]!.resultPreview;
      expect(executionPreview).toContain('江苏');
      expect(executionPreview).toContain('广东');
      expect(executionPreview).toContain('56000.00');
      expect(executionPreview).toContain('公路');
      expect(executionPreview).toContain('铁路');
    } finally {
      await runtime.close();
    }
  });

  it('refreshes the Merkle knowledge snapshot after Agent DDL and finds the new table', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const tableName = `agent_refresh_probe_${suffix}`;
    const ddl = `
      CREATE TABLE analytics.${tableName} (
        metric_id bigserial PRIMARY KEY,
        "指标名称" text NOT NULL,
        measured_at timestamptz NOT NULL DEFAULT now(),
        metric_value numeric(18, 4) NOT NULL,
        labels jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      COMMENT ON TABLE analytics.${tableName} IS 'Agent Schema 自动刷新验证表'
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('ddl', 'sql_execute', { sql: ddl }),
      finalAnswer('验证表已经创建，知识目录已刷新。'),
      toolCall('find-new-table', 'knowledge_search', {
        query: `analytics.${tableName} 指标名称 metric_value labels`,
        limit: 12,
      }),
      finalAnswer('已经在最新知识目录中找到验证表。'),
    ]);
    const runtime = await connectedRuntime(provider, 'ddl-agent');

    try {
      const before = await runtime.indexSchema();
      const createRun = await runtime.runAgent({
        userId: 'integration-user',
        message: `请创建 analytics.${tableName} 指标表并验证结构。`,
        mode: 'full',
      });
      expect(createRun.result.status).toBe('done');
      expect(createRun.result.toolExecutions).toEqual([
        expect.objectContaining({
          toolName: 'sql_execute',
          status: 'success',
        }),
      ]);
      expect(createRun.result.toolExecutions[0]).not.toHaveProperty('approval');
      const after = runtime.schemaStatus();
      expect(after.tableCount).toBe(before.tableCount + 1);

      const searchRun = await runtime.runAgent({
        userId: 'integration-user',
        message: `查询刚创建的 analytics.${tableName} 表结构。`,
        mode: 'read',
      });
      expect(searchRun.result.status).toBe('done');
      expect(searchRun.result.toolExecutions[0]).toMatchObject({
        toolName: 'knowledge_search',
        status: 'success',
      });
      expect(searchRun.result.toolExecutions[0]!.resultPreview).toContain(tableName);
      expect(
        searchRun.result.session.knowledgeSnapshot?.catalogRootHash,
      ).not.toBe(createRun.result.session.knowledgeSnapshot?.catalogRootHash);
    } finally {
      await runtime.close();
    }
  });
});

describe.skipIf(!runLiveModel)('DatabaseAgentRuntime live model + PostgreSQL Agent', () => {
  it('uses SiliconFlow tool calling to inspect JSON shape and execute the grounded query', async () => {
    const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
    expect(
      apiKey,
      '需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY',
    ).toBeTruthy();
    const model =
      process.env.TEST_SILICONFLOW_MODEL ??
      process.env.DBAGENT_LLM_MODEL ??
      'Qwen/Qwen3-32B';
    const provider = new RecordingProvider(
      new OpenAICompatibleProvider({
        id: 'sdk-live',
        name: 'SDK live provider',
        apiKey: apiKey!,
        baseUrl: process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        timeoutMs: 120_000,
        maxRetries: 1,
      }),
    );
    const runtime = await connectedRuntime(provider, 'live-agent', model);

    try {
      await runtime.indexSchema();
      const databaseMetricsBefore = runtime.database.metrics();
      const llmMetricsBefore = runtime.llmMetrics();
      const scenarioStarted = performance.now();
      const output = await runtime.runAgent({
        userId: 'live-test-user',
        message:
          '查询 public.events 中 topic 为 order-events 的事件。请先检索结构，必要时查看 JSON 数据形态，然后从 value.customer.province 和 value.amount 提取省份与金额，按省份返回事件数和金额总和。必须用真实数据库结果回答。',
        mode: 'read',
        maxIterations: 10,
        maxToolExecutionMs: 120_000,
      });
      const scenarioDurationMs = Math.round(performance.now() - scenarioStarted);

      expect(
        output.result.status,
        JSON.stringify({
          finalText: output.result.finalText,
          tools: output.result.toolExecutions.map((item) => ({
            name: item.toolName,
            status: item.status,
            args: item.argumentPreview,
            result: item.resultPreview,
            failureKind: item.failureKind,
          })),
        }),
      ).toBe('done');
      expect(
        output.result.toolExecutions.some(
          (item) =>
            ['resource_get', 'knowledge_search'].includes(item.toolName) &&
            item.status === 'success',
        ),
      ).toBe(true);
      expect(output.result.toolExecutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'sql_execute', status: 'success' }),
        ]),
      );
      const executions = output.result.toolExecutions.filter(
        (item) => item.toolName === 'sql_execute',
      );
      expect(executions.some((item) => item.resultPreview.includes('Shanghai'))).toBe(true);
      expect(executions.some((item) => item.resultPreview.includes('Beijing'))).toBe(true);
      expect(executions.some((item) => item.resultPreview.includes('Guangdong'))).toBe(true);
      expect(output.result.finalText.length).toBeGreaterThan(10);
      expectModelRequestsToExcludeKnowledgeInternals(provider.requests, [
        runtime.status().connection!.id,
      ]);
      const databaseMetricsAfter = runtime.database.metrics();
      const llmMetricsAfter = runtime.llmMetrics();
      const queryAudit = runtime.database
        .listAuditEvents({ limit: 50 })
        .filter((event) => event.action === 'database.query.submit');
      expect(
        databaseMetricsAfter.submittedQueries -
          databaseMetricsBefore.submittedQueries,
      ).toBe(executions.length);
      expect(queryAudit).toHaveLength(executions.length);
      expect(
        llmMetricsAfter.requests - llmMetricsBefore.requests,
      ).toBe(provider.requests.length);
      expect(
        llmMetricsAfter.completed - llmMetricsBefore.completed,
      ).toBe(provider.requests.length);
      await printAgentScenarioLog(
        'siliconflow-real-postgres-json',
        output,
        provider.requests,
        {
          endToEndDurationMs: scenarioDurationMs,
          llmGateway: {
            requests:
              llmMetricsAfter.requests - llmMetricsBefore.requests,
            completed:
              llmMetricsAfter.completed - llmMetricsBefore.completed,
            promptTokens:
              llmMetricsAfter.totalPromptTokens -
              llmMetricsBefore.totalPromptTokens,
            completionTokens:
              llmMetricsAfter.totalCompletionTokens -
              llmMetricsBefore.totalCompletionTokens,
          },
          databaseAccess: {
            discoveryPages: databaseMetricsAfter.discoveryPages,
            submittedQueries:
              databaseMetricsAfter.submittedQueries -
              databaseMetricsBefore.submittedQueries,
            successfulQueryAudits: queryAudit.filter(
              (event) => event.status === 'succeeded',
            ).length,
          },
          resourceState: {
            resources: databaseMetricsAfter.resources,
            relations: databaseMetricsAfter.relations,
          },
          publicContracts: {
            connectionProfile: 'validated by DatabaseAccessRuntime',
            discoveredResources: 'validated by ResourceRegistry',
            querySubmissions: 'validated by DatabaseAccessRuntime',
          },
        },
      );
    } finally {
      await runtime.close();
    }
  }, 240_000);
});

async function connectedRuntime(
  provider: LlmProvider,
  name: string,
  model = 'deterministic-integration-model',
): Promise<DatabaseAgentRuntime> {
  const directory = await mkdtemp(join(tmpdir(), `dbagent-${name}-`));
  tempDirectories.push(directory);
  const runtime = new DatabaseAgentRuntime({
    provider,
    model,
    sessionDatabasePath: join(directory, 'agent.db'),
  });
  await runtime.connect({
    name: `SDK PostgreSQL ${name}`,
    host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
    database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
    username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  });
  return runtime;
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
    usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
  };
}

function finalAnswer(text: string): LlmChatResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
  };
}

class ScriptedAgentProvider implements LlmProvider {
  readonly id = 'scripted-postgres-agent';
  readonly name = 'Scripted PostgreSQL Agent';
  readonly mode = 'byok' as const;
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly script: LlmChatResponse[]) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    const response = this.script.shift();
    if (!response) throw new Error('No scripted Agent response remains.');
    return Promise.resolve(structuredClone(response));
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class RecordingProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProvider['mode'];
  readonly protocol: string | undefined;
  readonly capabilities: LlmProvider['capabilities'];
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly inner: LlmProvider) {
    this.id = inner.id;
    this.name = inner.name;
    this.mode = inner.mode;
    this.protocol = inner.protocol;
    this.capabilities = inner.capabilities;
  }

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    return this.inner.chat(request);
  }

  isAvailable(
    model?: string,
    signal?: AbortSignal,
  ): Promise<LlmProviderAvailability> {
    return this.inner.isAvailable(model, signal);
  }
}

function expectModelRequestsToExcludeKnowledgeInternals(
  requests: LlmChatRequest[],
  forbiddenValues: string[] = [],
): void {
  const modelMessages = JSON.stringify(requests.map((request) => request.messages));
  for (const forbidden of [
    'knowledgeSnapshotId',
    'catalogRootHash',
    'containmentRootHash',
    'relationRootHash',
    'knowledgeRootHash',
    'ancestorIds',
    'childIds',
    'relationIds',
    'knowledgeBindingIds',
    'localHash',
    'childBlockHashes',
    'subtreeHash',
    '"resourceId"',
    '"parentId"',
    '"node":',
    '"children":',
    'scoreDetails',
    '"score"',
    '"reasons"',
    '"tokens"',
    'table:public.',
    'column:public.',
    'resource:table:',
    'resource:column:',
    '资源:',
    ...forbiddenValues.filter(Boolean),
  ]) {
    expect(modelMessages, `model request leaked ${forbidden}`).not.toContain(forbidden);
  }
  expect(
    modelMessages,
    'model request exposed a PostgreSQL type OID instead of a useful type name',
  ).not.toMatch(/"dataType":"\d+"/);
}

async function printAgentScenarioLog(
  scenario: string,
  output: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>>,
  requests: LlmChatRequest[],
  foundationIntegration?: Record<string, unknown>,
): Promise<void> {
  const shouldPrint = process.env.DBAGENT_SHOW_AGENT_LOGS === '1';
  const outputDirectory = process.env.DBAGENT_AGENT_LOG_DIR?.trim();
  if (!shouldPrint && !outputDirectory) return;
  const rounds = requests.map((request, index) => ({
    round: index + 1,
    visibleMessages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  }));
  const log = {
    scenario,
    status: output.result.status,
    iterations: output.result.iterations,
    finalText: output.result.finalText,
    tokenUsage: output.result.session.tokenUsage,
    tools: output.result.toolExecutions.map((execution) => ({
      name: execution.toolName,
      status: execution.status,
      arguments: execution.argumentPreview,
      result: execution.resultPreview,
    })),
    modelRequestLeakCheck: 'passed',
    ...(foundationIntegration === undefined
      ? {}
      : { foundationIntegration }),
    rounds,
  };
  const serialized = `${JSON.stringify(log, null, 2)}\n`;
  if (shouldPrint) {
    console.info(`[DBAGENT_AGENT_SCENARIO]\n${serialized}`);
  }
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, `${scenario}.json`), serialized, 'utf8');
  }
}
