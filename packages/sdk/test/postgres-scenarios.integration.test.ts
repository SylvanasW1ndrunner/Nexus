import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { AiSqlResultStore } from '@dbagent/core-tools';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime, type DatabaseAgentRuntimeOptions } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const runLiveModel = process.env.DBAGENT_RUN_SDK_LIVE === '1';
const tempDirectories: string[] = [];
const scenarioRunLogs: ScenarioRunLog[] = [];
const liveScenarioRunLogs: ScenarioRunLog[] = [];
const EXPECTED_FUNCTIONAL_RUN_COUNT = 9;
const LIVE_SCENARIOS = [
  {
    scenario: 'ecommerce-live',
    message:
      '请从 commerce 订单、支付和退款中，按月份和渠道统计 2026 年 1 月到 3 月的已结算净收入（已结算支付减成功退款），必须执行 SQL 并返回数据库结果。',
    expectedValues: ['2026-03', '150.00'],
  },
  {
    scenario: 'traffic-cleaning-live',
    message:
      'traffic_lab.raw_kafka_events 只有 JSONB value。请自行确认结构，在 PostgreSQL 中完成字段提取、按 event_id 保留 ingested_at 最新一条、过滤 event_id/visitor_id/event_time/latency_ms 缺失或格式错误的脏数据。高延迟和每分钟流量必须使用 traffic_lab.anomaly_thresholds 的配置值，不得自行设阈值；事件类型必须连接 traffic_lab.event_type_dictionary，并且只保留字典中 active=true 的事件。返回有效事件总数、高延迟事件总数、超过每分钟流量阈值的分钟数，并执行最终 SQL。',
    expectedValues: ['20011', '1', '201'],
  },
  {
    scenario: 'big-science-live',
    message:
      '请查询 science 的分区观测数据，按实验返回样本数、观测数、净信号（signal-background）的样本均值均值，并验证两个实验各有 12000 条观测。必须执行 SQL。',
    expectedValues: ['EXP-PHOTON-001', 'EXP-GENOME-002', '12000'],
  },
] as const;
const SELECTED_LIVE_SCENARIOS = process.env.DBAGENT_LIVE_SCENARIO?.trim()
  ? LIVE_SCENARIOS.filter(
      (liveCase) => liveCase.scenario === process.env.DBAGENT_LIVE_SCENARIO?.trim(),
    )
  : LIVE_SCENARIOS;
if (
  runLiveModel &&
  process.env.DBAGENT_LIVE_SCENARIO?.trim() &&
  SELECTED_LIVE_SCENARIOS.length === 0
) {
  throw new Error(
    `Unknown DBAGENT_LIVE_SCENARIO: ${process.env.DBAGENT_LIVE_SCENARIO.trim()}`,
  );
}
const functionalReportPath = fileURLToPath(
  new URL('../../../reports/postgres-scenarios/functional.json', import.meta.url),
);
const liveScenarioReportDirectory = join(dirname(functionalReportPath), 'live-cases');

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (!runPostgresTests) return;
  await mkdir(dirname(functionalReportPath), { recursive: true });
  if (scenarioRunLogs.length > 0) {
    await writeFile(
      functionalReportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
          database: 'PostgreSQL',
          deterministicModel: true,
          expectedRunCount: EXPECTED_FUNCTIONAL_RUN_COUNT,
          actualRunCount: scenarioRunLogs.length,
          passed:
            scenarioRunLogs.length === EXPECTED_FUNCTIONAL_RUN_COUNT &&
            scenarioRunLogs.every((run) => run.passed),
          runs: scenarioRunLogs,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  if (liveScenarioRunLogs.length > 0) {
    await writeFile(
      join(dirname(functionalReportPath), 'live.json'),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
          database: 'PostgreSQL',
          deterministicModel: false,
          provider: 'SiliconFlow OpenAI-compatible',
          model:
            process.env.TEST_SILICONFLOW_MODEL ?? process.env.DBAGENT_LLM_MODEL ?? 'Qwen/Qwen3-32B',
          expectedRunCount: SELECTED_LIVE_SCENARIOS.length,
          actualRunCount: liveScenarioRunLogs.length,
          passed:
            liveScenarioRunLogs.length === SELECTED_LIVE_SCENARIOS.length &&
            liveScenarioRunLogs.every((run) => run.passed),
          runs: liveScenarioRunLogs,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
});

describe.skipIf(!runPostgresTests)(
  'DatabaseAgentRuntime complex PostgreSQL acceptance scenarios',
  () => {
    it('handles ecommerce finance, Chinese business targets, and all three permission levels', async () => {
      const approvals: Array<{
        mode: string;
        requiredPermission?: string;
        sql: unknown;
      }> = [];
      const provider = new ScriptedAgentProvider([
        toolCall('commerce-knowledge', 'knowledge_search', {
          query: 'commerce orders customers payments refunds 电商运营 渠道目标 净收入',
          limit: 30,
          expandHops: 2,
        }),
        toolCall('commerce-explain', 'sql_explain', {
          sql: ECOMMERCE_FINANCE_SQL,
        }),
        toolCall('commerce-execute', 'sql_execute', {
          sql: ECOMMERCE_FINANCE_SQL,
          previewRows: 12,
        }),
        finalAnswer('已按月和渠道完成净收入、目标差额及客户统计。'),
        toolCall('read-mode-update', 'sql_execute', {
          sql: ECOMMERCE_INVENTORY_UPDATE_SQL,
        }),
        finalAnswer('用户拒绝本次许可，库存没有变化。'),
        toolCall('edit-mode-update', 'sql_execute', {
          sql: ECOMMERCE_INVENTORY_UPDATE_SQL,
        }),
        finalAnswer('已更新预留库存。'),
        toolCall('verify-inventory', 'sql_execute', {
          sql: ECOMMERCE_INVENTORY_VERIFY_SQL,
          previewRows: 5,
        }),
        finalAnswer('WH-SH-01 的 EC-KEYBOARD 预留数量为 3。'),
        toolCall('edit-mode-ddl', 'sql_execute', {
          sql: ECOMMERCE_DDL_SQL,
        }),
        finalAnswer('用户拒绝结构变更许可，没有创建验证表。'),
        toolCall('full-mode-ddl', 'sql_execute', {
          sql: ECOMMERCE_DDL_SQL,
        }),
        finalAnswer('已经在完全权限下创建验证表。'),
      ]);
      const runtime = await connectedRuntime(provider, 'commerce', {
        approvalProvider(request) {
          approvals.push({
            mode: request.mode,
            ...(request.tool.requiredPermission === undefined
              ? {}
              : { requiredPermission: request.tool.requiredPermission }),
            sql: request.toolCall.arguments.sql,
          });
          return {
            approved: false,
            requestId: `deny-${approvals.length}`,
            approvedBy: 'acceptance-user',
            reason: '验收测试主动拒绝',
          };
        },
      });

      try {
        const index = await runtime.indexSchema();
        expect(index.tableCount).toBeGreaterThanOrEqual(25);

        const finance = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '按月和渠道统计已结算支付减成功退款后的净收入，并和中文渠道目标比较。',
          mode: 'read',
        });
        expect(finance.result.status).toBe('done');
        expect(finance.result.toolExecutions.map((item) => item.toolName)).toEqual([
          'knowledge_search',
          'sql_explain',
          'sql_execute',
        ]);
        const financeResult = queryResultJson(finance, -1);
        for (const expected of [
          '2026-01',
          '2026-02',
          'wechat',
          'app',
          'web',
          '150.00',
          '160.00',
          '300.00',
          '500.00',
          '250.00',
          '420.00',
          '-80.00',
        ]) {
          expect(financeResult).toContain(expected);
        }

        const deniedEdit = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '把上海仓机械键盘的预留库存增加 2。',
          mode: 'read',
        });
        expect(deniedEdit.result.toolExecutions).toEqual([
          expect.objectContaining({
            toolName: 'sql_execute',
            status: 'denied',
          }),
        ]);

        const allowedEdit = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '把上海仓机械键盘的预留库存增加 2。',
          mode: 'edit',
        });
        expect(allowedEdit.result.toolExecutions[0]).toMatchObject({
          toolName: 'sql_execute',
          status: 'success',
        });
        expect(allowedEdit.result.toolExecutions[0]).not.toHaveProperty('approval');

        const verify = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '查询上海仓机械键盘当前预留库存。',
          mode: 'read',
        });
        expect(queryResultJson(verify, -1)).toContain('"reserved_qty":3');

        const deniedDdl = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '创建 commerce.permission_probe 验证表。',
          mode: 'edit',
        });
        expect(deniedDdl.result.toolExecutions[0]).toMatchObject({
          toolName: 'sql_execute',
          status: 'denied',
        });

        const allowedDdl = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '创建 commerce.permission_probe 验证表。',
          mode: 'full',
        });
        expect(allowedDdl.result.toolExecutions[0]).toMatchObject({
          toolName: 'sql_execute',
          status: 'success',
        });
        expect(
          runtime.resources.query({
            text: 'commerce.permission_probe',
            kinds: ['table'],
            limit: 20,
          }).items,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              canonicalName: 'commerce.permission_probe',
            }),
          ]),
        );

        expect(approvals).toEqual([
          {
            mode: 'read',
            requiredPermission: 'edit',
            sql: ECOMMERCE_INVENTORY_UPDATE_SQL,
          },
          {
            mode: 'edit',
            requiredPermission: 'full',
            sql: ECOMMERCE_DDL_SQL,
          },
        ]);
        recordRun('ecommerce', 'finance-query', finance);
        recordRun('ecommerce', 'read-mode-edit-denied', deniedEdit);
        recordRun('ecommerce', 'edit-mode-update', allowedEdit);
        recordRun('ecommerce', 'inventory-verification', verify);
        recordRun('ecommerce', 'edit-mode-ddl-denied', deniedDdl);
        recordRun('ecommerce', 'full-mode-ddl', allowedDdl);
      } finally {
        await runtime.close();
      }
    }, 120_000);

    it('repairs a wrong top-level Kafka column and pushes cleaning and anomaly aggregation into PostgreSQL', async () => {
      const provider = new ScriptedAgentProvider([
        toolCall('wrong-shape', 'sql_execute', {
          sql: 'SELECT event_time FROM traffic_lab.raw_kafka_events LIMIT 1',
        }),
        toolCall('read-json-shape', 'resource_get', {
          resource: 'traffic_lab.raw_kafka_events',
        }),
        toolCall('sample-json', 'sql_execute', {
          sql: 'SELECT value FROM traffic_lab.raw_kafka_events LIMIT 5',
          previewRows: 5,
        }),
        toolCall('clean-and-detect', 'sql_execute', {
          sql: TRAFFIC_CLEANING_SQL,
          previewRows: 10,
        }),
        finalAnswer(
          '10:00 有 1 条高延迟异常，10:02 的每分钟事件数超过阈值；统计已在 PostgreSQL 内完成。',
        ),
      ]);
      const runtime = await connectedRuntime(provider, 'traffic-cleaning');

      try {
        await runtime.indexSchema();
        const output = await runtime.runAgent({
          userId: 'acceptance-user',
          message:
            '清洗 Kafka value 中的事件，去重、过滤脏数据，并按分钟检测延迟和流量异常。先自行确认 JSON 结构。',
          mode: 'read',
          maxIterations: 10,
        });

        expect(output.result.status).toBe('done');
        expect(output.result.toolExecutions.map((item) => item.toolName)).toEqual([
          'sql_execute',
          'resource_get',
          'sql_execute',
          'sql_execute',
        ]);
        expect(output.result.toolExecutions[0]).toMatchObject({
          status: 'failed',
          failureKind: 'sql_repairable',
        });
        expect(output.result.toolExecutions[0]!.resultPreview).toContain('event_time');
        expect(output.result.toolExecutions[1]).toMatchObject({
          status: 'success',
        });
        expect(output.result.toolExecutions[1]!.resultPreview).toContain('value');

        const sample = queryResultJson(output, 0);
        expect(sample).toContain('"event_id":"e-001"');
        expect(sample).toContain('"latency_ms":120');
        expect(sample.length).toBeLessThan(6_000);

        const result = queryResultJson(output, -1);
        for (const expected of [
          '2026-03-01T10:00:00',
          '2026-03-01T10:01:00',
          '2026-03-01T10:02:00',
          '"event_count":"3"',
          '"event_count":"5"',
          '"avg_latency_ms":"376.67"',
          '"avg_latency_ms":"111.67"',
          '"avg_latency_ms":"140.00"',
          '"high_latency_events":"1"',
          '"volume_anomaly":true',
        ]) {
          expect(result).toContain(expected);
        }

        const modelMessages = JSON.stringify(provider.requests.map((request) => request.messages));
        expect(modelMessages).not.toContain('"event_id":"e-011"');
        expect(modelMessages.length).toBeLessThan(120_000);
        recordRun('traffic-cleaning', 'json-repair-and-anomaly', output);
      } finally {
        await runtime.close();
      }
    }, 120_000);

    it('queries partitioned scientific observations with high precision, windows, and deterministic statistics', async () => {
      const provider = new ScriptedAgentProvider([
        toolCall('science-knowledge', 'knowledge_search', {
          query:
            'science experiments samples observations partition signal background quality_flags',
          limit: 30,
          expandHops: 2,
        }),
        toolCall('science-partitions', 'sql_execute', {
          sql: SCIENCE_PARTITION_SQL,
          previewRows: 5,
        }),
        toolCall('science-explain', 'sql_explain', {
          sql: SCIENCE_STATISTICS_SQL,
        }),
        toolCall('science-statistics', 'sql_execute', {
          sql: SCIENCE_STATISTICS_SQL,
          previewRows: 5,
        }),
        finalAnswer('两个实验各包含 6 个样本和 12000 条观测，统计由分区表原生完成。'),
      ]);
      const runtime = await connectedRuntime(provider, 'big-science');

      try {
        await runtime.indexSchema();
        const output = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '验证 1 月和 2 月分区数据，并按实验计算校准信号的样本均值、标准差和样本排名。',
          mode: 'read',
        });

        expect(output.result.status).toBe('done');
        expect(output.result.toolExecutions.map((item) => item.toolName)).toEqual([
          'knowledge_search',
          'sql_execute',
          'sql_explain',
          'sql_execute',
        ]);
        const partitions = queryResultJson(output, 0);
        expect(partitions).toContain('science.observations_2026_01');
        expect(partitions).toContain('science.observations_2026_02');
        expect(partitions.match(/"observation_count":"12000"/g)).toHaveLength(2);

        const statistics = queryResultJson(output, -1);
        expect(statistics).toContain('EXP-PHOTON-001');
        expect(statistics).toContain('EXP-GENOME-002');
        expect(statistics.match(/"sample_count":"6"/g)).toHaveLength(2);
        expect(statistics.match(/"observation_count":"12000"/g)).toHaveLength(2);
        expect(statistics).toMatch(/"mean_of_sample_means":"[0-9]+\.[0-9]{6}"/);
        expect(statistics).toMatch(/"max_sample_stddev":"[0-9]+\.[0-9]{6}"/);
        expect(output.result.toolExecutions[2]!.resultPreview).toContain('Plan');
        recordRun('big-science', 'partition-statistics', output);
      } finally {
        await runtime.close();
      }
    }, 120_000);

    it('keeps a 24000-row scientific result outside Agent history and returns a bounded SDK payload', async () => {
      let resultSequence = 0;
      const resultStore = new AiSqlResultStore({
        createId: () => `science-result-${++resultSequence}`,
      });
      const provider = new ScriptedAgentProvider([
        toolCall('large-science-result', 'sql_execute', {
          sql: SCIENCE_LARGE_RESULT_SQL,
          maxRows: 2_000,
          previewRows: 3,
        }),
        finalAnswer('大结果查询已完成，最多 1000 行的交互结果已单独返回。'),
      ]);
      const runtime = await connectedRuntime(provider, 'science-bounded-result', {
        resultStore,
      });

      try {
        await runtime.indexSchema();
        const created = await runtime.runAgent({
          userId: 'acceptance-user',
          message: '查询全部科学观测并保存结果，不要把全部数据放进上下文。',
          mode: 'read',
        });
        expect(created.result.status).toBe('done');
        const execution = created.result.toolExecutions[0]!;
        expect(execution).toMatchObject({
          toolName: 'sql_execute',
          status: 'success',
        });
        expect(execution.resultPreview).not.toContain('resultHandleId');
        expect(execution.resultPreview).not.toContain('"rows"');
        expect(execution.resultPreview).toContain('"storedRowCount":1000');
        expect(execution.resultPreview).toContain('"previewTruncated":true');
        expect(execution.resultPreview).toContain('"hasMoreInDatabase":true');
        expect(execution.resultPreview.length).toBeLessThan(4_000);
        expect(created.queryResults).toHaveLength(1);
        expect(created.queryResults[0]).toMatchObject({
          executionId: 'science-result-1',
          returnedRowCount: 1_000,
          hasMore: true,
          truncated: true,
        });
        expect(created.queryResults[0]?.rows).toHaveLength(1_000);

        const firstToolResult =
          provider.requests[1]?.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === execution.toolCallId,
          )?.content ?? '';
        expect(firstToolResult.length).toBeLessThan(4_000);
        expect((JSON.parse(firstToolResult) as { rows: unknown[] }).rows).toHaveLength(2);
        const persisted = await runtime.sessions.load(created.result.session.id);
        const durableToolMessage = persisted?.messages.find(
          (message) =>
            message.role === 'tool' && message.toolCallId === execution.toolCallId,
        );
        expect(durableToolMessage?.content).not.toContain('"rows"');
        expect(durableToolMessage?.content).not.toContain('resultHandleId');
        recordRun('big-science', 'large-bounded-result', created);
      } finally {
        await runtime.close();
      }
    }, 120_000);
  },
);

describe.skipIf(!runPostgresTests || !runLiveModel)(
  'DatabaseAgentRuntime live model complex PostgreSQL scenarios',
  () => {
    it('rejects an unknown live scenario selector', () => {
      if (!process.env.DBAGENT_LIVE_SCENARIO?.trim()) return;
      expect(
        SELECTED_LIVE_SCENARIOS.length,
        `未知 DBAGENT_LIVE_SCENARIO：${process.env.DBAGENT_LIVE_SCENARIO}`,
      ).toBe(1);
    });

    it.each(SELECTED_LIVE_SCENARIOS)(
      'solves $scenario independently through the real Agent pipeline',
      async (liveCase) => {
        const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
        if (!apiKey) {
          throw new Error('需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY。');
        }
        const model =
          process.env.TEST_SILICONFLOW_MODEL ?? process.env.DBAGENT_LLM_MODEL ?? 'Qwen/Qwen3-32B';
        const runtime = await connectedRuntime(
          new OpenAICompatibleProvider({
            id: 'scenario-live',
            name: 'Scenario live provider',
            apiKey,
            baseUrl: process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
            timeoutMs: 120_000,
            maxRetries: 1,
          }),
          'scenario-live',
          { model },
        );

        let output: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>> | undefined;
        let scenarioLog: ScenarioRunLog | undefined;
        try {
          await runtime.indexSchema();
          output = await runtime.runAgent({
            userId: 'live-scenario-user',
            message: liveCase.message,
            mode: 'read',
            maxIterations: 16,
            maxToolExecutionMs: 120_000,
          });
          expect(output.result.status).toBe('done');
          expect(output.result.completion).toMatchObject({
            verified: true,
            deliveryReady: true,
            finalResponseReady: true,
            phase: 'done',
          });
          expect(isProcessOnlyFinalText(output.result.finalText)).toBe(false);
          const finalResult = output.queryResults.at(-1);
          expect(finalResult, `${liveCase.scenario} 没有最终 SQL 结果`).toBeDefined();
          expect(finalResult?.sql?.trim().length).toBeGreaterThan(0);
          const observedValues = flattenResultValues(finalResult?.rows ?? []);
          for (const expected of liveCase.expectedValues) {
            expect(
              observedValues.some((value) => value.includes(expected)),
              `${liveCase.scenario} 最终 SQL 结果缺少 ${expected}`,
            ).toBe(true);
          }
          scenarioLog = recordRun(
            liveCase.scenario,
            'real-model-agent',
            output,
            liveScenarioRunLogs,
          );
        } catch (error) {
          if (output) {
            scenarioLog = recordRun(
              liveCase.scenario,
              'real-model-agent',
              output,
              liveScenarioRunLogs,
              false,
              error,
            );
          } else {
            scenarioLog = recordFailedRun(liveCase.scenario, 'real-model-agent', error);
          }
          throw error;
        } finally {
          if (scenarioLog) await writeLiveScenarioReport(scenarioLog);
          await runtime.close();
        }
      },
      600_000,
    );
  },
);

type ScenarioRunLog = {
  scenario: string;
  step: string;
  passed: boolean;
  sessionId?: string;
  status: string;
  iterations: number;
  tools: Array<{
    name: string;
    status: string;
    durationMs: number;
    failureKind?: string;
    argumentPreview?: string;
    resultPreview: string;
  }>;
  finalText: string;
  error?: string;
  completion?: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>>['result']['completion'];
  finalQuery?: {
    sql?: string;
    returnedRowCount: number;
    hasMore: boolean;
    rows: unknown[];
  };
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

function flattenResultValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenResultValues);
  if (value instanceof Date) return [value.toISOString()];
  if (value && typeof value === 'object') {
    const tagged = value as { $type?: unknown; value?: unknown };
    if (tagged.$type === 'datetime' && typeof tagged.value === 'string') {
      return [tagged.value];
    }
    return Object.values(value).flatMap(flattenResultValues);
  }
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'bigint') return [value.toString()];
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  return [];
}

function queryResultJson(
  run: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>>,
  index: number,
): string {
  const normalizedIndex = index < 0 ? run.queryResults.length + index : index;
  const result = run.queryResults[normalizedIndex];
  if (!result) throw new Error(`Missing query result at index ${index}.`);
  return JSON.stringify(result.rows);
}

function recordRun(
  scenario: string,
  step: string,
  run: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>>,
  target: ScenarioRunLog[] = scenarioRunLogs,
  passed = true,
  error?: unknown,
): ScenarioRunLog {
  const finalQuery = run.queryResults.at(-1);
  const log: ScenarioRunLog = {
    scenario,
    step,
    passed,
    sessionId: run.result.session.id,
    status: run.result.status,
    iterations: run.result.iterations,
    tools: run.result.toolExecutions.map((tool) => ({
      name: tool.toolName,
      status: tool.status,
      durationMs: tool.durationMs,
      ...(tool.failureKind === undefined ? {} : { failureKind: tool.failureKind }),
      ...(tool.argumentPreview === undefined
        ? {}
        : {
            argumentPreview:
              tool.argumentPreview.length <= 4_000
                ? tool.argumentPreview
                : `${tool.argumentPreview.slice(0, 3_985)}...[truncated]`,
          }),
      resultPreview:
        tool.resultPreview.length <= 1_500
          ? tool.resultPreview
          : `${tool.resultPreview.slice(0, 1_485)}...[truncated]`,
    })),
    finalText: run.result.finalText,
    ...(run.result.completion === undefined
      ? {}
      : { completion: structuredClone(run.result.completion) }),
    ...(error === undefined
      ? {}
      : { error: describeUnknownError(error) }),
    ...(finalQuery === undefined
      ? {}
      : {
          finalQuery: {
            ...(finalQuery.sql === undefined ? {} : { sql: finalQuery.sql }),
            returnedRowCount: finalQuery.returnedRowCount,
            hasMore: finalQuery.hasMore,
            rows: structuredClone(finalQuery.rows.slice(0, 20)),
          },
        }),
    tokenUsage: { ...run.result.session.tokenUsage },
  };
  target.push(log);
  return log;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

function recordFailedRun(scenario: string, step: string, error: unknown): ScenarioRunLog {
  const log: ScenarioRunLog = {
    scenario,
    step,
    passed: false,
    status: 'failed_before_agent_result',
    iterations: 0,
    tools: [],
    finalText: '',
    error: describeUnknownError(error),
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
  liveScenarioRunLogs.push(log);
  return log;
}

async function writeLiveScenarioReport(log: ScenarioRunLog): Promise<void> {
  await mkdir(liveScenarioReportDirectory, { recursive: true });
  await writeFile(
    join(liveScenarioReportDirectory, `${log.scenario}.json`),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
        provider: 'SiliconFlow OpenAI-compatible',
        model:
          process.env.TEST_SILICONFLOW_MODEL ?? process.env.DBAGENT_LLM_MODEL ?? 'Qwen/Qwen3-32B',
        run: log,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function isProcessOnlyFinalText(text: string): boolean {
  return /(?:let me|i(?:'ll| will)|让我|我来|接下来|下一步|正在).{0,60}(?:verify|check|验证|检查|继续|确认)/i.test(
    text,
  );
}

async function connectedRuntime(
  provider: LlmProvider,
  name: string,
  overrides: Omit<DatabaseAgentRuntimeOptions, 'provider' | 'sessionDatabasePath'> = {},
): Promise<DatabaseAgentRuntime> {
  const directory = await mkdtemp(join(tmpdir(), `dbagent-${name}-`));
  tempDirectories.push(directory);
  const runtime = new DatabaseAgentRuntime({
    ...overrides,
    provider,
    model: overrides.model ?? 'deterministic-scenario-model',
    sessionDatabasePath: join(directory, 'agent.db'),
  });
  await runtime.connect({
    name: `PostgreSQL scenario ${name}`,
    host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
    database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
    username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  });
  return runtime;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
    usage: { promptTokens: 240, completionTokens: 48, totalTokens: 288 },
  };
}

function finalAnswer(text: string): LlmChatResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 240, completionTokens: 48, totalTokens: 288 },
  };
}

class ScriptedAgentProvider implements LlmProvider {
  readonly id = 'scripted-postgres-scenarios';
  readonly name = 'Scripted PostgreSQL scenario provider';
  readonly mode = 'byok' as const;
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly responses: LlmChatResponse[]) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted scenario response remains.');
    return Promise.resolve(structuredClone(response));
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

const ECOMMERCE_FINANCE_SQL = `
  WITH settled_payments AS (
    SELECT
      order_id,
      sum(paid_amount)::numeric(14, 2) AS paid_amount
    FROM commerce.payments
    WHERE status = 'settled'
    GROUP BY order_id
  ),
  successful_refunds AS (
    SELECT
      p.order_id,
      sum(r.refund_amount)::numeric(14, 2) AS refund_amount
    FROM commerce.refunds r
    JOIN commerce.payments p ON p.payment_id = r.payment_id
    WHERE r.status = 'succeeded'
    GROUP BY p.order_id
  ),
  order_finance AS (
    SELECT
      o.order_id,
      o.order_no,
      date_trunc('month', o.created_at AT TIME ZONE 'Asia/Shanghai')::date
        AS month,
      o.channel,
      c.customer_no,
      sp.paid_amount,
      coalesce(sr.refund_amount, 0)::numeric(14, 2) AS refund_amount,
      (sp.paid_amount - coalesce(sr.refund_amount, 0))::numeric(14, 2)
        AS net_revenue
    FROM commerce.orders o
    JOIN commerce.customers c ON c.customer_id = o.customer_id
    JOIN settled_payments sp ON sp.order_id = o.order_id
    LEFT JOIN successful_refunds sr ON sr.order_id = o.order_id
  ),
  ranked AS (
    SELECT
      order_finance.*,
      row_number() OVER (
        PARTITION BY month, channel
        ORDER BY net_revenue DESC, order_id
      ) AS revenue_rank
    FROM order_finance
  )
  SELECT
    to_char(r.month, 'YYYY-MM') AS month,
    r.channel,
    count(DISTINCT r.customer_no)::bigint AS customer_count,
    sum(r.paid_amount)::numeric(14, 2) AS settled_amount,
    sum(r.refund_amount)::numeric(14, 2) AS refunded_amount,
    sum(r.net_revenue)::numeric(14, 2) AS net_revenue,
    t."目标净收入" AS target_net_revenue,
    (sum(r.net_revenue) - t."目标净收入")::numeric(14, 2)
      AS target_variance,
    max(r.order_no) FILTER (WHERE r.revenue_rank = 1) AS top_order_no
  FROM ranked r
  JOIN "电商运营"."渠道目标" t
    ON t."月份" = r.month
   AND t."渠道" = r.channel
  GROUP BY r.month, r.channel, t."目标净收入"
  ORDER BY r.month, r.channel
`;

const ECOMMERCE_INVENTORY_UPDATE_SQL = `
  UPDATE commerce.inventory AS i
  SET
    reserved_qty = i.reserved_qty + 2,
    updated_at = '2026-03-02 00:00:00+00'
  FROM commerce.warehouses AS w, commerce.products AS p
  WHERE i.warehouse_id = w.warehouse_id
    AND i.product_id = p.product_id
    AND w.warehouse_code = 'WH-SH-01'
    AND p.sku = 'EC-KEYBOARD'
    AND i.reserved_qty + 2 <= i.on_hand_qty
`;

const ECOMMERCE_INVENTORY_VERIFY_SQL = `
  SELECT
    w.warehouse_code,
    p.sku,
    i.on_hand_qty,
    i.reserved_qty,
    i.on_hand_qty - i.reserved_qty AS available_qty
  FROM commerce.inventory i
  JOIN commerce.warehouses w ON w.warehouse_id = i.warehouse_id
  JOIN commerce.products p ON p.product_id = i.product_id
  WHERE w.warehouse_code = 'WH-SH-01'
    AND p.sku = 'EC-KEYBOARD'
`;

const ECOMMERCE_DDL_SQL = `
  CREATE TABLE commerce.permission_probe (
    probe_id bigint PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;

const TRAFFIC_CLEANING_SQL = `
  WITH extracted AS MATERIALIZED (
    SELECT
      nullif(value ->> 'event_id', '') AS event_id,
      nullif(value ->> 'visitor_id', '') AS visitor_id,
      value ->> 'event_type' AS event_type,
      CASE
        WHEN value ->> 'event_time'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        THEN (value ->> 'event_time')::timestamptz
      END AS event_time,
      CASE
        WHEN value ->> 'ingested_at'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        THEN (value ->> 'ingested_at')::timestamptz
      END AS ingested_at,
      CASE
        WHEN value ->> 'latency_ms' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (value ->> 'latency_ms')::numeric
      END AS latency_ms
    FROM traffic_lab.raw_kafka_events
  ),
  validated AS (
    SELECT
      e.event_id,
      e.event_time,
      e.ingested_at,
      e.latency_ms,
      row_number() OVER (
        PARTITION BY e.event_id
        ORDER BY e.ingested_at DESC NULLS LAST
      ) AS duplicate_rank
    FROM extracted e
    JOIN traffic_lab.event_type_dictionary d
      ON d.event_type = e.event_type
     AND d.active
    WHERE e.event_id IS NOT NULL
      AND e.visitor_id IS NOT NULL
      AND e.event_time IS NOT NULL
      AND e.ingested_at IS NOT NULL
      AND e.latency_ms IS NOT NULL
  ),
  deduplicated AS (
    SELECT event_time, latency_ms
    FROM validated
    WHERE duplicate_rank = 1
  ),
  bucketed AS (
    SELECT
      date_trunc('minute', event_time) AS minute,
      count(*)::bigint AS event_count,
      avg(latency_ms) AS avg_latency_ms,
      count(*) FILTER (
        WHERE latency_ms > (
          SELECT threshold
          FROM traffic_lab.anomaly_thresholds
          WHERE metric_name = 'latency_ms'
        )
      )::bigint AS high_latency_events
    FROM deduplicated
    GROUP BY 1
  )
  SELECT
    minute,
    event_count,
    round(avg_latency_ms, 2) AS avg_latency_ms,
    high_latency_events,
    event_count > (
      SELECT threshold
      FROM traffic_lab.anomaly_thresholds
      WHERE metric_name = 'events_per_minute'
    ) AS volume_anomaly
  FROM bucketed
  ORDER BY minute
`;

const SCIENCE_PARTITION_SQL = `
  SELECT
    tableoid::regclass::text AS partition_name,
    count(*)::bigint AS observation_count
  FROM science.observations
  GROUP BY tableoid
  ORDER BY partition_name
`;

const SCIENCE_STATISTICS_SQL = `
  WITH calibrated AS (
    SELECT
      e.experiment_code,
      s.sample_code,
      (o.signal - o.background)::numeric(24, 8) AS net_signal
    FROM science.observations o
    JOIN science.experiments e
      ON e.experiment_id = o.experiment_id
    JOIN science.samples s
      ON s.sample_id = o.sample_id
    WHERE o.observed_at >= '2026-01-01 00:00:00+00'
      AND o.observed_at < '2026-03-01 00:00:00+00'
  ),
  sample_statistics AS (
    SELECT
      experiment_code,
      sample_code,
      count(*)::bigint AS observation_count,
      avg(net_signal) AS mean_net_signal,
      stddev_samp(net_signal) AS stddev_net_signal
    FROM calibrated
    GROUP BY experiment_code, sample_code
  ),
  ranked_samples AS (
    SELECT
      sample_statistics.*,
      dense_rank() OVER (
        PARTITION BY experiment_code
        ORDER BY mean_net_signal DESC, sample_code
      ) AS signal_rank
    FROM sample_statistics
  )
  SELECT
    experiment_code,
    count(*)::bigint AS sample_count,
    sum(observation_count)::bigint AS observation_count,
    round(avg(mean_net_signal), 6) AS mean_of_sample_means,
    round(max(stddev_net_signal), 6) AS max_sample_stddev,
    max(sample_code) FILTER (WHERE signal_rank = 1) AS top_sample
  FROM ranked_samples
  GROUP BY experiment_code
  ORDER BY experiment_code
`;

const SCIENCE_LARGE_RESULT_SQL = `
  SELECT
    observation_id,
    experiment_id,
    sample_id,
    instrument_id,
    observed_at,
    signal,
    background,
    quality_flags,
    metadata
  FROM science.observations
  ORDER BY observed_at, observation_id
`;
