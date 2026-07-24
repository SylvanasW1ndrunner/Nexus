#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AgentSessionStore,
  appendMessage,
  buildAgentContext,
  createAgentContextCompactionPlan,
  createAgentSession,
  createMessage,
} from '../packages/core-agent/dist/index.js';

const MESSAGE_COUNT = 10_000;
const VIEW_SAMPLES = 100;
const PLAN_SAMPLES = 12;
const STORAGE_SAMPLES = 30;
const observedAt = '2026-07-24T00:00:00.000Z';
const now = () => observedAt;
const reportPath = resolve(
  'reports/ai-sql/context-compaction-performance.json',
);
const tools = [
  {
    name: 'query_database',
    description: 'Execute readonly SQL',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
];

const fullSession = createBenchmarkSession();
assert.equal(fullSession.messages.length, MESSAGE_COUNT);
const compactedSession = structuredClone(fullSession);
compactedSession.contextCheckpoint = {
  version: 1,
  sequence: 1,
  trigger: 'auto',
  method: 'model',
  summary: [
    '## Goal',
    '继续分析 public.orders，并保留中文供应链表的准确事实。',
    '## Database facts and SQL',
    'public.orders.amount 为金额列；精确结果为 1726.50。',
    '## Current state',
    '旧对话已经压缩，继续读取最近消息。',
  ].join('\n'),
  coveredConversationMessageCount: 9_987,
  sourceTokenEstimate: 180_000,
  summaryTokenEstimate: 120,
  modelContextTokens: 128_000,
  createdAt: observedAt,
};

for (let index = 0; index < 10; index += 1) {
  assertCompactedView(buildAgentContext(compactedSession, tools, contextOptions()));
  assertCompactionPlan(
    createAgentContextCompactionPlan(
      fullSession,
      contextOptions(),
      'auto',
    ),
  );
}

const viewDurations = measure(VIEW_SAMPLES, () => {
  assertCompactedView(
    buildAgentContext(compactedSession, tools, contextOptions()),
  );
});
const planDurations = measure(PLAN_SAMPLES, () => {
  assertCompactionPlan(
    createAgentContextCompactionPlan(
      fullSession,
      contextOptions(),
      'auto',
    ),
  );
});

const storageDirectory = await mkdtemp(
  join(tmpdir(), 'dbagent-context-benchmark-'),
);
let initialSaveMs = 0;
let appendDurations = [];
let loadDurations = [];
try {
  const store = new AgentSessionStore(join(storageDirectory, 'agent.db'));
  const saveStartedAt = performance.now();
  await store.save({ session: compactedSession, now: observedAt });
  initialSaveMs = performance.now() - saveStartedAt;

  const restored = await store.load(compactedSession.id);
  assert.equal(restored?.messages.length, MESSAGE_COUNT);
  assert.equal(
    restored?.messages[0]?.content,
    compactedSession.messages[0]?.content,
  );
  assert.equal(
    restored?.messages.at(-1)?.content,
    compactedSession.messages.at(-1)?.content,
  );
  assert.equal(restored?.contextCheckpoint?.sequence, 1);

  let mutableSession = restored;
  assert.ok(mutableSession);
  for (let index = 0; index < STORAGE_SAMPLES; index += 1) {
    appendMessage(
      mutableSession,
      createMessage(
        {
          role: 'user',
          content: `incremental append ${index}: keep exact value ${1726.5 + index}`,
        },
        now,
      ),
    );
    const appendStartedAt = performance.now();
    await store.save({ session: mutableSession, now: observedAt });
    appendDurations.push(performance.now() - appendStartedAt);

    const loadStartedAt = performance.now();
    const next = await store.load(mutableSession.id);
    loadDurations.push(performance.now() - loadStartedAt);
    assert.equal(next?.messages.length, mutableSession.messages.length);
    mutableSession = next;
    assert.ok(mutableSession);
  }
} finally {
  await rm(storageDirectory, { recursive: true, force: true });
}

const metrics = {
  compactedWorkingViewMs: summarize(viewDurations),
  automaticCompactionPlanMs: summarize(planDurations),
  sqliteInitialSaveMs: round(initialSaveMs),
  sqliteIncrementalAppendMs: summarize(appendDurations),
  sqliteRestoreMs: summarize(loadDurations),
};
const thresholds = {
  compactedWorkingViewP95Ms: 50,
  automaticCompactionPlanP95Ms: 100,
  sqliteInitialSaveMs: 500,
  sqliteIncrementalAppendP95Ms: 500,
  sqliteRestoreP95Ms: 500,
};
const checks = {
  compactedWorkingView: check(
    metrics.compactedWorkingViewMs.p95,
    thresholds.compactedWorkingViewP95Ms,
  ),
  automaticCompactionPlan: check(
    metrics.automaticCompactionPlanMs.p95,
    thresholds.automaticCompactionPlanP95Ms,
  ),
  sqliteInitialSave: check(
    metrics.sqliteInitialSaveMs,
    thresholds.sqliteInitialSaveMs,
  ),
  sqliteIncrementalAppend: check(
    metrics.sqliteIncrementalAppendMs.p95,
    thresholds.sqliteIncrementalAppendP95Ms,
  ),
  sqliteRestore: check(
    metrics.sqliteRestoreMs.p95,
    thresholds.sqliteRestoreP95Ms,
  ),
};
const report = {
  kind: 'context-compaction-performance',
  status: Object.values(checks).every((item) => item.passed)
    ? 'passed'
    : 'failed',
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
    originalMessages: MESSAGE_COUNT,
    checkpointCoveredMessages:
      compactedSession.contextCheckpoint.coveredConversationMessageCount,
    retainedMessages:
      MESSAGE_COUNT -
      compactedSession.contextCheckpoint.coveredConversationMessageCount,
    samples: {
      compactedWorkingView: VIEW_SAMPLES,
      automaticCompactionPlan: PLAN_SAMPLES,
      sqliteIncrementalAppend: STORAGE_SAMPLES,
      sqliteRestore: STORAGE_SAMPLES,
    },
  },
  measurement:
    'Local deterministic benchmark. It measures context construction, compaction planning and append-only SQLite persistence; model and network latency are excluded.',
  thresholds,
  metrics,
  checks,
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`,
);
if (report.status !== 'passed') process.exitCode = 1;

function createBenchmarkSession() {
  const session = createAgentSession({
    id: 'context-performance-session',
    title: '10k message context benchmark',
    mode: 'read',
    userId: 'benchmark-user',
    now,
  });
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const phase = index % 3;
    if (phase === 0) {
      appendMessage(
        session,
        createMessage(
          {
            role: 'user',
            content: `第 ${index} 轮：分析 public.orders.amount 与“供应链”.“采购订单”，保留精确金额 ${(
              1726.5 +
              index / 100
            ).toFixed(2)}。`,
          },
          now,
        ),
      );
      continue;
    }
    if (phase === 1) {
      appendMessage(
        session,
        createMessage(
          {
            role: 'assistant',
            content: `执行第 ${index} 轮只读分析。`,
            toolCalls: [
              {
                id: `benchmark-call-${index}`,
                name: 'query_database',
                arguments: {
                  sql: `select sum(amount) from public.orders where id <= ${index}`,
                },
              },
            ],
          },
          now,
        ),
      );
      continue;
    }
    appendMessage(
      session,
      createMessage(
        {
          role: 'tool',
          toolCallId: `benchmark-call-${index - 1}`,
          toolName: 'query_database',
          content: JSON.stringify({
            rows: [{ amount: (1726.5 + index / 100).toFixed(2) }],
            rowCount: 1,
            elapsedMs: index % 17,
          }),
        },
        now,
      ),
    );
  }
  return session;
}

function contextOptions() {
  return {
    modelContextTokens: 128_000,
    maxOutputTokens: 8_000,
    keepRecentMessages: 12,
    maxToolResultChars: 1_200,
    activeTask: '继续完成当前数据库分析任务。',
  };
}

function assertCompactedView(context) {
  assert.ok(
    context.messages.length < 30,
    `Compacted view retained too many messages: ${context.messages.length}`,
  );
  const visible = JSON.stringify(context.messages);
  assert.match(visible, /1726\.50/);
  assert.doesNotMatch(visible, /coveredConversationMessageCount/);
  assert.doesNotMatch(visible, /benchmark-call-1/);
}

function assertCompactionPlan(plan) {
  assert.ok(plan, 'Compaction plan was not created');
  assert.ok(plan.sourceMessages.length > 9_000);
  assert.ok(plan.sourceBatches.length > 1);
  const finalCoveredMessage = plan.sourceMessages.at(-1);
  assert.ok(
    !(
      finalCoveredMessage?.role === 'assistant' &&
      finalCoveredMessage.toolCalls?.length
    ),
    'Compaction boundary split a tool interaction',
  );
}

function measure(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation(index);
    durations.push(performance.now() - startedAt);
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
  return {
    actual,
    maximum,
    passed: actual <= maximum,
  };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}
