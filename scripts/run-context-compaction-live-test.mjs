#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateTextTokens,
  LlmConnectionManager,
  ModelExecutionGateway,
} from '../packages/core-llm/dist/index.js';
import { ContextLifecycle } from '../packages/core-agent/dist/context/context-lifecycle.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiKey = process.env.TEST_SILICONFLOW_API_KEY;
const model = process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro';
const endpoint = process.env.TEST_SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1';
const reportPath = join(root, 'reports', 'agent-runtime', 'context-compaction-live.json');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-context-live-'));
const report = {
  schemaVersion: 2,
  kind: 'context-compaction-live',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  endpoint: publicEndpoint(endpoint),
  model,
  scope:
    'Live summary quality only. Durable manual-command, safe-boundary, checkpoint and replay behavior is covered by deterministic Agent Journal tests.',
};
let failure;

class RecordingGateway {
  constructor() {
    this.inner = new ModelExecutionGateway();
    this.requests = [];
  }

  executeAttempt(session, request, options) {
    this.requests.push(structuredClone(request));
    return this.inner.executeAttempt(session, request, options);
  }
}

try {
  if (!apiKey) throw new Error('TEST_SILICONFLOW_API_KEY is required.');

  const manager = new LlmConnectionManager({
    cacheDirectory: join(temporaryDirectory, 'llm-catalog'),
  });
  const [connection] = manager.replaceConnections([
    {
      name: 'context-live',
      endpoint,
      apiKey,
      connectionConfigurationRevision: 'context-live-config-v1',
      credentialRevision: 'context-live-credential-v1',
    },
  ]);
  if (!connection) throw new Error('The context-compaction LLM connection was not created.');
  await manager.discover(connection.id, { inspectModelIds: [model] });

  const selection = { connectionId: connection.id, modelId: model };
  const prepared = await manager.prepare(selection);
  const session = await manager.prepareModelSessionBundle(selection, {
    generation: { temperature: 0 },
  });
  const gateway = new RecordingGateway();
  const lifecycle = new ContextLifecycle({ gateway, session });
  const messages = createCommittedSemanticHistory();
  const sourceText = messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
    .map((block) => block.text)
    .join('\n');
  const sourceTokenEstimate = estimateTextTokens(sourceText);

  const startedAt = performance.now();
  const result = await lifecycle.compact({
    decisionId: 'context-live-manual-v2',
    committedThroughSequence: messages.length,
    messages,
  });
  const latencyMs = performance.now() - startedAt;
  const summaryTokenEstimate = estimateTextTokens(result.summary);
  const requiredFacts = [
    'public.events',
    'value.customer.province',
    'value.amount',
    '1726.50',
    '"供应链"."采购订单"',
    '56000.00',
    'read',
  ];
  const exactFactsPreserved = Object.fromEntries(
    requiredFacts.map((fact) => [fact, result.summary.includes(fact)]),
  );
  const serializedRequests = JSON.stringify(gateway.requests);
  const forbiddenMetadata = [
    'internal-call-',
    'coveredConversationMessageCount',
    'activeCheckpointSequence',
    'catalogRootHash',
    'localHash',
    'treeIndex',
    'protocolEnvelopeRef',
  ];
  const checks = {
    compacted: result.status === 'compacted',
    exactDecisionBoundary:
      result.decisionId === 'context-live-manual-v2' &&
      result.committedThroughSequence === messages.length,
    exactlyOneModelAttempt: gateway.requests.length === 1,
    allExactFactsPreserved: Object.values(exactFactsPreserved).every(Boolean),
    internalMetadataExcluded: forbiddenMetadata.every(
      (marker) => !serializedRequests.includes(marker) && !result.summary.includes(marker),
    ),
    effectiveCompression: sourceTokenEstimate > summaryTokenEstimate * 2,
  };
  const passed = Object.values(checks).every(Boolean);
  Object.assign(report, {
    status: passed ? 'passed' : 'failed',
    latencyMs: round(latencyMs),
    route: {
      protocol: prepared.route.protocol,
      codecRevision: session.primary.route.codecRevision,
    },
    modelMetadata: {
      contextTokens: prepared.model.contextTokens.value,
      maxInputTokens: prepared.model.maxInputTokens.value,
      maxOutputTokens: prepared.model.maxOutputTokens.value,
    },
    input: {
      committedMessages: messages.length,
      sourceTokenEstimate,
      modelAttempts: gateway.requests.length,
    },
    output: {
      summaryTokenEstimate,
      estimatedCompressionRatio: round(sourceTokenEstimate / summaryTokenEstimate),
      usage: result.usage ?? null,
    },
    exactFactsPreserved,
    checks,
    summary: result.summary,
    note:
      'This gated command measures one real provider summary. It is not a provider SLA and never loads product .env files or writes credentials.',
  });
  if (!passed) failure = new Error('Context-compaction live acceptance checks did not all pass.');
} catch (error) {
  failure = error;
  Object.assign(report, { error: publicError(error, apiKey) });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
}

if (failure) throw failure;

function createCommittedSemanticHistory() {
  const messages = [
    textMessage(
      'user',
      [
        '压缩时必须逐字保留以下数据库标识符、数值和权限模式。',
        '目标：分析 public.events 的 JSONB 数据。',
        'JSON 路径是 value.customer.province 和 value.amount。',
        "已确认 SQL：SELECT value #>> '{customer,province}' AS province, sum((value #>> '{amount}')::numeric) AS total_amount FROM public.events GROUP BY 1。",
        '上海的精确结果是 1726.50。',
        '中文对象是 "供应链"."采购订单"，江苏采购总额是 56000.00。',
        '当前权限模式是 read。',
        '未完成事项：核对退款事件是否应从金额中扣除。',
      ].join('\n'),
    ),
  ];
  for (let index = 1; index <= 24; index += 1) {
    messages.push(
      textMessage(
        'assistant',
        `第 ${index} 轮已核对已提交事实；没有改变 SQL、标识符、精确金额或 read 权限，退款扣减仍待确认。`,
      ),
      textMessage(
        'user',
        `第 ${index} 轮确认：public.events 的 value.customer.province、value.amount、1726.50 与 "供应链"."采购订单" 的 56000.00 都必须保持原样。`,
      ),
    );
  }
  return messages;
}

function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function publicEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
}

function publicError(error, secret) {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : 'Error',
    code:
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null,
    message: secret ? raw.replaceAll(secret, '[REDACTED]') : raw,
  };
}
