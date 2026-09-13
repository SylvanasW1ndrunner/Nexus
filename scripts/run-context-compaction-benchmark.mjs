#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PromptRuntime } from '../packages/core-agent/dist/index.js';
import {
  decideContextLifecycle,
  readBoundedCommittedContext,
} from '../packages/core-agent/dist/context/context-lifecycle.js';

const EVENT_COUNT = 10_000;
const DECISION_SAMPLES = 5_000;
const PROMPT_SAMPLES = 500;
const TRAVERSAL_SAMPLES = 40;
const reportPath = resolve('reports/agent-runtime/context-compaction-performance.json');
const facts = createFacts();
const promptRuntime = createPromptRuntime();

for (let index = 0; index < 100; index += 1) {
  assertDecision(decide());
  assertPrompt(promptRuntime.compile(promptInput()));
}
for (let index = 0; index < 5; index += 1) {
  assertTraversal(await traverseFacts());
}

const decisionDurations = measure(DECISION_SAMPLES, () => assertDecision(decide()));
const promptDurations = measure(PROMPT_SAMPLES, () =>
  assertPrompt(promptRuntime.compile(promptInput())),
);
const traversalDurations = await measureAsync(TRAVERSAL_SAMPLES, async () =>
  assertTraversal(await traverseFacts()),
);

const metrics = {
  contextDecisionMs: summarize(decisionDurations),
  checkpointPromptCompileMs: summarize(promptDurations),
  boundedTenThousandEventReadMs: summarize(traversalDurations),
};
const thresholds = {
  contextDecisionP95Ms: 1,
  checkpointPromptCompileP95Ms: 10,
  boundedTenThousandEventReadP95Ms: 50,
};
const checks = {
  contextDecision: check(metrics.contextDecisionMs.p95, thresholds.contextDecisionP95Ms),
  checkpointPromptCompile: check(
    metrics.checkpointPromptCompileMs.p95,
    thresholds.checkpointPromptCompileP95Ms,
  ),
  boundedTenThousandEventRead: check(
    metrics.boundedTenThousandEventReadMs.p95,
    thresholds.boundedTenThousandEventReadP95Ms,
  ),
};
const report = {
  schemaVersion: 2,
  kind: 'context-compaction-performance',
  status: Object.values(checks).every((item) => item.passed) ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
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
  dataset: {
    committedEvents: EVENT_COUNT,
    pageSize: 250,
    maxEvents: EVENT_COUNT,
    samples: {
      contextDecision: DECISION_SAMPLES,
      checkpointPromptCompile: PROMPT_SAMPLES,
      boundedTenThousandEventRead: TRAVERSAL_SAMPLES,
    },
  },
  measurement:
    'Local deterministic benchmark of the current bounded Journal read, model-window decision and checkpoint prompt compiler. Model and network latency are excluded.',
  thresholds,
  metrics,
  checks,
  rawSamplesMs: {
    contextDecision: decisionDurations.slice(0, 80),
    checkpointPromptCompile: promptDurations.slice(0, 80),
    boundedTenThousandEventRead: traversalDurations,
  },
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ status: report.status, metrics: report.metrics }, null, 2)}\nReport: ${reportPath}\n`,
);
if (report.status !== 'passed') process.exitCode = 1;

function createFacts() {
  return Array.from({ length: EVENT_COUNT }, (_, index) => ({
    sequence: index + 1,
    committed: index % 17 !== 0,
    semantic:
      index === EVENT_COUNT - 1
        ? 'Keep public.orders.amount, "供应链"."采购订单" and 1726.50.'
        : `Committed semantic event ${index + 1}`,
  }));
}

function createPromptRuntime() {
  return new PromptRuntime({
    runtimeProtocol: {
      id: 'runtime-protocol',
      source: 'runtime',
      scope: 'static',
      priority: 0,
      revision: 'v1',
      cacheability: 'stable',
      content: [{ type: 'text', text: 'Use the available capabilities to complete the task.' }],
      tokenEstimate: 12,
    },
  });
}

function promptInput() {
  return {
    model: 'benchmark-model',
    sections: [
      {
        id: 'session-context',
        source: 'session',
        scope: 'session',
        priority: 0,
        revision: 'session-v1',
        cacheability: 'volatile',
        content: [{ type: 'text', text: 'Continue from the durable Session checkpoint.' }],
        tokenEstimate: 12,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `recent-${index}`,
        source: 'observation',
        scope: 'turn',
        priority: index,
        revision: `event-${EVENT_COUNT - 11 + index}`,
        cacheability: 'never',
        content: [{ type: 'text', text: `Recent committed observation ${index + 1}.` }],
        tokenEstimate: 10,
      })),
    ],
    tools: [],
    checkpoint: {
      summary:
        'Continue public.orders analysis. Preserve public.orders.amount, "供应链"."采购订单" and 1726.50.',
      coveredSequence: EVENT_COUNT - 12,
    },
  };
}

function decide() {
  return decideContextLifecycle({
    maxInputTokens: 128_000,
    estimatedInputTokens: 127_500,
    outputReserveTokens: 8_000,
    protocolReserveTokens: 1_000,
    toolReserveTokens: 4_000,
    compactedForDecision: false,
    manualRequested: false,
    safeBoundary: true,
  });
}

async function traverseFacts() {
  return readBoundedCommittedContext({
    readPage: ({ afterSequence, throughSequence, limit }) =>
      Promise.resolve(
        facts.slice(afterSequence, Math.min(throughSequence, afterSequence + limit)),
      ),
    afterSequence: 0,
    throughSequence: EVENT_COUNT,
    pageSize: 250,
    maxEvents: EVENT_COUNT,
  });
}

function assertDecision(decision) {
  assert.equal(decision.action, 'compact');
  assert.equal(decision.reason, 'automatic');
}

function assertPrompt(compiled) {
  assert.equal(compiled.messages.length, 15);
  const visible = JSON.stringify(compiled.messages);
  assert.match(visible, /public\.orders\.amount/);
  assert.doesNotMatch(visible, /coveredSequence/);
}

function assertTraversal(result) {
  assert.equal(result.nextSequence, EVENT_COUNT);
  assert.equal(result.truncated, false);
  assert.equal(result.events.length, EVENT_COUNT - Math.ceil(EVENT_COUNT / 17));
  assert.match(result.events.at(-1)?.semantic ?? '', /1726\.50/);
}

function measure(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(round(performance.now() - startedAt));
  }
  return durations;
}

async function measureAsync(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(round(performance.now() - startedAt));
  }
  return durations;
}

function summarize(values) {
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function check(actual, maximum) {
  return { actual, maximum, passed: actual <= maximum };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}
