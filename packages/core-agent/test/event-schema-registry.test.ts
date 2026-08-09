import { describe, expect, it } from 'vitest';
import { validateAndRedactEventPayload } from '../src/index.js';

const persistedAttempt = {
  attemptId: 'attempt-a',
  origin: { connectionId: 'connection-a', model: 'model-a', protocol: 'openai-responses' },
  blocks: [{
    type: 'tool-call-draft', draftCallKey: 'attempt-a:0', name: 'query_database',
    arguments: { sql: 'select 1' },
    wireIdentity: { callId: 'wire-a', providerItemId: 'item-a' },
  }],
  terminal: true,
  validation: 'validated',
  finishReason: 'tool-calls',
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: 0 },
  providerResponseId: 'response-a',
  opaqueBlockRefs: [],
} as const;

const committedPayload = {
  validatedAttempt: persistedAttempt,
  turn: { protocolEnvelopeRef: 'protocol-envelope:turn-a' },
  protocolEnvelope: { schemaVersion: 1, correlations: [] },
};

describe('agent event runtime schemas', () => {
  it('recursively rejects unknown and invalid discriminated-union model fields', () => {
    expect(() => validateAndRedactEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        origin: { ...persistedAttempt.origin, injected: true },
      },
    })).toThrow(/unknown|origin/iu);
    expect(() => validateAndRedactEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        blocks: [{ ...persistedAttempt.blocks[0], type: 'invented' }],
      },
    })).toThrow(/type|block/iu);
    expect(() => validateAndRedactEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        usage: { ...persistedAttempt.usage, inputTokens: -1 },
      },
    })).toThrow(/inputTokens|non-negative/iu);
  });

  it('requires exact enums, non-negative integers, bounded summaries, and string refs', () => {
    expect(() => validateAndRedactEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: { ...persistedAttempt, finishReason: 'invented' },
    })).toThrow(/finishReason/iu);
    expect(() => validateAndRedactEventPayload('usage.recorded', {
      scope: 'run', inputTokens: 1.5, outputTokens: 2, totalTokens: 3,
    })).toThrow(/inputTokens|integer/iu);
    expect(() => validateAndRedactEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'x'.repeat(4_097), refs: [],
    })).toThrow(/summary/iu);
    expect(() => validateAndRedactEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'done', refs: ['ok', 1],
    })).toThrow(/refs/iu);
    expect(() => validateAndRedactEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'done', refs: Array.from({ length: 257 }, (_, i) => `ref-${i}`),
    })).toThrow(/refs/iu);
  });

  it('rejects normalized secret-key suffixes and credential-bearing URLs at every depth', () => {
    for (const secretPayload of [
      { dbPassword: 'plain-value' },
      { database_password: 'plain-value' },
      { nested: { requestAuthorization: 'plain-value' } },
      { serviceCredential: 'plain-value' },
      { url: 'postgres://tester:secret@localhost/db' },
    ]) {
      expect(() => validateAndRedactEventPayload('run.failed', {
        code: 'FAILED', detail: secretPayload,
      })).toThrow(/secret|credential/iu);
    }
  });

  it('keeps terminal Tool outcomes summary-and-reference only', () => {
    expect(validateAndRedactEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: ['artifact:result-a'],
    })).toEqual({ summary: 'query completed', resultRefs: ['artifact:result-a'] });
    expect(() => validateAndRedactEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: [], rawResult: { rows: [{ value: 'data' }] },
    })).toThrow(/unknown/iu);
  });
});
