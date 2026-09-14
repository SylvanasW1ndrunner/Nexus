import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClientRequest } from '@dbagent/core-llm';
import { ModelExecutionGateway } from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { RunController } from '../src/kernel/run-controller.js';
import { SessionModelBindingStore } from '../src/kernel/session-model-binding.js';
import { PermissionManager } from '../src/permission-manager.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';
import { createTestModelSession } from './model-session-fixture.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Journal-backed Session model history', () => {
  it('replays committed prior Run conversation in Session order after a process restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-context-'));
    roots.push(root);
    const filePath = join(root, 'journal.db');
    const firstSession = await createTestModelSession({
      connectionId: 'connection-history', modelId: 'model-history',
      outputText: 'Remembered assistant answer.',
    });
    const firstJournal = new SqliteAgentJournal({ filePath });
    const firstKernel = kernel(firstJournal, firstSession, 'history-owner-first');
    const first = await firstKernel.start({
      projectId: 'project-history', sessionId: 'session-history',
      clientRequestId: 'history-request-one', input: 'Remember this committed user fact.',
    });
    await expect(firstKernel.advance(first.runId)).resolves.toMatchObject({ state: 'Completed' });

    const foreignSession = await createTestModelSession({
      connectionId: 'connection-history', modelId: 'model-history',
      outputText: 'Foreign assistant answer.',
    });
    const foreignKernel = kernel(firstJournal, foreignSession, 'history-owner-foreign');
    const foreign = await foreignKernel.start({
      projectId: 'project-history', sessionId: 'session-foreign',
      clientRequestId: 'history-request-foreign', input: 'Never leak this foreign Session.',
    });
    await expect(foreignKernel.advance(foreign.runId)).resolves.toMatchObject({ state: 'Completed' });

    const requests: ModelClientRequest[] = [];
    const restartedSession = await createTestModelSession({
      connectionId: 'connection-history', modelId: 'model-history',
      outputText: 'Second answer.', onExecute: (request) => requests.push(request),
    });
    const restartedJournal = new SqliteAgentJournal({ filePath });
    const restartedKernel = kernel(
      restartedJournal, restartedSession, 'history-owner-restarted',
    );
    const second = await restartedKernel.start({
      projectId: 'project-history', sessionId: 'session-history',
      clientRequestId: 'history-request-two', input: 'What did we establish before?',
    });
    await expect(restartedKernel.advance(second.runId)).resolves.toMatchObject({
      state: 'Completed',
    });

    expect(requests).toHaveLength(1);
    const visible = JSON.stringify(requests[0]?.wireRequest);
    expect(visible).toContain('Remember this committed user fact.');
    expect(visible).toContain('Remembered assistant answer.');
    expect(visible).toContain('What did we establish before?');
    expect(count(visible, 'What did we establish before?')).toBe(1);
    expect(visible).not.toContain('Never leak this foreign Session.');
    expect(visible).not.toContain('Foreign assistant answer.');
  });

  it('replays current-Run opaque state after a Session model switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-current-opaque-'));
    roots.push(root);
    const filePath = join(root, 'journal.db');
    const journal = new SqliteAgentJournal({ filePath });
    const firstSession = await createTestModelSession({
      connectionId: 'connection-before-switch', modelId: 'model-before-switch',
      outputText: 'The first model completed its Run.',
    });
    const firstKernel = kernel(journal, firstSession, 'opaque-owner-before-switch');
    const first = await firstKernel.start({
      projectId: 'project-current-opaque', sessionId: 'session-current-opaque',
      clientRequestId: 'current-opaque-before-switch', input: 'Complete the first Run.',
    });
    await expect(firstKernel.advance(first.runId)).resolves.toMatchObject({ state: 'Completed' });

    const requests: ModelClientRequest[] = [];
    const opaqueSentinel = 'current-run-encrypted-reasoning';
    let attempt = 0;
    const switchedSession = await createTestModelSession({
      connectionId: 'connection-after-switch', modelId: 'model-after-switch',
      execute: (request) => {
        requests.push(request);
        attempt += 1;
        return Promise.resolve({
          kind: 'json' as const,
          response: attempt === 1
            ? {
                id: 'response-current-opaque-tool', model: 'model-after-switch',
                status: 'completed',
                output: [
                  {
                    id: 'reasoning-current-opaque', type: 'reasoning', summary: [],
                    encrypted_content: opaqueSentinel,
                  },
                  {
                    id: 'item-current-opaque', type: 'function_call',
                    call_id: 'call-current-opaque', name: 'inspect_after_switch', arguments: '{}',
                  },
                ],
              }
            : {
                id: 'response-current-opaque-final', model: 'model-after-switch',
                status: 'completed',
                output: [{
                  id: 'message-current-opaque-final', type: 'message', role: 'assistant',
                  content: [{ type: 'output_text', text: 'The switched Run completed.' }],
                }],
              },
        });
      },
    });
    const priorBinding = await new SessionModelBindingStore(journal).get(
      'project-current-opaque', 'session-current-opaque',
    );
    if (priorBinding === null) throw new Error('Expected the first Session model binding.');
    await new SessionModelBindingStore(journal).bind({
      projectId: 'project-current-opaque', sessionId: 'session-current-opaque',
      commandId: 'switch-current-opaque-model', expectedRevision: priorBinding.revision,
      session: switchedSession,
    });
    const tools = fixedBaselineRegistry();
    const inspect = invocationContribution('inspect_after_switch', { inspected: true }, {
      toolRevision: 'inspect-after-switch@1', handlerRevision: 'inspect-after-switch@1',
      exposure: 'direct', timeoutMs: 15_000,
    });
    tools.registerInvocation(inspect.definition, inspect.runtime);
    const switchedKernel = kernel(
      new SqliteAgentJournal({ filePath }), switchedSession,
      'opaque-owner-after-switch', tools.captureSnapshot(),
    );
    const second = await switchedKernel.start({
      projectId: 'project-current-opaque', sessionId: 'session-current-opaque',
      clientRequestId: 'current-opaque-after-switch', input: 'Inspect after switching models.',
    });
    await expect(switchedKernel.advance(second.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(switchedKernel.advance(second.runId)).resolves.toMatchObject({ state: 'Completed' });

    expect(requests).toHaveLength(2);
    const continuation = JSON.stringify(requests[1]?.wireRequest);
    expect(continuation).toContain(opaqueSentinel);
    expect(continuation).toContain('reasoning-current-opaque');
    expect(continuation).toContain('call-current-opaque');
  });

  it('allows only one top-level Run when two runtimes start the same Session concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-concurrency-'));
    roots.push(root);
    const journal = new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
    const session = await createTestModelSession({
      connectionId: 'connection-concurrency', modelId: 'model-concurrency',
    });
    await new SessionModelBindingStore(journal).bind({
      projectId: 'project-concurrency', sessionId: 'session-concurrency',
      commandId: 'concurrency-model-binding', expectedRevision: 0, session,
    });
    const firstKernel = kernel(journal, session, 'concurrency-owner-first');
    const secondKernel = kernel(journal, session, 'concurrency-owner-second');
    const results = await Promise.allSettled([
      firstKernel.start({
        projectId: 'project-concurrency', sessionId: 'session-concurrency',
        clientRequestId: 'concurrency-request-one', input: 'First active request.',
      }),
      secondKernel.start({
        projectId: 'project-concurrency', sessionId: 'session-concurrency',
        clientRequestId: 'concurrency-request-two', input: 'Second overlapping request.',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected', reason: { code: 'SESSION_RUN_ACTIVE' },
    });
  });

  it('replays only the bounded Tool Observation, never durable or user-only result payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-tool-context-'));
    roots.push(root);
    const filePath = join(root, 'journal.db');
    let firstCalls = 0;
    const firstSession = await createTestModelSession({
      connectionId: 'connection-tool-history', modelId: 'model-tool-history',
      execute: () => {
        firstCalls += 1;
        return Promise.resolve({
          kind: 'json' as const,
          response: firstCalls === 1
            ? {
                id: 'response-prior-tool', model: 'model-tool-history', status: 'completed',
                output: [{
                  id: 'call-prior-tool', type: 'function_call', call_id: 'wire-prior-tool',
                  name: 'read_bounded_value', arguments: '{"key":"alpha"}',
                }],
              }
            : {
                id: 'response-prior-final', model: 'model-tool-history', status: 'completed',
                output: [{
                  id: 'message-prior-final', type: 'message', role: 'assistant',
                  content: [{ type: 'output_text', text: 'Prior Tool task completed.' }],
                }],
              },
        });
      },
    });
    const tools = fixedBaselineRegistry();
    const bounded = invocationContribution(
      'read_bounded_value',
      { rows: [{ value: 'bounded-observation' }], rowCount: 50_000 },
      { toolRevision: 'read-bounded-value@1', handlerRevision: 'read-bounded-value@1', exposure: 'direct' },
    );
    tools.registerInvocation({
      ...bounded.definition,
      description: 'Read one bounded value.',
      inputSchema: {
        type: 'object', required: ['key'], properties: { key: { type: 'string' } },
      },
    }, bounded.runtime);
    const firstJournal = new SqliteAgentJournal({ filePath });
    const firstKernel = kernel(
      firstJournal, firstSession, 'tool-history-owner-first', tools.captureSnapshot(),
    );
    const first = await firstKernel.start({
      projectId: 'project-tool-history', sessionId: 'session-tool-history',
      clientRequestId: 'tool-history-request-one', input: 'Read alpha.',
    });
    await expect(firstKernel.advance(first.runId)).resolves.toMatchObject({ state: 'Preparing' });
    await expect(firstKernel.advance(first.runId)).resolves.toMatchObject({ state: 'Completed' });

    const requests: ModelClientRequest[] = [];
    const restartedSession = await createTestModelSession({
      connectionId: 'connection-tool-history-next', modelId: 'model-tool-history-next',
      outputText: 'New answer.', onExecute: (request) => requests.push(request),
    });
    const bindingStore = new SessionModelBindingStore(firstJournal);
    const previousBinding = await bindingStore.get('project-tool-history', 'session-tool-history');
    if (previousBinding === null) throw new Error('Expected the first Session Model binding.');
    await bindingStore.bind({
      projectId: 'project-tool-history', sessionId: 'session-tool-history',
      commandId: 'tool-history-switch-model', expectedRevision: previousBinding.revision,
      session: restartedSession,
    });
    const restartedKernel = kernel(
      new SqliteAgentJournal({ filePath }), restartedSession,
      'tool-history-owner-restarted', tools.captureSnapshot(),
    );
    const second = await restartedKernel.start({
      projectId: 'project-tool-history', sessionId: 'session-tool-history',
      clientRequestId: 'tool-history-request-two', input: 'Use the prior observation.',
    });
    await expect(restartedKernel.advance(second.runId)).resolves.toMatchObject({ state: 'Completed' });

    const visible = JSON.stringify(requests[0]?.wireRequest);
    expect(visible).toContain('bounded-observation');
    expect(visible).toContain('read_bounded_value');
    expect(visible).not.toContain('internal-node-identity');
    expect(visible).not.toContain('user-only-large-result-reference');
    expect(visible).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('reuses the latest Session checkpoint in a later Run and keeps only post-checkpoint delta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-checkpoint-context-'));
    roots.push(root);
    const filePath = join(root, 'journal.db');
    const firstSession = await createTestModelSession({
      connectionId: 'connection-checkpoint', modelId: 'model-checkpoint',
      outputText: 'Pre-checkpoint assistant answer.',
    });
    const firstJournal = new SqliteAgentJournal({ filePath });
    const firstKernel = kernel(firstJournal, firstSession, 'checkpoint-owner-first');
    const first = await firstKernel.start({
      projectId: 'project-checkpoint', sessionId: 'session-checkpoint',
      clientRequestId: 'checkpoint-request-one', input: 'Pre-checkpoint user request.',
    });
    await expect(firstKernel.advance(first.runId)).resolves.toMatchObject({ state: 'Completed' });

    const deltaSession = await createTestModelSession({
      connectionId: 'connection-checkpoint', modelId: 'model-checkpoint',
      outputText: 'Assistant delta committed after checkpoint.',
    });
    const deltaKernel = kernel(firstJournal, deltaSession, 'checkpoint-owner-delta');
    const delta = await deltaKernel.start({
      projectId: 'project-checkpoint', sessionId: 'session-checkpoint',
      clientRequestId: 'checkpoint-request-delta', input: 'Create a compacted history boundary.',
    });
    const environment = await firstJournal.getEnvironmentBinding({
      projectId: delta.projectId, sessionId: delta.sessionId, runId: delta.runId,
    });
    if (environment === null) throw new Error('Expected the exact delta Run Environment.');
    const controller = new RunController({
      journal: firstJournal,
      projectId: delta.projectId,
      sessionId: delta.sessionId,
      runId: delta.runId,
      ownerId: 'checkpoint-controller',
      leaseTtlMs: 60_000,
    });
    await controller.acquire();
    const captured = await controller.captureTurn({
      commandId: 'checkpoint-capture-turn',
      expectedRunRevision: delta.revision,
      turnId: 'turn-checkpoint-delta',
      environment: environment.payload,
      snapshot: {
        turnSnapshotId: 'snapshot-checkpoint-delta',
        capability: { snapshotId: 'capability-history', revision: 'capability-history@1' },
        promptRevision: 'prompt-history@1', tools: [], skills: [], verifiers: [],
      },
    });
    const index = await firstJournal.getSessionIndex(delta.projectId, delta.sessionId);
    if (index === null) throw new Error('Expected the Session index at the checkpoint boundary.');
    const compacting = await controller.startContextCompaction({
      commandId: 'checkpoint-start',
      expectedRunRevision: captured.run.revision,
      checkpointId: 'checkpoint-session-history',
      decisionId: 'decision-session-history',
      reason: 'manual',
      coveredSequence: index.lastActivitySequence,
    });
    await controller.completeContextCompaction({
      commandId: 'checkpoint-complete',
      expectedRunRevision: compacting.run.revision,
      checkpointId: 'checkpoint-session-history',
      decisionId: 'decision-session-history',
      summaryRef: 'context:checkpoint-session-history',
      summary: 'Durable compacted Session summary.',
      coveredSequence: index.lastActivitySequence,
      attemptId: 'attempt-session-history-compaction',
    });
    await controller.release();
    await expect(deltaKernel.advance(delta.runId)).resolves.toMatchObject({ state: 'Completed' });

    const requests: ModelClientRequest[] = [];
    const restartedSession = await createTestModelSession({
      connectionId: 'connection-checkpoint', modelId: 'model-checkpoint',
      outputText: 'Later answer.', onExecute: (request) => requests.push(request),
    });
    const restartedKernel = kernel(
      new SqliteAgentJournal({ filePath }), restartedSession,
      'checkpoint-owner-restarted',
    );
    const second = await restartedKernel.start({
      projectId: 'project-checkpoint', sessionId: 'session-checkpoint',
      clientRequestId: 'checkpoint-request-two', input: 'Continue after the checkpoint.',
    });
    await expect(restartedKernel.advance(second.runId)).resolves.toMatchObject({ state: 'Completed' });

    const visible = JSON.stringify(requests[0]?.wireRequest);
    expect(count(visible, 'Durable compacted Session summary.')).toBe(1);
    expect(visible).toContain('Assistant delta committed after checkpoint.');
    expect(visible).toContain('Continue after the checkpoint.');
    expect(visible).not.toContain('Pre-checkpoint user request.');
    expect(visible).not.toContain('Pre-checkpoint assistant answer.');
    expect(visible).not.toContain('Create a compacted history boundary.');
  });

  it('incrementally checkpoints a large Session through bounded safe history pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-session-bounded-history-'));
    roots.push(root);
    const filePath = join(root, 'journal.db');
    const journal = new SqliteAgentJournal({ filePath });
    const session = await createTestModelSession({
      connectionId: 'connection-bounded-history', modelId: 'model-bounded-history',
      outputText: 'A committed historical answer.',
    });
    const initialKernel = kernel(journal, session, 'bounded-history-owner-initial');
    for (let index = 0; index < 3; index += 1) {
      const run = await initialKernel.start({
        projectId: 'project-bounded-history', sessionId: 'session-bounded-history',
        clientRequestId: `bounded-history-request-${index}`,
        input: `Historical request ${index}.`,
      });
      await expect(initialKernel.advance(run.runId)).resolves.toMatchObject({ state: 'Completed' });
    }

    const requests: ModelClientRequest[] = [];
    const boundedSession = await createTestModelSession({
      connectionId: 'connection-bounded-history', modelId: 'model-bounded-history',
      outputText: 'Bounded current answer.', onExecute: (request) => requests.push(request),
    });
    const boundedKernel = kernel(
      new SqliteAgentJournal({ filePath }), boundedSession, 'bounded-history-owner-current',
      fixedBaselineRegistry().captureSnapshot(), 2,
    );
    const current = await boundedKernel.start({
      projectId: 'project-bounded-history', sessionId: 'session-bounded-history',
      clientRequestId: 'bounded-history-request-current', input: 'Continue bounded history.',
    });
    await expect(boundedKernel.advance(current.runId)).resolves.toMatchObject({
      state: 'Completed',
    });

    expect(requests.length).toBeGreaterThan(1);
    const checkpoint = await journal.getLatestSessionContextCheckpoint({
      projectId: 'project-bounded-history', sessionId: 'session-bounded-history',
      throughSequence: Number.MAX_SAFE_INTEGER, status: 'compacted',
    });
    expect(checkpoint).not.toBeNull();
  });
});

function kernel(
  journal: SqliteAgentJournal,
  session: Awaited<ReturnType<typeof createTestModelSession>>,
  ownerId: string,
  toolCatalog = fixedBaselineRegistry().captureSnapshot(),
  maxContextEvents?: number,
) {
  return createJournalAgentKernel({
    journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog,
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 8,
      content: [{ type: 'text', text: 'Use committed Session history and answer.' }],
    },
    capability: { snapshotId: 'capability-history', revision: 'capability-history@1' },
    promptRevision: 'prompt-history@1', settingsRevision: 'settings-history@1',
    permissionPolicyRevision: 'permission-history@1', ownerId,
    revalidateToolTarget: () => undefined,
    ...(maxContextEvents === undefined ? {} : { maxContextEvents }),
  });
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
