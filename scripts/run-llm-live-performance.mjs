import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider } from '../packages/core-llm/dist/index.js';
import { DatabaseAgentRuntime } from '../packages/sdk/dist/index.js';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await loadEnvFile(join(root, '.env'));

const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
assert.ok(apiKey, '需要在环境变量或 .env 中配置 TEST_SILICONFLOW_API_KEY。');
const model =
  process.env.TEST_SILICONFLOW_MODEL ??
  process.env.DBAGENT_LLM_MODEL ??
  'deepseek-ai/DeepSeek-V4-Pro';
const baseUrl = process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1';
const sampleCount = normalizeSampleCount(process.env.DBAGENT_LLM_LIVE_SAMPLES);

const provider = new OpenAICompatibleProvider({
  id: 'siliconflow-live-performance',
  name: 'SiliconFlow live performance',
  baseUrl,
  apiKey,
  timeoutMs: 120_000,
  maxRetries: 0,
});
const runtime = new DatabaseAgentRuntime({
  tenantId: 'live-performance',
  provider,
  model,
});

const prompts = [
  '只回复“OK”。',
  '用一句不超过 30 个汉字的话说明只读 SQL 的含义。',
  '只返回一行 JSON：{"name":"users","type":"table"}',
];
const syncSamples = [];

for (let index = 0; index < sampleCount; index += 1) {
  const startedAt = performance.now();
  const response = await runtime.llmChat(
    {
      messages: [{ role: 'user', content: prompts[index % prompts.length] }],
      temperature: 0,
      maxTokens: 96,
    },
    {
      taskType: 'live-performance',
      timeoutMs: 120_000,
      maxRetries: 0,
      maxFallbacks: 0,
    },
  );
  const latencyMs = performance.now() - startedAt;
  assert.ok(response.text.trim(), `第 ${index + 1} 个同步请求返回了空文本。`);
  syncSamples.push({
    latencyMs,
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
    totalTokens: response.usage?.totalTokens ?? 0,
    usageEstimated: response.usage?.estimated ?? false,
  });
}

const streamStartedAt = performance.now();
let firstTokenMs;
let streamText = '';
let streamUsage;
let streamFinished = false;
for await (const event of runtime.llmStream(
  {
    messages: [{ role: 'user', content: '用一句不超过 20 个汉字的话说明数据库索引的作用。' }],
    temperature: 0,
    maxTokens: 96,
  },
  {
    taskType: 'live-performance-stream',
    timeoutMs: 120_000,
    maxRetries: 0,
    maxFallbacks: 0,
  },
)) {
  if (event.type === 'text-delta') {
    firstTokenMs ??= performance.now() - streamStartedAt;
    streamText += event.text;
  } else if (event.type === 'usage') {
    streamUsage = event.usage;
  } else if (event.type === 'finish') {
    streamFinished = true;
    streamUsage ??= event.response.usage;
  }
}
const streamLatencyMs = performance.now() - streamStartedAt;
assert.ok(streamFinished, '流式请求未返回 finish 事件。');
assert.ok(streamText.trim(), '流式请求返回了空文本。');

const latencies = syncSamples.map((sample) => sample.latencyMs);
const totals = syncSamples.reduce(
  (sum, sample) => ({
    promptTokens: sum.promptTokens + sample.promptTokens,
    completionTokens: sum.completionTokens + sample.completionTokens,
    totalTokens: sum.totalTokens + sample.totalTokens,
  }),
  { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
);
const report = {
  kind: 'llm-live-performance',
  status: 'passed',
  generatedAt: new Date().toISOString(),
  provider: 'siliconflow',
  model,
  sampleCount,
  sync: {
    latencyMs: {
      min: round(Math.min(...latencies)),
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      max: round(Math.max(...latencies)),
      mean: round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    },
    usage: totals,
    allUsageReportedByProvider: syncSamples.every((sample) => !sample.usageEstimated && sample.totalTokens > 0),
  },
  stream: {
    firstTokenMs: firstTokenMs === undefined ? null : round(firstTokenMs),
    totalLatencyMs: round(streamLatencyMs),
    usage: streamUsage ?? null,
  },
  note: '真实 Endpoint 小样本，仅用于当前环境基线，不代表供应商 SLA 或并发容量。',
};

const reportPath = join(root, 'reports', 'llm-platform', 'live-performance.json');
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);

function normalizeSampleCount(value) {
  if (value === undefined || value === '') return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('DBAGENT_LLM_LIVE_SAMPLES 必须是 1 到 20 的整数。');
  }
  return parsed;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
