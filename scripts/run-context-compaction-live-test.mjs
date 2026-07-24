#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenAICompatibleProvider,
} from '../packages/core-llm/dist/index.js';
import {
  appendMessage,
  createAgentSession,
  createMessage,
} from '../packages/core-agent/dist/index.js';
import { DatabaseAgentRuntime } from '../packages/sdk/dist/index.js';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await loadEnvFile(join(root, '.env'));
const apiKey =
  process.env.TEST_SILICONFLOW_API_KEY ??
  process.env.DBAGENT_LLM_API_KEY;
assert.ok(
  apiKey,
  '需要在环境变量或 .env 中配置 TEST_SILICONFLOW_API_KEY。',
);
const model =
  process.env.TEST_SILICONFLOW_MODEL ??
  process.env.DBAGENT_LLM_MODEL ??
  'Qwen/Qwen3-32B';
const baseUrl =
  process.env.DBAGENT_LLM_BASE_URL ??
  'https://api.siliconflow.cn/v1';
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'dbagent-context-live-'),
);

class RecordingProvider {
  constructor(inner) {
    this.inner = inner;
    this.id = inner.id;
    this.name = inner.name;
    this.mode = inner.mode;
    this.protocol = inner.protocol;
    this.capabilities = inner.capabilities;
    this.requests = [];
    this.errors = [];
  }

  async chat(request) {
    this.requests.push(structuredClone(request));
    try {
      return await this.inner.chat(request);
    } catch (error) {
      this.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  isAvailable(model, signal) {
    return this.inner.isAvailable(model, signal);
  }
}

const innerProvider = new OpenAICompatibleProvider({
  id: 'siliconflow-context-live',
  name: 'SiliconFlow context compaction live test',
  apiKey,
  baseUrl,
  timeoutMs: 120_000,
  maxRetries: 1,
});
const provider = new RecordingProvider(innerProvider);
const runtime = new DatabaseAgentRuntime({
  provider,
  model,
  sessionDatabasePath: join(temporaryDirectory, 'agent.db'),
});
const session = createLiveSession();
const originalMessages = structuredClone(session.messages);
const startedAt = performance.now();

try {
  const result = await runtime.compactAgentSession({
    session,
    focus:
      '重点保留精确 SQL、数据库标识符、数值、权限决定、已完成结果和未完成事项；不要保留工具调用 ID 或内部索引。',
  });
  const latencyMs = performance.now() - startedAt;
  assert.equal(result.status, 'compacted');
  assert.equal(
    result.checkpoint?.method,
    'model',
    `真实模型压缩降级：${provider.errors.join(' | ') || '模型返回空摘要'}`,
  );
  assert.equal(result.checkpoint?.trigger, 'manual');
  assert.deepEqual(result.session.messages, originalMessages);
  assert.ok(result.checkpoint);

  const requiredFacts = [
    'public.events',
    'value.customer.province',
    'value.amount',
    '1726.50',
    '"供应链"."采购订单"',
    '56000.00',
    'read',
  ];
  const preservation = Object.fromEntries(
    requiredFacts.map((fact) => [
      fact,
      result.checkpoint.summary.includes(fact),
    ]),
  );
  for (const [fact, preserved] of Object.entries(preservation)) {
    assert.equal(preserved, true, `真实模型摘要丢失关键事实：${fact}`);
  }
  assert.doesNotMatch(result.checkpoint.summary, /internal-call-/);
  assert.ok(
    result.checkpoint.sourceTokenEstimate >
      result.checkpoint.summaryTokenEstimate * 2,
    '真实模型摘要没有产生有效压缩。',
  );
  assert.ok(
    result.report.finalTokenEstimate <=
      result.report.availablePromptTokens,
    '压缩后模型工作上下文仍超过物理窗口。',
  );

  const serializedRequests = JSON.stringify(
    provider.requests.map((request) => request.messages),
  );
  for (const forbidden of [
    'internal-call-',
    'coveredConversationMessageCount',
    'activeCheckpointSequence',
    'catalogRootHash',
    'localHash',
    'treeIndex',
  ]) {
    assert.doesNotMatch(
      serializedRequests,
      new RegExp(escapeRegExp(forbidden)),
      `压缩请求泄露内部字段：${forbidden}`,
    );
  }
  const persisted = await runtime.sessions.load(session.id);
  assert.deepEqual(persisted?.messages, originalMessages);
  const checkpoints = await runtime.agentContextCheckpoints(session.id);
  assert.deepEqual(
    checkpoints.map((checkpoint) => ({
      sequence: checkpoint.sequence,
      trigger: checkpoint.trigger,
      method: checkpoint.method,
    })),
    [{ sequence: 1, trigger: 'manual', method: 'model' }],
  );

  const report = {
    kind: 'context-compaction-live',
    status: 'passed',
    generatedAt: new Date().toISOString(),
    provider: 'siliconflow',
    model,
    latencyMs: round(latencyMs),
    input: {
      fullSessionMessages: originalMessages.length,
      coveredMessages:
        result.checkpoint.coveredConversationMessageCount,
      retainedRecentMessages:
        originalMessages.length -
        result.checkpoint.coveredConversationMessageCount,
      compactionRequests: provider.requests.length,
    },
    tokens: {
      sourceEstimate: result.checkpoint.sourceTokenEstimate,
      summaryEstimate: result.checkpoint.summaryTokenEstimate,
      estimatedCompressionRatio: round(
        result.checkpoint.sourceTokenEstimate /
          result.checkpoint.summaryTokenEstimate,
      ),
      providerReportedSessionUsage: result.session.tokenUsage,
    },
    checks: {
      modelSummaryUsed: result.checkpoint.method === 'model',
      exactFactsPreserved: preservation,
      fullSessionUnchanged: true,
      checkpointPersisted: checkpoints.length === 1,
      internalMetadataExcluded: true,
      postCompactionContextFitsModel:
        result.report.finalTokenEstimate <=
        result.report.availablePromptTokens,
    },
    summary: result.checkpoint.summary,
    note:
      '真实 Endpoint 单场景质量验证，不代表供应商 SLA；报告不包含 API Key。',
  };
  const reportPath = join(
    root,
    'reports',
    'ai-sql',
    'context-compaction-live.json',
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`,
  );
} finally {
  await runtime.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function createLiveSession() {
  const now = () => '2026-07-24T00:00:00.000Z';
  const output = createAgentSession({
    id: 'context-live-session',
    title: '真实模型上下文压缩',
    mode: 'read',
    userId: 'live-context-user',
    now,
  });
  appendMessage(
    output,
    createMessage(
      {
        role: 'system',
        content:
          '你是数据库分析 Agent。当前权限为 read，只能执行只读查询。',
      },
      now,
    ),
  );
  appendMessage(
    output,
    createMessage(
      {
        role: 'user',
        content: [
          '目标：分析 public.events 的 JSONB 数据。',
          'JSON 路径必须精确保留为 value.customer.province 和 value.amount。',
          '已确认 SQL：SELECT value #>> \'{customer,province}\' AS province, sum((value #>> \'{amount}\')::numeric) AS total_amount FROM public.events GROUP BY 1。',
          '上海的精确结果是 1726.50。',
          '同时记录中文对象 "供应链"."采购订单"，江苏采购总额为 56000.00。',
          '当前权限决定是 read，禁止写入。',
          '未完成事项：核对退款事件是否应从金额中扣除。',
        ].join('\n'),
      },
      now,
    ),
  );
  for (let index = 1; index <= 20; index += 1) {
    appendMessage(
      output,
      createMessage(
        {
          role: 'assistant',
          content: `第 ${index} 轮继续核对事件数据和订单事实。`,
          toolCalls: [
            {
              id: `internal-call-${index}`,
              name: 'query_database',
              arguments: {
                sql:
                  index % 2 === 0
                    ? 'SELECT value #>> \'{customer,province}\' AS province, sum((value #>> \'{amount}\')::numeric) AS total_amount FROM public.events GROUP BY 1'
                    : 'SELECT "供应商ID", sum("含税金额") FROM "供应链"."采购订单" GROUP BY 1',
              },
            },
          ],
        },
        now,
      ),
    );
    appendMessage(
      output,
      createMessage(
        {
          role: 'tool',
          toolCallId: `internal-call-${index}`,
          toolName: 'query_database',
          content: JSON.stringify({
            round: index,
            status: 'succeeded',
            permission: 'read',
            observed:
              index % 2 === 0
                ? {
                    table: 'public.events',
                    provincePath: 'value.customer.province',
                    amountPath: 'value.amount',
                    province: 'Shanghai',
                    totalAmount: '1726.50',
                  }
                : {
                    table: '"供应链"."采购订单"',
                    province: '江苏',
                    totalAmount: '56000.00',
                  },
            pending: '核对退款事件是否应从金额中扣除',
          }),
        },
        now,
      ),
    );
    appendMessage(
      output,
      createMessage(
        {
          role: 'user',
          content: `第 ${index} 轮确认：保留原始标识符和精确数值，继续只读分析，不要把假设写成事实。`,
        },
        now,
      ),
    );
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
