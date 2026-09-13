import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSuccessfulLiveAgentRun,
  createNotRunLiveReport,
  summarizeLiveAgentRun,
} from '../lib/live-agent-report.mjs';

const successfulRun = {
  runId: 'run-1',
  sessionId: 'session-1',
  status: 'completed',
  finalText: '任务已经完成。',
  deliveryStatus: 'verified',
  evidenceRefs: ['result:query-1'],
  activityCount: 5,
  toolActivityCount: 2,
  durationMs: 123,
  tokenUsage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
};

test('accepts only a complete user-deliverable live Agent report', () => {
  assert.doesNotThrow(() => assertSuccessfulLiveAgentRun(successfulRun));
  assert.deepEqual(summarizeLiveAgentRun(successfulRun), successfulRun);
});

test('rejects a report that lacks a final delivery or tool activity', () => {
  assert.throws(
    () => assertSuccessfulLiveAgentRun({ ...successfulRun, finalText: '' }),
    /finalText/i,
  );
  assert.throws(
    () => assertSuccessfulLiveAgentRun({ ...successfulRun, toolActivityCount: 0 }),
    /toolActivityCount/i,
  );
});

test('marks missing explicit live-test credentials as not-run rather than passed', () => {
  const report = createNotRunLiveReport({
    kind: 'multi-model-user-acceptance',
    reason: 'TEST_LLM_API_KEY is required.',
  });
  assert.equal(report.status, 'not-run');
  assert.equal(report.passed, false);
  assert.equal(report.reason, 'TEST_LLM_API_KEY is required.');
  assert.ok(typeof report.generatedAt === 'string');
});
