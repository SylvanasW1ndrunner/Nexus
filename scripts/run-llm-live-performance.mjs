#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, GlobalConfigStore } from '../packages/agent-host/dist/index.js';
import { LlmConnectionManager } from '../packages/core-llm/dist/index.js';
import {
  boundedLiveMaxOutputTokens,
  normalizeLiveMaxOutputTokens,
} from './lib/live-llm-acceptance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const apiKey =
  process.env.TEST_LLM_API_KEY ??
  process.env.TEST_SILICONFLOW_API_KEY;
const endpoint =
  process.env.TEST_LLM_ENDPOINT ??
  process.env.TEST_SILICONFLOW_BASE_URL ??
  'https://api.siliconflow.cn/v1';
const requestedModel =
  process.env.TEST_LLM_MODEL ??
  process.env.TEST_SILICONFLOW_MODEL ??
  'deepseek-ai/DeepSeek-V4-Pro';
const sampleCount = normalizeSampleCount(process.env.TEST_LLM_LIVE_SAMPLES);
const requestedMaxOutputTokens = normalizeLiveMaxOutputTokens(
  process.env.TEST_LLM_MAX_OUTPUT_TOKENS,
);
const reportPath = join(root, 'reports', 'llm-platform', 'live-performance.json');
const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-llm-live-performance-'));
const llmManager = new LlmConnectionManager({ cacheDirectory: join(projectDirectory, 'llm-cache') });
if (apiKey) llmManager.replaceConnections([{ name: 'live-performance', endpoint, apiKey }]);
const runtime = new AgentRuntime({
  projectDirectory,
  stateDatabasePath: join(projectDirectory, 'sessions.db'),
  llmManager,
  globalConfigStore: new GlobalConfigStore({ path: join(projectDirectory, 'config.toml') }),
});
const report = {
  kind: 'llm-live-performance',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  endpoint: publicEndpoint(endpoint),
  requestedModel,
  sampleCount,
};
let failure;

try {
  assert.ok(apiKey, 'TEST_LLM_API_KEY is required for the live performance test.');
  await runtime.ready();
  const connection = runtime.listLlmConnections()[0];
  assert.ok(connection, 'The injected LLM connection was not visible to the runtime.');

  const discoveryStartedAt = performance.now();
  const discovery = await runtime.discoverLlmConnection({
    connectionId: connection.id,
    inspectModelIds: [requestedModel],
  });
  const discoveryLatencyMs = performance.now() - discoveryStartedAt;
  const prepared = await runtime.previewModelParameters({
    connectionId: connection.id,
    modelId: requestedModel,
  });
  const model = discovery.catalog.models.find((candidate) => candidate.modelId === requestedModel);
  assert.ok(model, `Endpoint does not advertise ${requestedModel}.`);
  const selection = { connectionId: connection.id, modelId: model.modelId };
  const maxOutputTokens = boundedLiveMaxOutputTokens(
    requestedMaxOutputTokens,
    prepared.maxOutputTokens,
  );
  const parameters = {
    ...(model.generationParameters.temperature.value === 'unsupported'
      ? {}
      : { temperature: 0 }),
    // Reasoning models can consume a small limit before emitting visible text.
    // This remains a test-request parameter; it is not a context-window override.
    maxTokens: maxOutputTokens,
  };

  const prompts = [
    'Reply with exactly: OK',
    'In no more than 30 Chinese characters, explain read-only SQL.',
    'Return one JSON line only: {"name":"users","type":"table"}',
  ];
  const syncSamples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    const response = await runtime.llmChat(
      {
        messages: [{ role: 'user', content: prompts[index % prompts.length] }],
        ...parameters,
      },
      {
        model: selection,
        taskType: 'live-performance',
        timeoutMs: 120_000,
        maxRetries: 1,
      },
    );
    const latencyMs = performance.now() - startedAt;
    assert.ok(response.text.trim(), `Synchronous sample ${index + 1} returned empty text.`);
    syncSamples.push({
      latencyMs,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      totalTokens: response.usage?.totalTokens ?? 0,
      usageEstimated: response.usage?.estimated ?? false,
    });
  }

  const streamStartedAt = performance.now();
  let firstEventMs;
  let firstVisibleTextMs;
  let streamText = '';
  let streamUsage;
  let streamFinished = false;
  for await (const event of runtime.llmStream(
    {
      messages: [
        { role: 'user', content: 'In no more than 20 Chinese characters, explain a database index.' },
      ],
      ...parameters,
    },
    {
      model: selection,
      taskType: 'live-performance-stream',
      timeoutMs: 120_000,
      maxRetries: 1,
    },
  )) {
    firstEventMs ??= performance.now() - streamStartedAt;
    if (event.type === 'text-delta') {
      firstVisibleTextMs ??= performance.now() - streamStartedAt;
      streamText += event.text;
    } else if (event.type === 'usage') {
      streamUsage = event.usage;
    } else if (event.type === 'finish') {
      streamFinished = true;
      streamUsage ??= event.response.usage;
    }
  }
  const streamLatencyMs = performance.now() - streamStartedAt;
  assert.ok(streamFinished, 'The stream did not return a finish event.');
  assert.ok(streamText.trim(), 'The stream returned no visible text.');

  const latencies = syncSamples.map((sample) => sample.latencyMs);
  const totals = syncSamples.reduce(
    (sum, sample) => ({
      promptTokens: sum.promptTokens + sample.promptTokens,
      completionTokens: sum.completionTokens + sample.completionTokens,
      totalTokens: sum.totalTokens + sample.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  Object.assign(report, {
    status: 'passed',
    connection: {
      id: connection.id,
      pluginId: discovery.resolution.pluginId,
      protocol: discovery.resolution.protocol,
    },
    model: {
      id: model.modelId,
      contextTokens: model.contextTokens,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
    },
    effectiveParameters: parameters,
    discoveryLatencyMs: round(discoveryLatencyMs),
    sync: {
      latencyMs: summarize(latencies),
      usage: totals,
      allUsageReportedByProvider: syncSamples.every(
        (sample) => !sample.usageEstimated && sample.totalTokens > 0,
      ),
    },
    stream: {
      firstEventMs: nullableRound(firstEventMs),
      firstVisibleTextMs: nullableRound(firstVisibleTextMs),
      totalLatencyMs: round(streamLatencyMs),
      usage: streamUsage ?? null,
    },
    note: 'Live endpoint sample; network and model latency are reported separately from local runtime benchmarks.',
  });
} catch (error) {
  failure = error;
  Object.assign(report, { error: publicError(error, apiKey) });
} finally {
  await runtime.close().catch(() => undefined);
  await rm(projectDirectory, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
}

if (failure) throw failure;

function normalizeSampleCount(value) {
  if (value === undefined || value === '') return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('TEST_LLM_LIVE_SAMPLES must be an integer from 1 through 20.');
  }
  return parsed;
}

function summarize(values) {
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function nullableRound(value) {
  return value === undefined ? null : round(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
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
