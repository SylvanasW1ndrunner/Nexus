import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/events/agent-event.js';
import { AGENT_EVENT_SCHEMA_REGISTRY } from '../src/events/event-schema-registry.js';
import { projectAgentEventForModel } from '../src/context/model-event-projection.js';
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
});
