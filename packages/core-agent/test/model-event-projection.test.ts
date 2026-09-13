import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/events/agent-event.js';
import { AGENT_EVENT_SCHEMA_REGISTRY } from '../src/events/event-schema-registry.js';
import {
  latestSafeModelHistorySequence,
  MODEL_HISTORY_EVENT_TYPES,
  projectAgentEventForModel,
  projectAgentHistoryForModel,
} from '../src/context/model-event-projection.js';
import { PromptRuntime } from '../src/context/prompt-runtime.js';

describe('field-level Model event projection', () => {
  it('keeps the no-progress fingerprint Host-only and emits one useful semantic observation', () => {
    const fingerprint = 'a'.repeat(64);
    const event: AgentEvent<'turn.no_progress'> = {
      eventId: 'event-internal-no-progress', projectId: 'project-1', sequence: 7,
      schemaVersion: 1, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
      type: 'turn.no_progress', occurredAt: '2026-08-10T00:00:00.000Z',
      payload: { fingerprint },
    };

    expect(AGENT_EVENT_SCHEMA_REGISTRY['turn.no_progress'].audience).toEqual([
      'internal', 'audit',
    ]);
    const projected = projectAgentEventForModel(event);
    expect(projected).toEqual([{
      type: 'text',
      text: 'Observation: the previous committed turn produced no new committed evidence.',
    }]);
    const runtime = new PromptRuntime({
      runtimeProtocol: {
        id: 'runtime', source: 'runtime', scope: 'static', priority: 0,
        revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 1,
        content: [{ type: 'text', text: 'Follow the runtime protocol.' }],
      },
    });
    const compiled = runtime.compile({
      model: 'model-1', tools: [], sections: [{
        id: 'internal-event-projection', source: 'observation', scope: 'turn', priority: 0,
        revision: 'host-cursor-7', cacheability: 'never', tokenEstimate: 16,
        content: projected ?? [],
      }],
    });
    const visible = JSON.stringify(compiled.request);
    expect(visible).toContain('previous committed turn produced no new committed evidence');
    expect(visible).not.toContain(fingerprint);
    expect(visible).not.toMatch(
      /fingerprint|digest|revision|event-internal|run-1|turn-1|host-cursor/iu,
    );
  });

  it('does not manufacture a Model fact for an unrelated Host-only Kernel event', () => {
    const event: AgentEvent<'run.environment_bound'> = {
      eventId: 'event-environment', projectId: 'project-1', sequence: 4,
      schemaVersion: 1, sessionId: 'session-1', runId: 'run-1',
      type: 'run.environment_bound', occurredAt: '2026-08-10T00:00:00.000Z',
      payload: { environmentBindingId: 'environment-1', digest: 'b'.repeat(64) },
    };
    expect(projectAgentEventForModel(event)).toBeNull();
  });

  it('projects only the verifier observation from a delivery revision request', () => {
    const event = {
      eventId: 'event-delivery-revision', projectId: 'project-1', sequence: 8,
      schemaVersion: 2, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
      type: 'delivery.decided', occurredAt: '2026-08-10T00:00:00.000Z',
      payload: {
        evidenceRevision: 4,
        status: 'unverified',
        outcome: 'revision-requested',
        verifierId: 'database-delivery',
        verifierRevision: 'v2',
        evidenceRefs: ['schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        observation: { code: 'DATABASE_RESULT_NOT_DELIVERED' },
      },
    } as AgentEvent;

    expect(MODEL_HISTORY_EVENT_TYPES).toContain('delivery.decided');
    const visible = JSON.stringify(projectAgentEventForModel(event));
    expect(visible).toContain('DATABASE_RESULT_NOT_DELIVERED');
    expect(visible).not.toMatch(
      /database-delivery|private-host-handle|verifierRevision|event-delivery-revision|turn-1/iu,
    );
  });

  it.each(['plan.created', 'plan.updated'] as const)(
    'projects %s without its Host plan identity or revision',
    (type) => {
      const event: AgentEvent<typeof type> = {
        eventId: `event-${type}`, projectId: 'project-1', sequence: 9,
        schemaVersion: 1, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
        type, occurredAt: '2026-08-10T00:00:00.000Z',
        payload: {
          planId: 'host-plan-identity', revision: 13,
          plan: { goal: 'Inspect the project', steps: ['read', 'verify'] },
        },
      };
      expect(AGENT_EVENT_SCHEMA_REGISTRY[type].audience).toEqual(['internal', 'audit']);
      const visible = JSON.stringify(projectAgentEventForModel(event));
      expect(visible).toContain('Inspect the project');
      expect(visible).not.toMatch(/host-plan-identity|revision|event-plan|run-1|turn-1/iu);
    },
  );

  it('uses the field projector in ordered history without tentative or internal fallback data', () => {
    const fingerprint = 'f'.repeat(64);
    const events = [
      {
        eventId: 'event-tentative', projectId: 'project-1', sequence: 1,
        schemaVersion: 1, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
        attemptId: 'attempt-tentative', type: 'model_block_completed',
        occurredAt: '2026-08-10T00:00:00.000Z',
        payload: { block: { type: 'text', text: 'tentative-content-must-not-replay' } },
      },
      {
        eventId: 'event-plan', projectId: 'project-1', sequence: 2,
        schemaVersion: 1, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
        type: 'plan.updated', occurredAt: '2026-08-10T00:00:01.000Z',
        payload: {
          planId: 'internal-plan-id', revision: 8,
          plan: { goal: 'Deliver the current committed plan' },
        },
      },
      {
        eventId: 'event-no-progress', projectId: 'project-1', sequence: 3,
        schemaVersion: 1, sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
        type: 'turn.no_progress', occurredAt: '2026-08-10T00:00:02.000Z',
        payload: { fingerprint },
      },
      {
        eventId: 'event-environment', projectId: 'project-1', sequence: 4,
        schemaVersion: 1, sessionId: 'session-1', runId: 'run-1',
        type: 'run.environment_bound', occurredAt: '2026-08-10T00:00:03.000Z',
        payload: { environmentBindingId: 'internal-environment-id', digest: 'd'.repeat(64) },
      },
    ] as AgentEvent[];

    const visible = JSON.stringify(projectAgentHistoryForModel(events));
    expect(visible).toContain('Deliver the current committed plan');
    expect(visible).toContain('previous committed turn produced no new committed evidence');
    expect(visible).not.toMatch(
      /tentative-content|internal-plan-id|internal-environment-id|ffffffff|dddddddd/iu,
    );
  });

  it('never carries prior-Run provider opaque state into a later Run', () => {
    const priorOpaque = {
      type: 'provider-opaque' as const,
      opaqueRef: 'opaque-prior',
      protocol: 'openai-responses',
      origin: { connectionId: 'connection-prior', model: 'model-prior' },
      replay: 'same-connection-only' as const,
      value: { rawThinking: 'raw-chain-of-thought-must-not-cross-runs' },
    };
    const committed: AgentEvent<'model_attempt_committed'> = {
      eventId: 'event-prior-commit', projectId: 'project-1', sequence: 1,
      schemaVersion: 1, sessionId: 'session-1', runId: 'run-prior', turnId: 'turn-prior',
      attemptId: 'attempt-prior', type: 'model_attempt_committed',
      occurredAt: '2026-08-10T00:00:00.000Z',
      payload: {
        validatedAttempt: {
          attemptId: 'attempt-prior', terminal: true, validation: 'validated',
          origin: {
            connectionId: 'connection-prior', model: 'model-prior',
            protocol: 'openai-responses',
          },
          blocks: [
            priorOpaque,
            {
              type: 'reasoning-summary' as const,
              text: 'Safe reasoning summary.',
              derivedFromOpaqueRef: 'opaque-prior',
            },
          ],
          opaqueBlockRefs: ['opaque-prior'],
        },
        turn: { protocolEnvelopeRef: 'protocol:attempt-prior' },
        protocolEnvelope: {
          schemaVersion: 1,
          correlations: [],
        },
      },
    };

    const visible = JSON.stringify(projectAgentHistoryForModel([committed], {
      currentRunId: 'run-current',
      includeCurrentRunOpaque: true,
    }));
    expect(visible).toContain('Safe reasoning summary.');
    expect(visible).not.toMatch(/raw-chain-of-thought|opaque-prior|provider-opaque/iu);
  });

  it('never chooses an incremental checkpoint inside a Tool/Observation pair', () => {
    const events = [
      { sequence: 1, type: 'input.received', payload: { content: 'read it' } },
      {
        sequence: 2,
        type: 'model_attempt_committed',
        payload: {
          validatedAttempt: {
            blocks: [{
              type: 'tool-call-draft', draftCallKey: 'draft-1',
              name: 'read', arguments: {},
            }],
          },
          protocolEnvelope: {
            correlations: [{ draftCallKey: 'draft-1', callId: 'call-1' }],
          },
        },
      },
      {
        sequence: 3, type: 'tool.proposed',
        payload: { invocationId: 'invocation-1', callId: 'call-1' },
      },
      {
        sequence: 4, type: 'plan.updated',
        payload: { planId: 'plan-1', revision: 2, plan: { goal: 'still reading' } },
      },
      {
        sequence: 5, type: 'tool.observed',
        payload: { invocationId: 'invocation-1' },
      },
      { sequence: 6, type: 'turn.closed', payload: { reason: 'observed' } },
    ] as unknown as AgentEvent[];

    expect(latestSafeModelHistorySequence(events.slice(0, 4), 0)).toBe(1);
    expect(latestSafeModelHistorySequence(events, 0)).toBe(6);
  });

  it('replaces an unknown outcome with the user-resolved bounded Observation on the same call', () => {
    const events = [
      { sequence: 1, type: 'input.received', payload: { content: 'publish it' } },
      {
        sequence: 2,
        type: 'model_attempt_committed',
        payload: {
          validatedAttempt: {
            blocks: [{
              type: 'tool-call-draft', draftCallKey: 'draft-publish',
              name: 'publish', arguments: {},
            }],
          },
          protocolEnvelope: {
            correlations: [{ draftCallKey: 'draft-publish', callId: 'call-publish' }],
          },
        },
      },
      {
        sequence: 3, type: 'tool.proposed',
        payload: { invocationId: 'invocation-publish', callId: 'call-publish' },
      },
      {
        sequence: 4, type: 'tool.observed',
        payload: {
          invocationId: 'invocation-publish', outcome: 'unknown',
          summary: 'The external outcome is unknown.', evidenceRefs: [],
          modelProjection: { status: 'unknown-observation-must-be-replaced' },
        },
      },
      {
        sequence: 5, type: 'tool.outcome_resolved',
        payload: {
          invocationId: 'invocation-publish', outcome: 'succeeded',
          summary: 'The user confirmed the publish succeeded.', evidenceRefs: ['evidence:publish'],
          modelProjection: { status: 'confirmed-success' },
          userProjection: { rows: ['user-only-full-result'] },
          durableSummary: { internalNodeId: 'node-internal', hash: 'f'.repeat(64) },
        },
      },
      { sequence: 6, type: 'turn.closed', payload: { reason: 'observed' } },
    ] as unknown as AgentEvent[];

    const projected = projectAgentHistoryForModel(events, { currentRunId: 'run-1' });
    const toolResults = projected.flatMap((message) => message.content)
      .filter((block) => block.type === 'tool-result');
    expect(toolResults).toEqual([{
      type: 'tool-result', callId: 'call-publish',
      output: { status: 'confirmed-success' }, isError: false,
    }]);
    expect(JSON.stringify(projected)).not.toMatch(
      /unknown-observation-must-be-replaced|user-only-full-result|node-internal|f{64}/iu,
    );
    expect(latestSafeModelHistorySequence(events.slice(0, 4), 0)).toBe(1);
    expect(latestSafeModelHistorySequence(events, 0)).toBe(6);
  });
});
