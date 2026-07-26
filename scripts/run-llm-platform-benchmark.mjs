#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  LlmGateway,
  LlmModelRegistry,
  LlmProviderError,
  LlmTaskRouter,
  StructuredOutputValidator,
  estimateTokens,
} from '../packages/core-llm/dist/index.js';

const SAMPLES = positiveInteger(process.env.DBAGENT_LLM_BENCHMARK_SAMPLES ?? '1000', 'samples');
const CONCURRENCY = positiveInteger(
  process.env.DBAGENT_LLM_BENCHMARK_CONCURRENCY ?? '50',
  'concurrency',
);
const reportPath = resolve('reports/llm-platform/performance.json');

const provider = benchmarkProvider();
const gateway = new LlmGateway();
gateway.registerProvider(provider, [
  {
    model: 'benchmark-model',
    capabilities: {
      streaming: 'supported',
      toolCalling: 'supported',
      structuredOutput: 'supported',
    },
    limits: { maxConcurrency: CONCURRENCY * 2 },
    pricing: { currency: 'CNY', inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  },
]);
gateway.configureReliability(provider.id, {
  maxConcurrency: CONCURRENCY * 2,
  maxQueueSize: SAMPLES,
  maxQueueWaitMs: 30_000,
});

const routeLatencies = benchmarkRoute(SAMPLES);
const tokenEstimationLatencies = benchmarkTokenEstimation(SAMPLES);
const structuredValidationLatencies = benchmarkStructuredValidation(SAMPLES);
const gatewayLatencies = await runConcurrent(SAMPLES, CONCURRENCY, async (index) => {
  const startedAt = performance.now();
  await gateway.execute({
    providerId: provider.id,
    request: {
      model: 'benchmark-model',
      messages: [{ role: 'user', content: `benchmark-${index}` }],
      maxTokens: 8,
    },
    context: { tenantId: 'benchmark', taskType: 'performance' },
    maxRetries: 0,
    maxFallbacks: 0,
    maxStructuredCorrections: 0,
  });
  return performance.now() - startedAt;
});

const streamForwardLatencies = [];
provider.resetStreamProbe();
for await (const event of gateway.stream({
  providerId: provider.id,
  request: {
    model: 'benchmark-model',
    messages: [{ role: 'user', content: 'stream benchmark' }],
    maxTokens: SAMPLES,
  },
  context: { tenantId: 'benchmark', taskType: 'performance-stream' },
  maxRetries: 0,
  maxFallbacks: 0,
})) {
  if (event.type === 'text-delta')
    streamForwardLatencies.push(performance.now() - provider.lastYieldAt());
}

const submissionLatencies = [];
const jobIds = [];
for (let index = 0; index < SAMPLES; index += 1) {
  const startedAt = performance.now();
  const job = gateway.submitBatch([
    {
      providerId: provider.id,
      request: {
        model: 'benchmark-model',
        messages: [{ role: 'user', content: `job-${index}` }],
        maxTokens: 8,
      },
      context: { tenantId: 'benchmark', taskType: 'performance-job' },
      maxRetries: 0,
      maxFallbacks: 0,
    },
  ]);
  submissionLatencies.push(performance.now() - startedAt);
  jobIds.push(job.id);
}
await waitForJobs(gateway, jobIds);

const cancellationLatencies = await benchmarkCancellation(Math.min(SAMPLES, 1_000), CONCURRENCY);

const metrics = {
  routeDecisionMs: summarize(routeLatencies),
  tokenEstimationMs: summarize(tokenEstimationLatencies),
  structuredValidationMs: summarize(structuredValidationLatencies),
  gatewayTotalMs: summarize(gatewayLatencies),
  streamForwardMs: summarize(streamForwardLatencies),
  asyncSubmissionMs: summarize(submissionLatencies),
  cancellationPropagationMs: summarize(cancellationLatencies),
};
const thresholds = {
  routeDecisionP95Ms: 20,
  tokenEstimationP95Ms: 5,
  structuredValidationP95Ms: 5,
  gatewayP95Ms: 50,
  streamForwardP95Ms: 50,
  asyncSubmissionP95Ms: 50,
  cancellationPropagationP95Ms: 100,
};
const checks = {
  routeDecision:
    metrics.routeDecisionMs.samples === SAMPLES &&
    metrics.routeDecisionMs.p95 <= thresholds.routeDecisionP95Ms,
  tokenEstimation:
    metrics.tokenEstimationMs.samples === SAMPLES &&
    metrics.tokenEstimationMs.p95 <= thresholds.tokenEstimationP95Ms,
  structuredValidation:
    metrics.structuredValidationMs.samples === SAMPLES &&
    metrics.structuredValidationMs.p95 <= thresholds.structuredValidationP95Ms,
  gateway:
    metrics.gatewayTotalMs.samples === SAMPLES &&
    metrics.gatewayTotalMs.p95 <= thresholds.gatewayP95Ms,
  streamForward:
    metrics.streamForwardMs.samples === SAMPLES &&
    metrics.streamForwardMs.p95 <= thresholds.streamForwardP95Ms,
  asyncSubmission:
    metrics.asyncSubmissionMs.samples === SAMPLES &&
    metrics.asyncSubmissionMs.p95 <= thresholds.asyncSubmissionP95Ms,
  cancellationPropagation:
    metrics.cancellationPropagationMs.samples === Math.min(SAMPLES, 1_000) &&
    metrics.cancellationPropagationMs.p95 <= thresholds.cancellationPropagationP95Ms,
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
    'Platform path with an in-process deterministic provider; external model and network latency excluded.',
  thresholds,
  checks,
  metrics,
  gatewayMetrics: gateway.metricsSnapshot(),
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
if (report.status !== 'passed') process.exitCode = 1;

function benchmarkProvider() {
  let yieldedAt = 0;
  return {
    id: 'benchmark-provider',
    name: 'Deterministic benchmark provider',
    mode: 'private',
    protocol: 'benchmark',
    capabilities: { chat: 'supported', streaming: 'supported' },
    async chat(request) {
      const text = request.messages.at(-1)?.content ?? 'ok';
      return {
        text,
        toolCalls: [],
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      };
    },
    async *stream(request) {
      const count = request.maxTokens ?? SAMPLES;
      let text = '';
      for (let index = 0; index < count; index += 1) {
        yieldedAt = performance.now();
        text += 'x';
        yield { type: 'text-delta', text: 'x' };
      }
      const response = {
        text,
        toolCalls: [],
        usage: { promptTokens: 4, completionTokens: count, totalTokens: count + 4 },
      };
      yield { type: 'usage', usage: response.usage };
      yield { type: 'finish', response };
    },
    async isAvailable() {
      return { available: true };
    },
    lastYieldAt() {
      return yieldedAt;
    },
    resetStreamProbe() {
      yieldedAt = 0;
    },
  };
}

function benchmarkRoute(samples) {
  const registry = new LlmModelRegistry();
  const provider = benchmarkProvider();
  registry.registerProvider(provider);
  for (let index = 0; index < 20; index += 1) {
    registry.registerModel({
      providerId: provider.id,
      model: `route-${index}`,
      quality: index % 3 === 0 ? 'advanced' : 'balanced',
      capabilities: { toolCalling: 'supported', structuredOutput: 'supported' },
      pricing: {
        currency: 'CNY',
        inputPerMillionTokens: 1 + index / 10,
        outputPerMillionTokens: 2 + index / 10,
      },
    });
  }
  const router = new LlmTaskRouter(registry);
  const latencies = [];
  for (let index = 0; index < samples + 100; index += 1) {
    const startedAt = performance.now();
    router.route({
      task: {
        taskType: 'benchmark',
        requirements: { capabilities: ['chat', 'structuredOutput'] },
        preferences: { optimizeFor: index % 2 === 0 ? 'cost' : 'quality' },
      },
      estimatedInputTokens: 2_000,
      requestedOutputTokens: 500,
    });
    if (index >= 100) latencies.push(performance.now() - startedAt);
  }
  return latencies;
}

function benchmarkTokenEstimation(samples) {
  const text =
    '数据库治理 database observability SELECT * FROM orders WHERE status = paid; '.repeat(128);
  return benchmarkSynchronous(samples, () => {
    const result = estimateTokens(text);
    if (result <= 0) throw new Error('Token estimator returned an invalid result.');
  });
}

function benchmarkStructuredValidation(samples) {
  const validator = new StructuredOutputValidator();
  const schema = {
    type: 'object',
    properties: {
      sql: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      tables: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    },
    required: ['sql', 'confidence', 'tables'],
    additionalProperties: false,
  };
  const value = JSON.stringify({
    sql: 'SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id',
    confidence: 0.98,
    tables: Array.from({ length: 50 }, (_, index) => `schema.table_${index}`),
  });
  return benchmarkSynchronous(samples, () => validator.parseAndValidate(value, schema));
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

async function benchmarkCancellation(samples, concurrency) {
  const latencies = [];
  const abortStarted = new Map();
  const startedResolvers = new Map();
  const provider = {
    id: 'cancellation-provider',
    name: 'Cancellation provider',
    mode: 'private',
    async chat(request) {
      return await new Promise((resolve, reject) => {
        const abort = () => {
          const id = request.metadata?.benchmarkId ?? '';
          const startedAt = abortStarted.get(id);
          if (startedAt !== undefined) latencies.push(performance.now() - startedAt);
          reject(new LlmProviderError('LLM_ABORTED', 'cancelled', false));
        };
        const id = request.metadata?.benchmarkId ?? '';
        startedResolvers.get(id)?.();
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
      });
    },
    async isAvailable() {
      return { available: true };
    },
  };
  const gateway = new LlmGateway();
  gateway.registerProvider(provider, [{ model: 'cancel-model' }]);
  gateway.configureReliability(provider.id, {
    maxConcurrency: concurrency * 2,
    maxQueueSize: samples,
    maxQueueWaitMs: 30_000,
  });
  await runConcurrent(samples, concurrency, async (index) => {
    const id = String(index);
    const controller = new AbortController();
    let markStarted;
    const providerStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    startedResolvers.set(id, markStarted);
    const promise = gateway.execute({
      providerId: provider.id,
      request: {
        model: 'cancel-model',
        messages: [{ role: 'user', content: 'cancel' }],
        metadata: { benchmarkId: id },
        signal: controller.signal,
      },
      context: { tenantId: 'benchmark', taskType: 'cancellation' },
      maxRetries: 0,
      maxFallbacks: 0,
    });
    await providerStarted;
    abortStarted.set(id, performance.now());
    controller.abort();
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof LlmProviderError) || error.code !== 'LLM_ABORTED') throw error;
    }
    startedResolvers.delete(id);
    abortStarted.delete(id);
    return 0;
  });
  return latencies;
}

async function runConcurrent(count, concurrency, operation) {
  const results = new Array(count);
  let cursor = 0;
  const worker = async () => {
    while (cursor < count) {
      const index = cursor++;
      results[index] = await operation(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  return results;
}

async function waitForJobs(gateway, ids) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (
      ids.every((id) =>
        ['completed', 'failed', 'cancelled'].includes(gateway.getJob(id, 'benchmark')?.status),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Benchmark async jobs did not finish.');
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    mean: sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function percentile(sorted, quantile) {
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0
  );
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}
