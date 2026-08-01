import { describe, expect, it, vi } from 'vitest';
import {
  AgentSubagentPool,
  ToolRegistry,
  createAgentSession,
  createMessage,
  isAgentToolResultEnvelope,
  type AgentRunOptions,
  type AgentRunResult,
} from '@dbagent/core-agent';
import { registerSubagentTools } from '../src/index.js';

describe('subagent tools', () => {
  it('supports fresh and fork context strategies without sharing mutable Session state', async () => {
    const observed: AgentRunOptions[] = [];
    const pool = new AgentSubagentPool((options) => {
      observed.push(options);
      return Promise.resolve(runResult(options.initialSession!, options.userMessage));
    });
    const registry = new ToolRegistry();
    let childIndex = 0;
    registerSubagentTools(registry, {
      pool,
      createChildSessionId: () => `child-session-${++childIndex}`,
      buildRunOptions: (task, context) => ({
        providerId: 'fake',
        model: 'fake',
        userMessage: task,
        mode: context.session.mode,
        ...(context.session.project === undefined ? {} : { project: context.session.project }),
      }),
    });
    const parent = parentSession();

    await registry.get('subagent_spawn')!.handler(
      { task: 'Independent research', contextStrategy: 'fresh' },
      { session: parent },
    );
    await registry.get('subagent_spawn')!.handler(
      { task: 'Continue the current investigation', contextStrategy: 'fork' },
      { session: parent },
    );
    await Promise.all(pool.list(parent.id).map((record) => pool.wait(record.id)));

    expect(observed).toHaveLength(2);
    expect(observed[0]?.initialSession).toMatchObject({
      id: 'child-session-1',
      messages: [],
    });
    expect(observed[0]?.initialSession?.activeSkills).toBeUndefined();
    expect(observed[1]?.initialSession?.id).toBe('child-session-2');
    expect(observed[1]?.initialSession?.messages).toMatchObject([
      { role: 'user', content: 'Inspect the current project.' },
      { role: 'assistant', content: 'I found the relevant service.' },
    ]);
    expect(observed[1]?.initialSession?.messages.some((message) => message.role === 'system')).toBe(
      false,
    );
    expect(observed[1]?.initialSession?.activeSkills).toMatchObject([
      { name: 'project-guide', scope: 'project' },
    ]);
    expect(observed[1]?.initialSession?.activeTools).toBeUndefined();
    expect(parent.messages).toHaveLength(3);
  });

  it('messages a running child and returns only terminal summary evidence to the parent', async () => {
    let finish: ((result: AgentRunResult) => void) | undefined;
    const running = new Promise<AgentRunResult>((resolve) => {
      finish = resolve;
    });
    const steer = vi.fn(() => true);
    const pool = new AgentSubagentPool(() => running, { steer });
    const registry = new ToolRegistry();
    registerSubagentTools(registry, {
      pool,
      createChildSessionId: () => 'child-live',
      buildRunOptions: (task, context) => ({
        providerId: 'fake',
        model: 'fake',
        userMessage: task,
        mode: context.session.mode,
      }),
    });
    const parent = parentSession();
    const spawned = (await registry.get('subagent_spawn')!.handler(
      { task: 'Inspect one subsystem' },
      { session: parent },
    )) as { id: string };

    await registry.get('subagent_message')!.handler(
      { id: spawned.id, message: 'Also verify the tests.' },
      { session: parent },
    );
    expect(steer).toHaveBeenCalledWith('child-live', 'Also verify the tests.');

    finish?.(runResult(createAgentSession({
      id: 'child-live',
      title: 'Child',
      mode: 'read',
      now: fixedNow,
    }), 'Verified implementation and tests.'));
    const waited = await registry.get('subagent_wait')!.handler(
      { id: spawned.id, timeoutMs: 1_000 },
      { session: parent },
    );
    expect(isAgentToolResultEnvelope(waited)).toBe(true);
    if (!isAgentToolResultEnvelope(waited)) throw new Error('Expected result envelope.');
    expect(waited.modelProjection).toMatchObject({
      id: spawned.id,
      status: 'completed',
      summary: 'Verified implementation and tests.',
    });
    expect(waited.completionEvidence).toMatchObject({
      kind: 'subagent',
      deliveryReady: true,
      outcome: 'succeeded',
    });
    expect(JSON.stringify(waited.modelProjection)).not.toContain('Inspect the current project');
  });
});

function parentSession() {
  const session = createAgentSession({
    id: 'parent-session',
    title: 'Parent',
    mode: 'read',
    project: { rootPath: 'C:/project', configDirectory: 'C:/project/.schemanaut' },
    activeSkills: [
      {
        name: 'project-guide',
        description: 'Project guidance',
        scope: 'project',
        instructions: 'Use project conventions.',
      },
    ],
    now: fixedNow,
  });
  session.messages.push(
    createMessage({ role: 'system', content: 'stale runtime instruction' }, fixedNow),
    createMessage({ role: 'user', content: 'Inspect the current project.' }, fixedNow),
    createMessage({ role: 'assistant', content: 'I found the relevant service.' }, fixedNow),
  );
  session.activeTools = ['old_dynamic_tool'];
  return session;
}

function runResult(session: ReturnType<typeof createAgentSession>, finalText: string): AgentRunResult {
  return {
    runId: `run-${session.id}`,
    status: 'done',
    session,
    finalText,
    iterations: 1,
    toolExecutions: [],
  };
}

function fixedNow(): string {
  return '2026-08-01T00:00:00.000Z';
}
