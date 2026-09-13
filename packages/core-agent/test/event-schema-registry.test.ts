import { describe, expect, it } from 'vitest';
import { upcastAgentEvent, validateAndSnapshotEventPayload } from '../src/index.js';

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
  it('upcasts the retired ingress roleInstructions field into the current layered role prompt', () => {
    const event = upcastAgentEvent({
      eventId: 'legacy-run-role', projectId: 'project-a', sequence: 1,
      schemaVersion: 1, sessionId: 'session-a', runId: 'run-a', type: 'run.created',
      occurredAt: '2026-09-04T00:00:00.000Z',
      payload: {
        clientRequestId: 'request-a',
        configuration: {
          schemaVersion: 1, clientRequestDigest: 'digest-a', mode: 'full-access',
          roleInstructions: 'Legacy role text', capabilityInstructions: [],
          sessionSkillRevision: 0,
        },
      },
    });
    expect(event).toMatchObject({
      schemaVersion: 2,
      payload: { configuration: { rolePrompt: { run: { mode: 'replace', content: 'Legacy role text' } } } },
    });
    if (event.type !== 'run.created') throw new Error('Expected a run.created event.');
    expect(event.payload.configuration).not.toHaveProperty('roleInstructions');
  });

  it('accepts bounded provider-neutral protocol identities and rejects unsafe values', () => {
    expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        origin: { ...persistedAttempt.origin, protocol: 'future-vendor.responses/v7' },
      },
    })).not.toThrow();
    for (const protocol of [
      'x'.repeat(129),
      'future protocol',
      'future\nprotocol',
      'https://user:secret@example.test/protocol',
    ]) {
      expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
        ...committedPayload,
        validatedAttempt: {
          ...persistedAttempt,
          origin: { ...persistedAttempt.origin, protocol },
        },
      })).toThrow(/protocol/iu);
    }
  });

  it('recursively rejects unknown and invalid discriminated-union model fields', () => {
    expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        origin: { ...persistedAttempt.origin, injected: true },
      },
    })).toThrow(/unknown|origin/iu);
    expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        blocks: [{ ...persistedAttempt.blocks[0], type: 'invented' }],
      },
    })).toThrow(/type|block/iu);
    expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: {
        ...persistedAttempt,
        usage: { ...persistedAttempt.usage, inputTokens: -1 },
      },
    })).toThrow(/inputTokens|non-negative/iu);
  });

  it('requires exact enums, non-negative integers, bounded summaries, and string refs', () => {
    expect(() => validateAndSnapshotEventPayload('model_attempt_committed', {
      ...committedPayload,
      validatedAttempt: { ...persistedAttempt, finishReason: 'invented' },
    })).toThrow(/finishReason/iu);
    expect(() => validateAndSnapshotEventPayload('usage.recorded', {
      scope: 'run', usageId: 'usage-a', purpose: 'agent-turn', billingMode: 'byok',
      inputTokens: 1.5, outputTokens: 2, totalTokens: 3,
    })).toThrow(/inputTokens|integer/iu);
    expect(() => validateAndSnapshotEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'x'.repeat(4_097), refs: [],
    })).toThrow(/summary/iu);
    expect(() => validateAndSnapshotEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'done', refs: ['ok', 1],
    })).toThrow(/refs/iu);
    expect(() => validateAndSnapshotEventPayload('subagent.completed', {
      subagentId: 'subagent-a', summary: 'done', refs: Array.from({ length: 257 }, (_, i) => `ref-${i}`),
    })).toThrow(/refs/iu);
  });

  it('accepts arbitrary portable detail fields at every depth', () => {
    for (const detail of [
      { dbPassword: 'plain-value' },
      { database_password: 'plain-value' },
      { nested: { requestAuthorization: 'plain-value' } },
      { serviceCredential: 'plain-value' },
      { url: 'postgres://tester:secret@localhost/db' },
    ]) {
      expect(validateAndSnapshotEventPayload('run.failed', {
        code: 'FAILED', detail,
      })).toMatchObject({ code: 'FAILED', detail });
    }
  });

  it('accepts arbitrary portable credential-shaped values', () => {
    expect(() => validateAndSnapshotEventPayload('run.failed', {
      code: 'NOT_CONFIGURED',
      detail: { hasApiKey: true, nested: { hasPassword: false } },
    })).not.toThrow();
    expect(() => validateAndSnapshotEventPayload('run.failed', {
      code: 'NOT_CONFIGURED',
      detail: { hasApiKey: 'yes' },
    })).not.toThrow();
  });

  it('keeps terminal Tool outcomes summary-and-reference only', () => {
    expect(validateAndSnapshotEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: ['artifact:result-a'],
      evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    })).toEqual({
      summary: 'query completed', resultRefs: ['artifact:result-a'],
      evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    });
    expect(() => validateAndSnapshotEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: [], evidenceRefs: [],
      rawResult: { rows: [{ value: 'data' }] },
    })).toThrow(/unknown/iu);
    expect(() => validateAndSnapshotEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: [], evidenceRefs: ['missing-scheme'],
    })).toThrow(/evidence ref/iu);
    expect(() => validateAndSnapshotEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: [], evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    })).toThrow(/duplicate/iu);
    expect(() => validateAndSnapshotEventPayload('tool.succeeded', {
      summary: 'query completed', resultRefs: [],
      evidenceRefs: Array.from({ length: 33 }, (_, index) => `schemanaut-evidence:v1:artifact_${index.toString(16).padStart(64, 'a')}:${index.toString(16).padStart(64, 'b')}`),
    })).toThrow(/at most 32/iu);
  });

  it('rejects retired Tool terminal schemas instead of inventing result data', () => {
    expect(() => upcastAgentEvent({
      eventId: 'legacy-tool-terminal', projectId: 'project-a', sequence: 1,
      schemaVersion: 1, sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a',
      attemptId: 'attempt-a', invocationId: 'invocation-a', type: 'tool.succeeded',
      occurredAt: '2026-08-10T00:00:00.000Z',
      payload: { summary: 'legacy complete', resultRefs: ['artifact:legacy-result'] },
    })).toThrow('UNSUPPORTED_EVENT_SCHEMA:tool.succeeded:1');
  });

  it('upcasts pre-billing usage facts explicitly as byok', () => {
    for (const schemaVersion of [1, 2]) {
      const upgraded = upcastAgentEvent({
        eventId: `legacy-usage-${schemaVersion}`, projectId: 'project-a', sequence: schemaVersion,
        schemaVersion, sessionId: 'session-a', runId: 'run-a', type: 'usage.recorded',
        occurredAt: '2026-08-10T00:00:00.000Z',
        payload: schemaVersion === 1
          ? { scope: 'run', inputTokens: 2, outputTokens: 3, totalTokens: 5 }
          : {
              scope: 'attempt', usageId: 'usage-v2', purpose: 'agent-turn',
              inputTokens: 2, outputTokens: 3, totalTokens: 5,
            },
      });
      expect(upgraded).toMatchObject({ schemaVersion: 3, payload: { billingMode: 'byok' } });
    }
  });

  it('upcasts a legacy delivery revision into bounded semantic Model feedback', () => {
    const event = upcastAgentEvent({
      eventId: 'legacy-delivery-revision', projectId: 'project-a', sequence: 3,
      schemaVersion: 1, sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a',
      type: 'delivery.decided', occurredAt: '2026-08-10T00:00:02.000Z',
      payload: {
        evidenceRevision: 1,
        status: 'unverified',
        outcome: 'revision-requested',
        verifierId: 'legacy-verifier',
        verifierRevision: 'v1',
          evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      },
    });

    expect(event).toMatchObject({
      schemaVersion: 2,
      payload: {
        outcome: 'revision-requested',
        observation: { code: 'DELIVERY_REVISION_REQUIRED_LEGACY' },
      },
    });
    expect(() => validateAndSnapshotEventPayload('delivery.decided', {
      evidenceRevision: 1,
      status: 'unverified',
      outcome: 'revision-requested',
      evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    })).toThrow(/observation/iu);
  });

  it.each([
    ['run.resumed', { resumeState: 'Preparing', reason: 1 }, 'reason'],
    ['run.input_requested', { reason: 'need input', connectionId: 1 }, 'connectionId'],
    ['run.limit_reached', { limit: 'rounds', value: '9', resumeState: 'Preparing' }, 'value'],
    ['turn.started', { turnSnapshotId: 1 }, 'turnSnapshotId'],
    ['turn.context_compiled', { contextRef: 'context:a', tokenEstimate: '100' }, 'tokenEstimate'],
  ] as const)('validates optional %s fields when present', (type, payload, field) => {
    expect(() => validateAndSnapshotEventPayload(type, payload)).toThrow(new RegExp(field, 'iu'));
  });

  it.each([
    ['run.resumed', {}, { resumeState: 'Preparing' }],
    [
      'run.limit_reached', { limit: 'iterations' },
      { limit: 'iterations', resumeState: 'Preparing' },
    ],
    [
      'run.interrupted', { code: 'OPERATOR_INTERRUPTED' },
      { code: 'OPERATOR_INTERRUPTED', resumeState: 'Preparing' },
    ],
  ] as const)('upcasts a minimal valid v1 %s event with omitted optional fields', (
    type,
    payload,
    expected,
  ) => {
    expect(upcastAgentEvent({
      eventId: `legacy-${type}`, projectId: 'project-a', sequence: 1,
      schemaVersion: 1, sessionId: 'session-a', runId: 'run-a', type,
      occurredAt: '2026-08-10T00:00:00.000Z', payload,
    })).toMatchObject({ schemaVersion: 2, payload: expected });
  });

  it('requires run.steered content instead of accepting a metadata-only steering fact', () => {
    expect(() => validateAndSnapshotEventPayload('run.steered', {
      clientRequestId: 'request-a',
    })).toThrow(/content|required/iu);
  });

  it('rejects removed Tool validation event names', () => {
    const legacy = {
      invocationId: 'invocation-a', canonicalToolId: { namespace: 'database', name: 'execute' },
      toolRevision: 'database.execute@1', recoveryClass: 'read',
      intentDigest: 'a'.repeat(64), proposedRevision: 1,
    } as const;
    expect(() => validateAndSnapshotEventPayload('tool.validated' as never, legacy)).toThrow();
  });

});
