import assert from 'node:assert/strict';

const TERMINAL_STATUS = 'completed';
const VERIFIED_DELIVERY = 'verified';

/**
 * Extract the public, durable Agent-run fields that a live acceptance report
 * is allowed to depend on. Internal scheduler counters and tool transcripts
 * deliberately do not belong to this contract.
 */
export function summarizeLiveAgentRun(value) {
  assertSuccessfulLiveAgentRun(value);
  const run = /** @type {Record<string, unknown>} */ (value);
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    finalText: run.finalText,
    deliveryStatus: run.deliveryStatus,
    evidenceRefs: [...run.evidenceRefs],
    activityCount: run.activityCount,
    toolActivityCount: run.toolActivityCount,
    ...(isFiniteNonNegativeNumber(run.durationMs) ? { durationMs: run.durationMs } : {}),
    ...(isTokenUsage(run.tokenUsage) ? { tokenUsage: { ...run.tokenUsage } } : {}),
  };
}

export function assertSuccessfulLiveAgentRun(value) {
  assert.ok(isRecord(value), 'run must be an object.');
  assert.equal(value.status, TERMINAL_STATUS, 'run.status must be completed.');
  assert.ok(nonBlankString(value.runId), 'run.runId must be present.');
  assert.ok(nonBlankString(value.sessionId), 'run.sessionId must be present.');
  assert.ok(nonBlankString(value.finalText), 'run.finalText must be a non-empty final delivery.');
  assert.equal(
    value.deliveryStatus,
    VERIFIED_DELIVERY,
    'run.deliveryStatus must be verified for live user acceptance.',
  );
  assert.ok(Array.isArray(value.evidenceRefs), 'run.evidenceRefs must be an array.');
  assert.ok(value.evidenceRefs.length > 0, 'run.evidenceRefs must contain durable evidence.');
  assert.ok(
    value.evidenceRefs.every(nonBlankString),
    'run.evidenceRefs must contain only non-empty references.',
  );
  assert.ok(
    isFiniteNonNegativeNumber(value.activityCount) && value.activityCount > 0,
    'run.activityCount must be a positive number.',
  );
  assert.ok(
    isFiniteNonNegativeNumber(value.toolActivityCount) && value.toolActivityCount > 0,
    'run.toolActivityCount must be a positive number.',
  );
  if (value.durationMs !== undefined) {
    assert.ok(isFiniteNonNegativeNumber(value.durationMs), 'run.durationMs must be non-negative.');
  }
  if (value.tokenUsage !== undefined) {
    assert.ok(isTokenUsage(value.tokenUsage), 'run.tokenUsage must contain non-negative token counts.');
  }
}

export function createNotRunLiveReport({ kind, reason, ...extra }) {
  assert.ok(nonBlankString(kind), 'kind is required.');
  assert.ok(nonBlankString(reason), 'reason is required.');
  return {
    kind,
    generatedAt: new Date().toISOString(),
    status: 'not-run',
    passed: false,
    reason,
    ...extra,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isTokenUsage(value) {
  if (!isRecord(value)) return false;
  return ['promptTokens', 'completionTokens', 'totalTokens'].every((key) =>
    isFiniteNonNegativeNumber(value[key]),
  );
}
