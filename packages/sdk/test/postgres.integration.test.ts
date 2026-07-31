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
import { DatabaseAgentRuntime, type DatabaseAgentRuntimeOptions } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const runLiveModel = process.env.DBAGENT_RUN_SDK_LIVE === '1';
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
      expect(runtime.resources.query({ kinds: ['table'], limit: 500 }).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ canonicalName: 'public.orders' }),
          expect.objectContaining({ canonicalName: 'public.users' }),
        ]),
      );

      const output = await runtime.runAgent({
        userId: 'integration-user',
        message: '/query-and-answer 统计每个城市已支付或退款订单的净收入、订单数和最大单笔净收入。',
        mode: 'read',
      });

      expect(output.activatedSkills).toContain('query-and-answer');
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
      expect(executionPreview).not.toContain('Shanghai');
      const executionRows = JSON.stringify(output.queryResults.at(-1)?.rows);
      expect(executionRows).toContain('Shanghai');
      expect(executionRows).toContain('Beijing');
      expect(executionRows).toContain('Shenzhen');
      expect(executionRows).toContain('1726.50');
      expect(output.result.session.knowledgeSnapshot?.knowledgeSnapshotId).toMatch(/^knowledge:/);
      expect(typeof output.result.session.knowledgeSnapshot?.catalogRootHash).toBe('string');
      expect(typeof output.result.session.knowledgeSnapshot?.retrievalProfileId).toBe('string');
      expect(provider.requests).toHaveLength(4);
      expectModelRequestsToExcludeKnowledgeInternals(provider.requests, [
        runtime.status().connection!.id,
      ]);
      const databaseMetricsAfter = runtime.database.metrics();
      const llmMetricsAfter = runtime.llmMetrics();
      const queryAuditEvents = runtime.database.listAuditEvents({ limit: 50 });
      const querySubmissions = queryAuditEvents.filter(
        (event) => event.action === 'database.query.submit',
      );
      const queryCompletions = queryAuditEvents.filter(
        (event) => event.action === 'database.query.complete',
      );
      expect(databaseMetricsAfter.submittedQueries - databaseMetricsBefore.submittedQueries).toBe(
        2,
      );
      expect(querySubmissions).toHaveLength(2);
      expect(querySubmissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'unknown',
            authorization: {
              actorId: 'integration-user',
              permissionMode: 'read',
            },
          }),
        ]),
      );
      expect(queryCompletions).toHaveLength(2);
      expect(queryCompletions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'succeeded',
            authorization: {
              actorId: 'integration-user',
              permissionMode: 'read',
            },
          }),
        ]),
      );
      expect(llmMetricsAfter.requests - llmMetricsBefore.requests).toBe(4);
      expect(llmMetricsAfter.completed - llmMetricsBefore.completed).toBe(4);
      expect(llmMetricsAfter.totalPromptTokens).toBeGreaterThan(llmMetricsBefore.totalPromptTokens);
      await printAgentScenarioLog('real-postgres-complex-english', output, provider.requests, {
        llmGateway: {
          requests: llmMetricsAfter.requests - llmMetricsBefore.requests,
          completed: llmMetricsAfter.completed - llmMetricsBefore.completed,
          promptTokens: llmMetricsAfter.totalPromptTokens - llmMetricsBefore.totalPromptTokens,
          completionTokens:
            llmMetricsAfter.totalCompletionTokens - llmMetricsBefore.totalCompletionTokens,
        },
        databaseAccess: {
          discoveryPages: databaseMetricsAfter.discoveryPages,
          submittedQueries:
            databaseMetricsAfter.submittedQueries - databaseMetricsBefore.submittedQueries,
          successfulQueryAudits: queryCompletions.filter(
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
      });
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
      expect(executionPreview).not.toContain('江苏');
      const executionRows = JSON.stringify(output.queryResults.at(-1)?.rows);
      expect(executionRows).toContain('江苏');
      expect(executionRows).toContain('广东');
      expect(executionRows).toContain('56000.00');
      expect(executionRows).toContain('公路');
      expect(executionRows).toContain('铁路');
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
      expect(searchRun.result.session.knowledgeSnapshot?.catalogRootHash).not.toBe(
        createRun.result.session.knowledgeSnapshot?.catalogRootHash,
      );
    } finally {
      await runtime.close();
    }
  });

  it('answers a simple schema-list request from Schema RAG without querying PostgreSQL catalogs', async () => {
    const provider = new ScriptedAgentProvider([
      toolCall('list-schemas', 'resource_list', {
        kinds: ['schema'],
        limit: 100,
      }),
      finalAnswer(
        '当前数据库包含 public、analytics、commerce、science、traffic_lab、供应链和电商运营等 schema。',
      ),
    ]);
    const runtime = await connectedRuntime(provider, 'schema-list-fast-path');

    try {
      await runtime.indexSchema();
      const before = runtime.database.metrics();
      const startedAt = performance.now();
      const output = await runtime.runAgent({
        userId: 'integration-user',
        message: '看一下 dbagent_core_db_test 下面的 schemas 都有哪些。',
        mode: 'read',
      });
      const durationMs = performance.now() - startedAt;
      const after = runtime.database.metrics();

      expect(output.result.status).toBe('done');
      expect(output.result.iterations).toBe(2);
      expect(output.result.toolExecutions).toEqual([
        expect.objectContaining({
          toolName: 'resource_list',
          status: 'success',
        }),
      ]);
      expect(
        output.result.toolExecutions[0]?.resultPreview,
        JSON.stringify(output.result.toolExecutions, null, 2),
      ).toContain('traffic_lab');
      expect(output.result.toolExecutions[0]?.resultPreview).toContain('供应链');
      expect(output.queryResults).toHaveLength(0);
      expect(after.submittedQueries - before.submittedQueries).toBe(0);
      expect(durationMs).toBeLessThan(5_000);
    } finally {
      await runtime.close();
    }
  });

  it('creates and verifies a parsed Kafka table', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const tableName = `proc_kafka_events_create_${suffix}`;
    const qualifiedTable = `traffic_lab.${tableName}`;
    const createSql = `
      CREATE TABLE ${qualifiedTable} AS
      SELECT
        value ->> 'event_id' AS event_id,
        CASE
          WHEN value ->> 'event_time'
            ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$'
          THEN (value ->> 'event_time')::timestamptz
        END AS event_time,
        (value ->> 'ingested_at')::timestamptz AS ingested_at,
        value ->> 'event_type' AS event_type,
        value ->> 'visitor_id' AS visitor_id,
        CASE
          WHEN value ->> 'latency_ms' ~ '^\\d+(?:\\.\\d+)?$'
          THEN (value ->> 'latency_ms')::numeric
        END AS latency_ms,
        value ->> 'page' AS page,
        value ->> 'source' AS source
      FROM traffic_lab.raw_kafka_events
    `;
    const verifySql = `
      SELECT
        count(*)::bigint AS row_count,
        count(*) FILTER (WHERE event_time IS NULL)::bigint AS invalid_event_time_count,
        count(*) FILTER (WHERE latency_ms IS NULL)::bigint AS invalid_latency_count
      FROM ${qualifiedTable}
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('safe-create', 'sql_execute', { sql: createSql }),
      toolCall('verify-created-table', 'sql_execute', {
        sql: verifySql,
        previewRows: 20,
      }),
      finalAnswer('新表已经创建并验证，共 20017 行；原有表未被改动。'),
    ]);
    const runtime = await connectedRuntime(provider, 'kafka-create-and-verify');

    try {
      await runtime.indexSchema();
      const before = runtime.database.metrics();
      const startedAt = performance.now();
      const output = await runtime.runAgent({
        userId: 'integration-user',
        message:
          `把 traffic_lab.raw_kafka_events 的 JSON key 解析成一张新表 ${qualifiedTable}。` +
          '创建后验证新表。',
        mode: 'full',
        maxIterations: 8,
      });
      const durationMs = performance.now() - startedAt;
      const after = runtime.database.metrics();

      expect(output.result.status).toBe('done');
      expect(output.result.iterations).toBe(3);
      expect(output.result.toolExecutions).toEqual([
        expect.objectContaining({
          toolCallId: 'safe-create',
          status: 'success',
        }),
        expect.objectContaining({
          toolCallId: 'verify-created-table',
          status: 'success',
        }),
      ]);
      expect(after.submittedQueries - before.submittedQueries).toBe(2);
      expect(output.queryResults.at(-1)?.rows).toEqual([
        expect.objectContaining({
          row_count: '20017',
          invalid_event_time_count: '1',
          invalid_latency_count: '1',
        }),
      ]);
      expect(output.result.finalText).toContain('20017');
      expect(output.result.finalText).toContain('原有表未被改动');
      expect(durationMs).toBeLessThan(10_000);
    } finally {
      await submitRuntimeSql(runtime, `DROP TABLE IF EXISTS ${qualifiedTable}`);
      await runtime.close();
    }
  }, 120_000);

  it('applies approved UPDATE and DDL once without leaking authority to the next call or Session state', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const tableName = `agent_approval_probe_${suffix}`;
    const qualifiedTable = `public.${tableName}`;
    const approvedUpdate = `UPDATE ${qualifiedTable} SET value = 1 WHERE id = 1`;
    const deniedUpdate = `UPDATE ${qualifiedTable} SET value = 2 WHERE id = 1`;
    const approvedDdl = `ALTER TABLE ${qualifiedTable} ADD COLUMN approved_note text`;
    const deniedDdl = `ALTER TABLE ${qualifiedTable} ADD COLUMN bypass_note text`;
    const verifySql = `
      SELECT
        p.value,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = '${tableName}'
            AND column_name = 'approved_note'
        ) AS approved_note_exists,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = '${tableName}'
            AND column_name = 'bypass_note'
        ) AS bypass_note_exists
      FROM ${qualifiedTable} p
      WHERE p.id = 1
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('approved-update', 'sql_execute', { sql: approvedUpdate }),
      finalAnswer('The approved update completed.'),
      toolCall('denied-update', 'sql_execute', { sql: deniedUpdate }),
      finalAnswer('The second update was not approved and was not executed.'),
      toolCall('approved-ddl', 'sql_execute', { sql: approvedDdl }),
      finalAnswer('The approved DDL completed.'),
      toolCall('denied-ddl', 'sql_execute', { sql: deniedDdl }),
      finalAnswer('The second DDL was not approved and was not executed.'),
      toolCall('verify-one-time-authorization', 'sql_execute', {
        sql: verifySql,
        previewRows: 5,
      }),
      finalAnswer('The approved changes exist and both unapproved changes are absent.'),
    ]);
    const approvalDecisions = [true, false, true, false];
    const approvalRequests: Array<{
      sessionId?: string;
      toolCallId: string;
      requiredPermission?: string;
      approved: boolean;
    }> = [];
    const runtime = await connectedRuntime(
      provider,
      'one-time-approval',
      'deterministic-integration-model',
      {
        approvalProvider(request) {
          const approved = approvalDecisions.shift();
          if (approved === undefined) {
            throw new Error(`Unexpected approval request for ${request.toolCall.id}`);
          }
          approvalRequests.push({
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            toolCallId: request.toolCall.id,
            ...(request.tool.requiredPermission === undefined
              ? {}
              : { requiredPermission: request.tool.requiredPermission }),
            approved,
          });
          return {
            approved,
            requestId: `approval-${request.toolCall.id}`,
            approvedBy: 'postgres-integration-user',
          };
        },
      },
    );

    try {
      await submitRuntimeSql(
        runtime,
        `CREATE TABLE ${qualifiedTable} (id integer PRIMARY KEY, value integer NOT NULL);
         INSERT INTO ${qualifiedTable} (id, value) VALUES (1, 0)`,
      );
      await runtime.indexSchema();

      const first = await runtime.runAgent({
        userId: 'postgres-integration-user',
        message: 'Apply the first approved value update.',
        mode: 'read',
      });
      const sessionId = first.result.session.id;
      expect(first.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'approved-update',
        status: 'success',
        approval: { requestId: 'approval-approved-update' },
      });

      const second = await runtime.runAgent({
        userId: 'postgres-integration-user',
        sessionId,
        message: 'Try a second value update; this requires a new decision.',
        mode: 'read',
      });
      expect(second.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'denied-update',
        status: 'denied',
      });
      expect(second.result.toolExecutions[0]).not.toHaveProperty('approval');

      const third = await runtime.runAgent({
        userId: 'postgres-integration-user',
        sessionId,
        message: 'Add the approved_note column after approval.',
        mode: 'read',
      });
      expect(third.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'approved-ddl',
        status: 'success',
        approval: { requestId: 'approval-approved-ddl' },
      });

      const fourth = await runtime.runAgent({
        userId: 'postgres-integration-user',
        sessionId,
        message: 'Try to add bypass_note; this requires another decision.',
        mode: 'read',
      });
      expect(fourth.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'denied-ddl',
        status: 'denied',
      });
      expect(fourth.result.toolExecutions[0]).not.toHaveProperty('approval');

      const verification = await runtime.runAgent({
        userId: 'postgres-integration-user',
        sessionId,
        message: 'Verify the value and both column-existence facts.',
        mode: 'read',
      });
      expect(verification.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'verify-one-time-authorization',
        status: 'success',
      });
      expect(verification.result.toolExecutions[0]?.resultPreview).not.toContain('"value":1');
      expect(verification.queryResults.at(-1)?.rows).toEqual([
        expect.objectContaining({
          value: 1,
          approved_note_exists: true,
          bypass_note_exists: false,
        }),
      ]);

      expect(approvalRequests).toEqual([
        {
          sessionId,
          toolCallId: 'approved-update',
          requiredPermission: 'edit',
          approved: true,
        },
        {
          sessionId,
          toolCallId: 'denied-update',
          requiredPermission: 'edit',
          approved: false,
        },
        {
          sessionId,
          toolCallId: 'approved-ddl',
          requiredPermission: 'full',
          approved: true,
        },
        {
          sessionId,
          toolCallId: 'denied-ddl',
          requiredPermission: 'full',
          approved: false,
        },
      ]);
      const queryAuditEvents = runtime.database.listAuditEvents({ limit: 100 });
      const querySubmissions = queryAuditEvents.filter(
        (event) => event.action === 'database.query.submit',
      );
      const queryCompletions = queryAuditEvents.filter(
        (event) => event.action === 'database.query.complete',
      );
      expect(querySubmissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'unknown',
            authorization: {
              actorId: 'postgres-integration-user',
              approvalId: 'approval-approved-update',
              permissionMode: 'edit',
            },
          }),
          expect.objectContaining({
            status: 'unknown',
            authorization: {
              actorId: 'postgres-integration-user',
              approvalId: 'approval-approved-ddl',
              permissionMode: 'full',
            },
          }),
        ]),
      );
      expect(queryCompletions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'succeeded',
            authorization: {
              actorId: 'postgres-integration-user',
              approvalId: 'approval-approved-update',
              permissionMode: 'edit',
            },
          }),
          expect.objectContaining({
            status: 'succeeded',
            authorization: {
              actorId: 'postgres-integration-user',
              approvalId: 'approval-approved-ddl',
              permissionMode: 'full',
            },
          }),
        ]),
      );
      expect(
        queryAuditEvents.some(
          (event) =>
            event.authorization?.approvalId === 'approval-denied-update' ||
            event.authorization?.approvalId === 'approval-denied-ddl',
        ),
      ).toBe(false);
    } finally {
      await submitRuntimeSql(runtime, `DROP TABLE IF EXISTS ${qualifiedTable}`);
      await runtime.close();
    }
  }, 120_000);

  it('does not let an Agent approval bypass a physically read-only PostgreSQL connection', async () => {
    const sql = `
      UPDATE public.orders
      SET refunded_amount = refunded_amount
      WHERE order_no = 'ORD-1001'
    `;
    const provider = new ScriptedAgentProvider([
      toolCall('read-only-update', 'sql_execute', { sql }),
      finalAnswer('The database hard boundary rejected the update.'),
    ]);
    const runtime = await connectedRuntime(
      provider,
      'read-only-approved-update',
      'deterministic-integration-model',
      {
        readOnly: true,
        approvalProvider: () => ({
          approved: true,
          requestId: 'approval-read-only-update',
          approvedBy: 'postgres-integration-user',
        }),
      },
    );

    try {
      await runtime.indexSchema();
      const output = await runtime.runAgent({
        userId: 'postgres-integration-user',
        message: 'Attempt the approved no-op update on this read-only connection.',
        mode: 'read',
      });

      expect(output.result.toolExecutions[0]).toMatchObject({
        toolCallId: 'read-only-update',
        status: 'failed',
        approval: { requestId: 'approval-read-only-update' },
      });
      expect(output.result.toolExecutions[0]?.resultPreview).toContain('blocked by read-only mode');
      const queryAudits = runtime.database
        .listAuditEvents({ limit: 20 })
        .filter((event) => event.action === 'database.query.submit');
      const queryAudit = queryAudits.find(
        (event) => event.authorization?.approvalId === 'approval-read-only-update',
      );
      expect(
        queryAudit,
        JSON.stringify(
          {
            toolExecutions: output.result.toolExecutions,
            queryAudits,
          },
          null,
          2,
        ),
      ).toMatchObject({
        status: 'unknown',
        authorization: {
          actorId: 'postgres-integration-user',
          approvalId: 'approval-read-only-update',
          permissionMode: 'edit',
        },
      });
      expect(queryAudit?.jobId).toBeTruthy();
      const terminalJob = await runtime.database.getJob(queryAudit!.jobId!);
      expect(terminalJob).toMatchObject({
        state: 'failed',
        error: { code: 'READ_ONLY_VIOLATION' },
      });
      expect(
        runtime.database
          .listAuditEvents({ limit: 20 })
          .find(
            (event) =>
              event.action === 'database.query.complete' && event.jobId === terminalJob.id,
          ),
      ).toMatchObject({
        status: 'failed',
        errorCode: 'READ_ONLY_VIOLATION',
        authorization: {
          actorId: 'postgres-integration-user',
          approvalId: 'approval-read-only-update',
          permissionMode: 'edit',
        },
      });
      expect(runtime.status().connection?.readOnly).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it('cancels a timed-out SQL tool through the Database Access job pipeline', async () => {
    const provider = new ScriptedAgentProvider([
      toolCall('slow-query', 'sql_execute', {
        sql: 'SELECT pg_sleep(10)',
        timeoutMs: 30_000,
      }),
      finalAnswer('查询已超时并取消，没有继续等待。'),
    ]);
    const runtime = await connectedRuntime(provider, 'cancel-agent');

    try {
      await runtime.indexSchema();
      const before = runtime.database.metrics();
      const startedAt = performance.now();
      const output = await runtime.runAgent({
        userId: 'integration-user',
        message: '执行一个慢查询，用于验证取消链路。',
        mode: 'read',
        maxToolExecutionMs: 100,
      });
      const durationMs = performance.now() - startedAt;

      expect(output.result.status).toBe('done');
      expect(output.result.toolExecutions[0]).toMatchObject({
        toolName: 'sql_execute',
        status: 'failed',
      });
      expect(output.result.toolExecutions[0]?.resultPreview).toContain('超时');
      expect(durationMs).toBeLessThan(3_000);
      const cancellationWaitStarted = performance.now();
      while (
        runtime.database.metrics().cancelledQueries - before.cancelledQueries === 0 &&
        performance.now() - cancellationWaitStarted < 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(runtime.database.metrics().cancelledQueries - before.cancelledQueries).toBe(1);
      expect(performance.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await runtime.close();
    }
  });
});

describe.skipIf(!runLiveModel)('DatabaseAgentRuntime live model + PostgreSQL Agent', () => {
  it('uses SiliconFlow tool calling to inspect JSON shape and execute the grounded query', async () => {
    const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
    expect(apiKey, '需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY').toBeTruthy();
    const model =
      process.env.TEST_SILICONFLOW_MODEL ?? process.env.DBAGENT_LLM_MODEL ?? 'Qwen/Qwen3-32B';
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
      expect(databaseMetricsAfter.submittedQueries - databaseMetricsBefore.submittedQueries).toBe(
        executions.length,
      );
      expect(queryAudit).toHaveLength(executions.length);
      expect(llmMetricsAfter.requests - llmMetricsBefore.requests).toBe(provider.requests.length);
      expect(llmMetricsAfter.completed - llmMetricsBefore.completed).toBe(provider.requests.length);
      await printAgentScenarioLog('siliconflow-real-postgres-json', output, provider.requests, {
        endToEndDurationMs: scenarioDurationMs,
        llmGateway: {
          requests: llmMetricsAfter.requests - llmMetricsBefore.requests,
          completed: llmMetricsAfter.completed - llmMetricsBefore.completed,
          promptTokens: llmMetricsAfter.totalPromptTokens - llmMetricsBefore.totalPromptTokens,
          completionTokens:
            llmMetricsAfter.totalCompletionTokens - llmMetricsBefore.totalCompletionTokens,
        },
        databaseAccess: {
          discoveryPages: databaseMetricsAfter.discoveryPages,
          submittedQueries:
            databaseMetricsAfter.submittedQueries - databaseMetricsBefore.submittedQueries,
          successfulQueryAudits: queryAudit.filter((event) => event.status === 'succeeded').length,
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
      });
    } finally {
      await runtime.close();
    }
  }, 240_000);
});

async function connectedRuntime(
  provider: LlmProvider,
  name: string,
  model = 'deterministic-integration-model',
  options: Pick<DatabaseAgentRuntimeOptions, 'approvalProvider'> & { readOnly?: boolean } = {},
): Promise<DatabaseAgentRuntime> {
  const directory = await mkdtemp(join(tmpdir(), `dbagent-${name}-`));
  tempDirectories.push(directory);
  const runtime = new DatabaseAgentRuntime({
    provider,
    model,
    sessionDatabasePath: join(directory, 'agent.db'),
    ...(options.approvalProvider === undefined
      ? {}
      : { approvalProvider: options.approvalProvider }),
  });
  await runtime.connect({
    name: `SDK PostgreSQL ${name}`,
    host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
    database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
    username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return runtime;
}

async function submitRuntimeSql(runtime: DatabaseAgentRuntime, sql: string): Promise<void> {
  const profile = runtime.database.listProfiles()[0];
  if (!profile) throw new Error('PostgreSQL integration profile is missing.');
  const job = await runtime.database.submit({
    profileId: profile.id,
    sql,
    executionMode: 'sync',
    confirmed: true,
    authorization: { permissionMode: 'full' },
  });
  if (job.state !== 'succeeded') {
    throw new Error(
      `PostgreSQL integration setup/cleanup failed: ${job.error?.message ?? job.state}`,
    );
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmChatResponse {
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
  readonly protocol?: string;
  readonly capabilities?: NonNullable<LlmProvider['capabilities']>;
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly inner: LlmProvider) {
    this.id = inner.id;
    this.name = inner.name;
    this.mode = inner.mode;
    if (inner.protocol !== undefined) this.protocol = inner.protocol;
    if (inner.capabilities !== undefined) this.capabilities = inner.capabilities;
  }

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    return this.inner.chat(request);
  }

  isAvailable(model?: string, signal?: AbortSignal): Promise<LlmProviderAvailability> {
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
    ...(foundationIntegration === undefined ? {} : { foundationIntegration }),
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
