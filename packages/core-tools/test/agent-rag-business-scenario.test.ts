import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentBehaviorEvaluationReport,
  ReactAgent,
  ToolRegistry,
} from '@dbagent/core-agent';
import {
  createSiliconFlowProvider,
  LlmRouter,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import {
  PostgresDriver,
  type DatabaseConnectionConfig,
  type IDatabaseDriver,
} from '@dbagent/core-db';
import {
  ensureSchemaCatalogTablesIndexed,
  indexSchemaCatalogFromReader,
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  evaluateSchemaRagRetrieval,
} from '@dbagent/core-rag';
import { UsageTracker } from '@dbagent/core-usage';
import {
  err,
  ok,
  type QueryExecutionResult,
  type QueryRequest,
  type Result,
  type SavedConnection,
  type TableDetail,
  type TableSummary,
} from '@dbagent/shared';
import {
  loadAgentEvalSuiteCatalog,
  registerDatabaseTools,
  runAgentBehaviorEvaluationSuite,
  type AgentEvalSuite,
} from '../src/index.js';
import {
  BUSINESS_CONNECTION_ID,
  businessFixtureCleanupSql,
  businessFixtureSql,
  businessFixtureTables,
  businessGlossary,
} from './business-scenario-fixture.js';

const tempDirs: string[] = [];
const OFFICIAL_AGENT_RAG_LIVE_SUITE_ID = 'official.agent-rag.business-readonly';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('business Schema RAG acceptance scenarios', () => {
  it('retrieves production-like ecommerce and traffic-analysis schema for user tasks', () => {
    const rag = indexedBusinessRag();

    const summary = evaluateSchemaRagRetrieval({
      connectionId: BUSINESS_CONNECTION_ID,
      defaultLimit: 12,
      search: (request) => rag.search(request),
      cases: [
        {
          id: 'BUS-RAG-001',
          query: '按流量渠道统计上周 GMV、退款率和 ROI',
          mustInclude: [
            'table:public.orders',
            'column:public.orders.total_amount',
            'table:public.refunds',
            'column:public.refunds.refund_amount',
            'table:analytics.campaign_spend',
            'column:analytics.campaign_spend.cost_amount',
          ],
          shouldInclude: ['table:analytics.traffic_sessions'],
          limit: 12,
        },
        {
          id: 'BUS-RAG-002',
          query: '找出支付成功但仍然待发货的订单',
          mustInclude: [
            'table:public.orders',
            'column:public.orders.payment_status',
            'column:public.orders.order_status',
          ],
          limit: 10,
        },
        {
          id: 'BUS-RAG-003',
          query: '分析从商品详情页到支付订单的转化漏斗',
          mustInclude: [
            'table:analytics.traffic_sessions',
            'column:analytics.traffic_sessions.converted_order_id',
            'table:analytics.page_views',
            'table:public.orders',
          ],
          shouldInclude: ['table:public.order_items', 'table:public.products'],
          limit: 12,
        },
        {
          id: 'BUS-RAG-004',
          query: '用户手机号是否可以直接查出来',
          mustInclude: ['table:public.customers', 'column:public.customers.phone_enc'],
          mustNotInclude: ['table:analytics.raw_evt'],
          limit: 8,
        },
      ],
    });

    expect(summary.passRate).toBe(1);
    expect(summary.averageMustHitRate).toBe(1);
  });

  it('builds compact context that includes business definitions without dumping every table', () => {
    const rag = indexedBusinessRag();

    const context = rag.buildContext({
      connectionId: BUSINESS_CONNECTION_ID,
      query: 'GMV、退款率和 ROI 需要哪些表',
      limit: 10,
      maxChars: 1_800,
    });

    expect(context.text).toContain('public.orders');
    expect(context.text).toContain('public.refunds');
    expect(context.text).toContain('analytics.campaign_spend');
    expect(context.text.length).toBeLessThanOrEqual(1_800);
  });
});

describe('Agent with business RAG and database tools', () => {
  it('uses schema search and SQL query tools to answer a realistic analyst task', async () => {
    const registry = new ToolRegistry();
    const driver = fakeBusinessDriver();
    const rag = indexedBusinessRag();
    registerDatabaseTools({
      registry,
      driver,
      rag,
      getConnection: (connectionId) =>
        connectionId === BUSINESS_CONNECTION_ID ? savedBusinessConnection() : undefined,
    });
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          responseWithTool('call_schema', 'search_schema', {
            connectionId: BUSINESS_CONNECTION_ID,
            query: '按流量渠道统计 GMV 退款率 ROI',
            limit: 8,
          }),
          responseWithTool('call_query', 'query_database', {
            connectionId: BUSINESS_CONNECTION_ID,
            sql: channelPerformanceSql(),
            limit: 20,
          }),
          {
            text: 'paid_search 渠道 GMV 为 199.00，退款率约 25.13%，ROI 约 1.66；seo 渠道 GMV 为 398.00，退款率 0%，ROI 约 19.90。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const output = await runAgentBehaviorEvaluationSuite({
      agent,
      reportStorePath: join(await tempDir(), 'reports.json'),
      baseRun: {
        providerId: 'fake',
        model: 'fake-business-model',
        mode: 'readonly',
        maxIterations: 5,
      },
      suite: {
        suiteId: 'agent-rag-business-fixture',
        suiteName: 'Agent/RAG 业务夹具验收',
        environment: 'integration',
        notes: ['默认测试使用 scripted provider 和 fake PostgreSQL driver，验证 runner 合同和工具证据。'],
        cases: [
          {
            case: {
              id: 'BUS-AGENT-EVAL-001',
              userTask: '帮我按流量渠道统计 GMV、退款率和 ROI，说明使用了哪些字段。',
              expectedStatus: 'done',
              requiredToolCalls: ['search_schema', 'query_database'],
              toolExpectations: [
                {
                  toolName: 'search_schema',
                  status: 'success',
                  minCalls: 1,
                  maxCalls: 1,
                  argumentIncludes: ['GMV', 'ROI'],
                  resultIncludes: ['public.orders', 'analytics.campaign_spend'],
                },
                {
                  toolName: 'query_database',
                  status: 'success',
                  minCalls: 1,
                  maxCalls: 1,
                  argumentIncludes: ['analytics.traffic_sessions', 'public.refunds'],
                  resultIncludes: ['paid_search', 'seo'],
                },
              ],
              finalTextIncludes: ['paid_search', 'GMV'],
              finalTextExcludes: ['password', 'apiKey'],
              minIterations: 2,
              maxIterations: 5,
            },
          },
        ],
      },
    });
    const result = output.caseResults[0]?.result;

    expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
    expect(output.savedReport).toMatchObject({
      suiteId: 'agent-rag-business-fixture',
      suiteName: 'Agent/RAG 业务夹具验收',
      passRate: 1,
    });
    expect(result?.status).toBe('done');
    expect(result?.toolExecutions).toMatchObject([
      { toolName: 'search_schema', status: 'success' },
      { toolName: 'query_database', status: 'success' },
    ]);
    expect(result?.finalText).toContain('paid_search');
    expect(result?.finalText).toContain('GMV');
    expect(driver.executedSql).toEqual([channelPerformanceSql()]);
  });

  it('refuses destructive SQL in readonly mode before any database write occurs', async () => {
    const registry = new ToolRegistry();
    const driver = fakeBusinessDriver();
    registerDatabaseTools({
      registry,
      driver,
      rag: indexedBusinessRag(),
      getConnection: () => savedBusinessConnection(),
    });
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          responseWithTool('call_delete', 'execute_sql', {
            connectionId: BUSINESS_CONNECTION_ID,
            sql: 'delete from public.orders where payment_status = null',
            confirmed: true,
          }),
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-business-model',
      userMessage: '清理支付状态为空的订单。',
      mode: 'readonly',
      maxIterations: 2,
    });

    expect(result.status).toBe('permission_denied');
    expect(driver.executedSql).toEqual([]);
  });
});

describe('Agent/RAG eval suite catalog wiring', () => {
  it('loads the official business readonly suite used by the live gate', async () => {
    const suite = await loadLiveAgentRagSuite();

    expect(suite).toMatchObject({
      suiteId: OFFICIAL_AGENT_RAG_LIVE_SUITE_ID,
      suiteName: '官方 Agent/RAG 业务只读验收',
      cases: [
        {
          case: {
            id: 'OFFICIAL-AGENT-RAG-001',
            requiredToolCalls: ['search_schema', 'query_database'],
          },
          run: {
            allowedTools: ['search_schema', 'query_database'],
            mode: 'readonly',
            maxIterations: 5,
          },
        },
      ],
    });
  });
});

describe.skipIf(process.env.DBAGENT_RUN_POSTGRES_TESTS !== '1')(
  'real PostgreSQL business fixture',
  () => {
    it('creates production-like tables, extracts schema, indexes RAG, and runs the Agent workflow', async () => {
      const driver = new PostgresDriver();
      const config = postgresConfig({ readOnly: false });
      const connected = await driver.connect(config);
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;

      try {
        await expectOk(
          driver.execute(
            { connectionId: config.id!, sql: businessFixtureSql(), confirmed: true },
            connected.data,
          ),
        );

        const rag = new SchemaRagEngine();
        const catalogIndex = await indexSchemaCatalogFromReader({
          connectionId: config.id!,
          reader: driver,
          indexer: new ProgressiveSchemaRagIndexer({ engine: rag }),
          includeSchemas: ['public', 'analytics'],
          glossary: businessGlossary(),
          hotTableLimit: 4,
          continueOnTableError: false,
        });
        expect(catalogIndex.ok).toBe(true);
        if (!catalogIndex.ok) throw new Error(catalogIndex.error.message);

        const tableDetails = catalogIndex.data.tables;
        expect(tableDetails.map((table) => `${table.schema}.${table.name}`)).toEqual(
          expect.arrayContaining([
            'public.orders',
            'public.refunds',
            'analytics.traffic_sessions',
            'analytics.campaign_spend',
          ]),
        );
        const orderColumns = tableDetails.find((table) => table.name === 'orders')?.columns ?? [];
        expect(orderColumns).toContainEqual(
          expect.objectContaining({
            name: 'customer_id',
            foreignKey: { schema: 'public', table: 'customers', column: 'id' },
          }),
        );
        expect(orderColumns.find((column) => column.name === 'total_amount')?.comment).toContain(
          'GMV',
        );
        expect(catalogIndex.data.status.ready).toBe(true);
        expect(catalogIndex.data.warnings).toEqual([]);

        const registry = new ToolRegistry();
        registerDatabaseTools({
          registry,
          driver,
          rag,
          getConnection: (connectionId) =>
            connectionId === config.id ? connected.data : undefined,
        });

        const usage = new UsageTracker(await usagePath());
        const agent = new ReactAgent(
          new LlmRouter(usage, [
            scriptedProvider([
              responseWithTool('call_schema', 'search_schema', {
                connectionId: config.id,
                query: '按流量渠道统计 GMV 退款率 ROI',
                limit: 8,
              }),
              responseWithTool('call_query', 'query_database', {
                connectionId: config.id,
                sql: channelPerformanceSql(),
                limit: 20,
              }),
              { text: '真实 PostgreSQL 夹具已完成渠道 GMV、退款率和 ROI 查询。', toolCalls: [] },
            ]),
          ]),
          registry,
          usage,
          undefined,
          fixedDependencies(),
        );

        const output = await runAgentBehaviorEvaluationSuite({
          agent,
          reportStorePath: join(await tempDir(), 'reports.json'),
          baseRun: {
            providerId: 'fake',
            model: 'fake-business-model',
            mode: 'readonly',
            maxIterations: 5,
          },
          suite: {
            suiteId: 'agent-rag-business-postgres',
            suiteName: 'Agent/RAG 真实 PostgreSQL 业务验收',
            environment: 'postgres',
            notes: ['该套件创建真实 PostgreSQL 业务表、抽取 catalog、索引 RAG，并通过 Agent 工具链执行查询。'],
            cases: [
              {
                case: {
                  id: 'BUS-AGENT-PG-001',
                  userTask: '按渠道统计 GMV、退款率和 ROI。',
                  expectedStatus: 'done',
                  requiredToolCalls: ['search_schema', 'query_database'],
                  requiredToolStatuses: [
                    { toolName: 'search_schema', status: 'success' },
                    { toolName: 'query_database', status: 'success' },
                  ],
                  toolExpectations: [
                    {
                      toolName: 'search_schema',
                      status: 'success',
                      minCalls: 1,
                      maxCalls: 1,
                      argumentIncludes: ['GMV', 'ROI'],
                      resultIncludes: ['public.orders', 'analytics.campaign_spend'],
                    },
                    {
                      toolName: 'query_database',
                      status: 'success',
                      minCalls: 1,
                      maxCalls: 1,
                      argumentIncludes: ['analytics.traffic_sessions', 'public.refunds'],
                      resultIncludes: ['paid_search'],
                    },
                  ],
                  finalTextIncludes: ['GMV'],
                  finalTextExcludes: ['password', 'apiKey'],
                  minIterations: 2,
                  maxIterations: 5,
                },
              },
            ],
          },
        });
        const result = output.caseResults[0]?.result;

        expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
        expect(output.report.run.postgres).toBe(true);
        expect(output.savedReport).toMatchObject({
          suiteId: 'agent-rag-business-postgres',
          suiteName: 'Agent/RAG 真实 PostgreSQL 业务验收',
          passRate: 1,
        });
        expect(result?.status).toBe('done');
        expect(result?.toolExecutions.map((record) => record.toolName)).toEqual([
          'search_schema',
          'query_database',
        ]);
      } finally {
        await driver.execute(
          { connectionId: config.id!, sql: businessFixtureCleanupSql(), confirmed: true },
          connected.data,
        );
        await driver.disconnect(config.id!);
      }
    }, 120_000);

    it('on-demand indexes an explicitly referenced cold table from real PostgreSQL catalog', async () => {
      const driver = new PostgresDriver();
      const config = postgresConfig({ readOnly: false });
      const connected = await driver.connect(config);
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;

      try {
        await expectOk(
          driver.execute(
            { connectionId: config.id!, sql: businessFixtureSql(), confirmed: true },
            connected.data,
          ),
        );

        const rag = new SchemaRagEngine();
        const indexer = new ProgressiveSchemaRagIndexer({ engine: rag });
        const initial = await indexSchemaCatalogFromReader({
          connectionId: config.id!,
          reader: driver,
          indexer,
          includeSchemas: ['analytics'],
          tableLimit: 1,
          continueOnTableError: false,
        });
        expect(initial.ok).toBe(true);
        if (!initial.ok) throw new Error(initial.error.message);
        expect(rag.hasTable({ connectionId: config.id!, table: 'public.refunds' })).toBe(false);

        const ensured = await ensureSchemaCatalogTablesIndexed({
          connectionId: config.id!,
          reader: driver,
          indexer,
          references: ['@public.refunds'],
          continueOnTableError: false,
        });
        expect(ensured.ok).toBe(true);
        if (!ensured.ok) throw new Error(ensured.error.message);

        expect(ensured.data.indexedTableCount).toBe(1);
        expect(rag.hasTable({ connectionId: config.id!, table: 'public.refunds' })).toBe(true);
        expect(
          rag.search({
            connectionId: config.id!,
            query: '@public.refunds refund amount',
            limit: 3,
          })[0]?.document.id,
        ).toBe('table:public.refunds');
      } finally {
        await driver.execute(
          { connectionId: config.id!, sql: businessFixtureCleanupSql(), confirmed: true },
          connected.data,
        );
        await driver.disconnect(config.id!);
      }
    }, 120_000);
  },
);

describe('SiliconFlow live Agent and RAG integration', () => {
  const runLive = process.env.DBAGENT_RUN_AGENT_RAG_LIVE === '1';
  const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
  const model = process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro';

  it.skipIf(!runLive || !apiKey)(
    'uses the real DeepSeek-V4-Pro model to call RAG and query tools',
    async () => {
      const registry = new ToolRegistry();
      const driver = fakeBusinessDriver();
      registerDatabaseTools({
        registry,
        driver,
        rag: indexedBusinessRag(),
        getConnection: (connectionId) =>
          connectionId === BUSINESS_CONNECTION_ID ? savedBusinessConnection() : undefined,
      });
      const usage = new UsageTracker(await usagePath());
      const agent = new ReactAgent(
        new LlmRouter(usage, [
          createSiliconFlowProvider({ apiKey: apiKey!, timeoutMs: 120_000, maxRetries: 1 }),
        ]),
        registry,
        usage,
        undefined,
        fixedDependencies(),
      );

      const output = await runAgentBehaviorEvaluationSuite({
        agent,
        reportStorePath: reportStorePath(),
        stopOnFirstFailure: true,
        baseRun: {
          providerId: 'siliconflow',
          model,
          mode: 'readonly',
          allowedTools: ['search_schema', 'query_database'],
          maxIterations: 5,
        },
        suite: await loadLiveAgentRagSuite(),
      });
      const result = output.caseResults[0]?.result;

      expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
      expect(result?.status).toBe('done');
      expect(result?.toolExecutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'search_schema', status: 'success' }),
          expect.objectContaining({ toolName: 'query_database', status: 'success' }),
        ]),
      );
      expect(result?.finalText.length).toBeGreaterThan(0);
      await writeLiveAgentRagReport(output.report);
    },
    180_000,
  );
});

function indexedBusinessRag(): SchemaRagEngine {
  const rag = new SchemaRagEngine();
  rag.index({
    connectionId: BUSINESS_CONNECTION_ID,
    tables: businessFixtureTables(),
    glossary: businessGlossary(),
    indexedAt: '2026-06-23T00:00:00.000Z',
  });
  return rag;
}

function fakeBusinessDriver(): IDatabaseDriver & { executedSql: string[] } {
  const executedSql: string[] = [];
  return {
    executedSql,
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    test() {
      return Promise.resolve(ok({ latencyMs: 1 }));
    },
    connect() {
      return Promise.resolve(ok(savedBusinessConnection()));
    },
    disconnect() {
      return Promise.resolve(ok(undefined));
    },
    execute(request: QueryRequest): Promise<Result<QueryExecutionResult>> {
      executedSql.push(request.sql);
      if (/delete|update|insert|drop|truncate/i.test(request.sql)) {
        return Promise.resolve(
          err({
            code: 'READ_ONLY_VIOLATION',
            message: 'Write SQL is blocked in the business fixture.',
          }),
        );
      }
      return Promise.resolve(
        ok({
          queryId: request.queryId ?? 'business_query',
          columns: [
            { name: 'utm_source', dataType: 'text' },
            { name: 'gmv', dataType: 'numeric' },
            { name: 'refund_rate', dataType: 'numeric' },
            { name: 'roi', dataType: 'numeric' },
          ],
          rows: [
            { utm_source: 'paid_search', gmv: '199.00', refund_rate: '0.2513', roi: '1.6583' },
            { utm_source: 'seo', gmv: '398.00', refund_rate: '0.0000', roi: '19.9000' },
            { utm_source: 'social', gmv: '0.00', refund_rate: '0.0000', roi: '0.0000' },
          ],
          rowCount: 3,
          elapsedMs: 7,
          safety: {
            statementKind: 'select',
            riskLevel: 'safe',
            requiresConfirmation: false,
            blocked: false,
            reasons: [],
          },
        }),
      );
    },
    listTables(): Promise<Result<TableSummary[]>> {
      return Promise.resolve(
        ok(
          businessFixtureTables().map((table) => ({
            schema: table.schema,
            name: table.name,
            type: table.type,
            ...(table.comment === undefined ? {} : { comment: table.comment }),
          })),
        ),
      );
    },
    describeTable(
      _connectionId: string,
      schema: string,
      table: string,
    ): Promise<Result<TableDetail>> {
      const detail = businessFixtureTables().find(
        (item) => item.schema === schema && item.name === table,
      );
      return Promise.resolve(
        detail
          ? ok(detail)
          : err({ code: 'NOT_FOUND', message: `Table ${schema}.${table} not found.` }),
      );
    },
  };
}

async function expectOk<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message}${result.error.detail ? ` ${result.error.detail}` : ''}`,
    );
  }
  expect(result.ok).toBe(true);
  return result.data;
}

function postgresConfig(input: { readOnly: boolean }): DatabaseConnectionConfig {
  return {
    id: BUSINESS_CONNECTION_ID,
    name: 'Business Fixture PostgreSQL',
    engine: 'postgres',
    host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
    database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_demo',
    username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
    readOnly: input.readOnly,
    maxClients: 2,
  };
}

function savedBusinessConnection(): SavedConnection {
  return {
    id: BUSINESS_CONNECTION_ID,
    name: 'Business Fixture',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'dbagent_demo',
    username: 'tester',
    readOnly: true,
    status: 'connected',
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
  };
}

function channelPerformanceSql(): string {
  return `
select
  s.utm_source,
  coalesce(sum(o.total_amount), 0)::numeric(12, 2) as gmv,
  coalesce(sum(r.refund_amount), 0)::numeric(12, 2) as refund_amount,
  case when coalesce(sum(o.total_amount), 0) = 0 then 0
       else round(coalesce(sum(r.refund_amount), 0) / sum(o.total_amount), 4)
  end as refund_rate,
  case when coalesce(sum(cs.cost_amount), 0) = 0 then null
       else round(sum(o.total_amount) / sum(cs.cost_amount), 4)
  end as roi
from analytics.traffic_sessions s
left join public.orders o on o.id = s.converted_order_id
left join public.refunds r on r.order_id = o.id
left join analytics.campaign_spend cs
  on cs.utm_source = s.utm_source
 and cs.utm_campaign = coalesce(s.utm_campaign, '')
 and cs.spend_date = s.started_at::date
group by s.utm_source
order by s.utm_source
`.trim();
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat() {
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return Promise.resolve(next);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

function responseWithTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
  };
}

async function usagePath(): Promise<string> {
  return join(await tempDir(), 'usage-history.json');
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-rag-'));
  tempDirs.push(dir);
  return dir;
}

function fixedDependencies() {
  return {
    now: () => '2026-06-23T00:00:00.000Z',
    createSessionId: () => 'business_agent_session',
  };
}

function reportStorePath(): string | undefined {
  const reportDir = process.env.DBAGENT_AGENT_RAG_REPORT_DIR;
  return reportDir ? join(reportDir, 'reports.json') : undefined;
}

async function writeLiveAgentRagReport(report: AgentBehaviorEvaluationReport): Promise<void> {
  const reportDir = process.env.DBAGENT_AGENT_RAG_REPORT_DIR;
  if (!reportDir) return;

  await mkdir(reportDir, { recursive: true });
  await Promise.all(
    report.files.map((file) => writeFile(join(reportDir, file.path), file.content, 'utf8')),
  );
}

async function loadLiveAgentRagSuite(): Promise<AgentEvalSuite> {
  const suiteId = process.env.DBAGENT_AGENT_RAG_SUITE_ID ?? OFFICIAL_AGENT_RAG_LIVE_SUITE_ID;
  const workspaceRoot = process.env.DBAGENT_AGENT_RAG_EVAL_WORKSPACE;
  const catalog = await loadAgentEvalSuiteCatalog({
    official: { enabledPluginIds: ['official.agent-rag-eval'] },
    ...(workspaceRoot === undefined ? {} : { workspace: { workspaceRoot } }),
  });
  const entry = catalog.entries.find((item) => item.suiteId === suiteId);
  if (entry === undefined) {
    throw new Error(
      `Agent/RAG live eval suite is not available: ${suiteId}. Available suites: ${catalog.entries
        .map((item) => item.suiteId)
        .join(', ')}`,
    );
  }
  return entry.suite;
}
