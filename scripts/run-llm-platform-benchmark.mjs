#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  LlmConnectionManager,
  StructuredOutputValidator,
  estimateTextTokens,
  mergeLlmCatalogModel,
} from '../packages/core-llm/dist/index.js';
import { UsageTracker } from '../packages/core-usage/dist/index.js';
import { DirectLlmRuntime, ProjectSettingsStore } from '../packages/agent-host/dist/index.js';

const SAMPLES = positiveInteger(process.env.DBAGENT_LLM_BENCHMARK_SAMPLES ?? '1000', 'samples');
const CONCURRENCY = positiveInteger(
  process.env.DBAGENT_LLM_BENCHMARK_CONCURRENCY ?? '50',
  'concurrency',
);
const reportPath = resolve('reports/llm-platform/performance.json');
const directory = await mkdtemp(join(tmpdir(), 'schemanaut-llm-platform-benchmark-'));

try {
  const settings = new ProjectSettingsStore(directory);
  await settings.replace({
    version: 1,
    mcp: { servers: {} },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory: join(directory, 'catalog'),
    globalParameters: { temperature: 0.1, topP: 0.9 },
    plugins: [benchmarkConnectionPlugin()],
    trustedModelClientFactory: ({ connection, resolution }) => ({
      client: {
        execute: async (input) => {
          const wire = input.wireRequest;
          const content = wire.messages?.at(-1)?.content;
          const text = typeof content === 'string'
            ? content
            : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
          return {
            kind: 'json',
            response: {
              choices: [{ message: { content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            },
          };
        },
      },
      bindingEvidence: {
        connectionResolutionRevision: resolution.revision,
        connectionConfigurationRevision: connection.connectionConfigurationRevision,
        credentialRevision: connection.credentialRevision,
      },
    }),
  });
  const [connection] = manager.replaceConnections([
    { name: 'benchmark', endpoint: 'http://127.0.0.1:39282/v1' },
  ]);
  if (!connection) throw new Error('Benchmark connection was not created.');
  await manager.discover(connection.id, { inspectModelIds: ['benchmark-model'] });
  const selection = { connectionId: connection.id, modelId: 'benchmark-model' };
  const runtime = new DirectLlmRuntime({
    manager,
    usageTracker: new UsageTracker(),
    tenantId: 'benchmark',
    ownerId: 'llm-platform-benchmark',
  });

  const tokenEstimationLatencies = benchmarkTokenEstimation(SAMPLES);
  const structuredValidationLatencies = benchmarkStructuredValidation(SAMPLES);
  const metadataMergeLatencies = benchmarkMetadataMerge(10_000);
  const settingsLoadLatencies = [];
  const sessionBindingLatencies = [];
  const parameterMergeLatencies = [];
  for (let index = 0; index < Math.min(SAMPLES, 500); index += 1) {
    let startedAt = performance.now();
    await settings.load();
    settingsLoadLatencies.push(performance.now() - startedAt);

    startedAt = performance.now();
    await manager.prepareModelSessionBundle(selection);
    sessionBindingLatencies.push(performance.now() - startedAt);

    startedAt = performance.now();
    const effective = manager.effectiveParameters(selection, {
      session: { temperature: 0.2 },
      request: { maxOutputTokens: 512 },
    });
    parameterMergeLatencies.push(performance.now() - startedAt);
    if (effective.values.temperature !== 0.2 || effective.values.maxOutputTokens !== 512) {
      throw new Error('Canonical parameter merge returned an invalid value.');
    }
  }

  const executionLatencies = await runConcurrent(SAMPLES, CONCURRENCY, async (index) => {
    const startedAt = performance.now();
    await runtime.chat(
      { messages: [{ role: 'user', content: `benchmark-${index}` }], maxTokens: 8 },
      { model: selection, maxRetries: 0 },
    );
    return performance.now() - startedAt;
  });

  const submissionLatencies = [];
  const jobIds = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    const job = runtime.submitBatch([{
      request: { messages: [{ role: 'user', content: `job-${index}` }], maxTokens: 8 },
      options: { model: selection, maxRetries: 0 },
    }]);
    submissionLatencies.push(performance.now() - startedAt);
    jobIds.push(job.id);
  }
  await waitForJobs(runtime, jobIds);

  const metrics = {
    tokenEstimationMs: summarize(tokenEstimationLatencies),
    structuredValidationMs: summarize(structuredValidationLatencies),
    metadataMergeMs: summarize(metadataMergeLatencies),
    settingsLoadMs: summarize(settingsLoadLatencies),
    sessionBindingMs: summarize(sessionBindingLatencies),
    parameterMergeMs: summarize(parameterMergeLatencies),
    canonicalExecutionMs: summarize(executionLatencies),
    asyncSubmissionMs: summarize(submissionLatencies),
  };
  const thresholds = {
    tokenEstimationP95Ms: 5,
    structuredValidationP95Ms: 5,
    metadataMergeP95Ms: 1,
    settingsLoadP95Ms: 25,
    sessionBindingP95Ms: 10,
    parameterMergeP95Ms: 2,
    canonicalExecutionP95Ms: 50,
    asyncSubmissionP95Ms: 50,
  };
  const managedSamples = Math.min(SAMPLES, 500);
  const checks = {
    tokenEstimation: metrics.tokenEstimationMs.samples === SAMPLES &&
      metrics.tokenEstimationMs.p95 <= thresholds.tokenEstimationP95Ms,
    structuredValidation: metrics.structuredValidationMs.samples === SAMPLES &&
      metrics.structuredValidationMs.p95 <= thresholds.structuredValidationP95Ms,
    metadataMerge: metrics.metadataMergeMs.samples === 10_000 &&
      metrics.metadataMergeMs.p95 <= thresholds.metadataMergeP95Ms,
    settingsLoad: metrics.settingsLoadMs.samples === managedSamples &&
      metrics.settingsLoadMs.p95 <= thresholds.settingsLoadP95Ms,
    sessionBinding: metrics.sessionBindingMs.samples === managedSamples &&
      metrics.sessionBindingMs.p95 <= thresholds.sessionBindingP95Ms,
    parameterMerge: metrics.parameterMergeMs.samples === managedSamples &&
      metrics.parameterMergeMs.p95 <= thresholds.parameterMergeP95Ms,
    canonicalExecution: metrics.canonicalExecutionMs.samples === SAMPLES &&
      metrics.canonicalExecutionMs.p95 <= thresholds.canonicalExecutionP95Ms,
    asyncSubmission: metrics.asyncSubmissionMs.samples === SAMPLES &&
      metrics.asyncSubmissionMs.p95 <= thresholds.asyncSubmissionP95Ms,
  };
  const report = {
    kind: 'llm-platform-performance',
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    samples: SAMPLES,
    concurrency: CONCURRENCY,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memory: {
        rssMiB: bytesToMiB(process.memoryUsage().rss),
        heapUsedMiB: bytesToMiB(process.memoryUsage().heapUsed),
      },
    },
    measurement:
      'Canonical Direct LLM path with a frozen ModelSessionBundle and deterministic in-process ModelClient; network latency excluded.',
    thresholds,
    checks,
    metrics,
    gatewayMetrics: runtime.metrics(),
  };
  await runtime.close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

function benchmarkConnectionPlugin() {
  return {
    manifest: {
      id: 'benchmark-openai-chat',
      name: 'Benchmark OpenAI Chat',
      version: '1',
      protocol: 'openai-chat',
      priority: 1_000,
    },
    match: () => ({ score: 1_000, evidence: [] }),
    discover: async () => ({ score: 1_000, models: ['benchmark-model'], evidence: [] }),
    createProvider: ({ resolution }) => ({
      id: resolution.providerId,
      name: 'Benchmark connection adapter',
      mode: 'private',
      protocol: 'openai-chat',
      capabilities: { chat: 'supported', streaming: 'supported', toolCalling: 'supported' },
      generationParameters: {
        temperature: 'supported',
        topP: 'supported',
        maxOutputTokens: 'supported',
      },
      listModels: async () => ['benchmark-model'],
      getModelMetadata: async () => ({
        model: 'benchmark-model',
        source: 'provider-api',
        contextTokens: 128_000,
        maxOutputTokens: 8_192,
        capabilities: { chat: 'supported', streaming: 'supported', toolCalling: 'supported' },
      }),
      chat: async () => {
        throw new Error('Provider chat execution must not be used by the canonical benchmark.');
      },
      isAvailable: async () => ({ available: true }),
    }),
  };
}

function benchmarkTokenEstimation(samples) {
  const value = '数据库治理 database observability SELECT * FROM orders WHERE status = paid; '.repeat(128);
  return benchmarkSynchronous(samples, () => {
    if (estimateTextTokens(value) <= 0) throw new Error('Token estimator returned an invalid result.');
  });
}

function benchmarkStructuredValidation(samples) {
  const validator = new StructuredOutputValidator();
  const schema = {
    type: 'object',
    properties: {
      sql: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['sql', 'confidence'],
    additionalProperties: false,
  };
  const value = JSON.stringify({ sql: 'SELECT 1', confidence: 0.98 });
  return benchmarkSynchronous(samples, () => validator.parseAndValidate(value, schema));
}

function benchmarkMetadataMerge(samples) {
  return benchmarkSynchronous(samples, () => {
    const model = mergeLlmCatalogModel({
      connectionId: 'benchmark-connection',
      modelId: 'benchmark-model',
      candidates: [{
        source: 'endpoint',
        contextTokens: 128_000,
        maxOutputTokens: 8_192,
        capabilities: { chat: 'supported', toolCalling: 'supported' },
        roles: { generation: true },
      }],
    });
    if (model.contextTokens.value !== 128_000) throw new Error('Invalid metadata merge.');
  });
}

function benchmarkSynchronous(samples, operation) {
  const latencies = [];
  for (let index = 0; index < samples + 100; index += 1) {
    const startedAt = performance.now();
    operation();
    if (index >= 100) latencies.push(performance.now() - startedAt);
  }
  return latencies;
}

async function runConcurrent(count, concurrency, operation) {
  const results = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await operation(index);
    }
  }));
  return results;
}

async function waitForJobs(runtime, ids) {
  const pending = new Set(ids);
  while (pending.size > 0) {
    for (const id of pending) {
      const job = runtime.getJob(id);
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (job.status !== 'completed') throw new Error(`Benchmark job ${id} ended as ${job.status}.`);
        pending.delete(id);
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}
