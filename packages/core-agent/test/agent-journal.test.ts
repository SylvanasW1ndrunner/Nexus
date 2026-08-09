import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortableValue } from '@dbagent/shared';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  AgentJournalError,
  SqliteAgentJournal,
  replayAgentEvents,
  upcastAgentEvent,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SqliteAgentJournal', () => {
  it('persists gap-free project events and rebuilds the same projection after reopening', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath, now: () => '2026-08-09T00:00:00.000Z' });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: { text: 'inspect orders' },
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 10_000,
    });
    await journal.startRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      commandId: 'start-a',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });

    const firstRead = await journal.readProject('project-a', 0, 100);
    expect(firstRead.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'input.received'],
      [2, 'run.created'],
      [3, 'run.started'],
    ]);
    expect(firstRead.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(new Set(firstRead.map((event) => event.eventId)).size).toBe(3);
    expect(await journal.readProject('project-a', 1, 1)).toMatchObject([
      { sequence: 2, type: 'run.created' },
    ]);

    const reopened = new SqliteAgentJournal({ filePath });
    const secondRead = await reopened.readProject('project-a', 0, 100);
    expect(secondRead).toEqual(firstRead);
    expect(await reopened.getRunProjection(created.runId)).toMatchObject({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      state: 'Preparing',
      revision: 2,
    });
    expect(replayAgentEvents(firstRead)).toEqual(replayAgentEvents(secondRead));
    expect(replayAgentEvents(firstRead)).toEqual(replayAgentEvents(firstRead));
  });

  it('uses a static schema registry and upcasts without rewriting stored events', () => {
    expect(Object.keys(AGENT_EVENT_SCHEMA_REGISTRY)).toEqual(
      expect.arrayContaining([
        'input.received',
        'run.created',
        'model_attempt_committed',
        'tool.proposed',
        'usage.recorded',
      ]),
    );
    expect(AGENT_EVENT_SCHEMA_REGISTRY['model_attempt_committed']).toMatchObject({
      schemaVersion: 1,
      persistence: 'durable',
      audience: ['internal', 'model', 'audit'],
    });
    const event = {
      eventId: 'event-1',
      projectId: 'project-a',
      sequence: 9,
      schemaVersion: 1,
      sessionId: 'session-a',
      runId: 'run-a',
      type: 'run.started' as const,
      occurredAt: '2026-08-09T00:00:00.000Z',
      payload: {},
    };
    expect(upcastAgentEvent(event)).toEqual(event);
    expect(upcastAgentEvent(event)).not.toBe(event);
  });

  it('golden-upcasts every historical v1 legacy entity through the version discriminant', () => {
    const base = {
      eventId: 'legacy-event-1', projectId: 'project-a', sequence: 9, schemaVersion: 1,
      sessionId: 'session-a', runId: 'carrier-a', occurredAt: '2026-08-09T00:00:00.000Z',
      type: 'legacy.imported' as const,
    };
    const payloads: PortableValue[] = [
      {
        entityType: 'session', legacyId: 'session-a', projectKey: 'project-a', projectRoot: '/project-a',
        title: 'Historical', userId: 'user-a', mode: 'read',
      },
      {
        entityType: 'message', legacyId: 'session-a:2', messageIndex: 2,
        role: 'assistant', content: 'Calling lookup', createdAt: '2026-08-08T00:00:02.000Z',
        toolCalls: [{ id: 'call-a', name: 'lookup', arguments: { id: 7 } }],
      },
      {
        entityType: 'run', legacyId: 'run-a', sessionId: 'session-a', status: 'completed',
        plan: { steps: ['inspect'] }, createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:03.000Z',
      },
      {
        entityType: 'preference', legacyId: 'preference-a', userId: 'user-a', key: 'language',
        value: 'English', confidence: 0.75, sourceSessionId: 'session-a',
      },
      {
        entityType: 'checkpoint', legacyId: 'session-a:4', sessionId: 'session-a', sequence: 4,
        summary: 'Historical summary', createdAt: '2026-08-08T00:00:04.000Z',
      },
      {
        entityType: 'subagent', legacyId: 'subagent-a', parentSessionId: 'session-a',
        childSessionId: 'session-b', status: 'completed', depth: 1,
      },
      {
        entityType: 'diagnostic', legacyId: 'diagnostic-a', code: 'LEGACY_WARNING',
        evidence: 'Historical diagnostic',
      },
      {
        entityType: 'archive', legacyId: 'archive-a', relativePath: 'audit/events.jsonl',
        archiveHandle: `legacy-archive:${'b'.repeat(64)}`, checksum: 'a'.repeat(64), byteSize: 12,
      },
    ];

    expect(payloads.map((payload, index) => upcastAgentEvent({
      ...base, eventId: `legacy-event-${index + 1}`, sequence: index + 1, payload,
    }).payload)).toEqual([
      {
        entityType: 'session', legacyId: 'session-a', projectKey: 'project-a', projectRoot: '/project-a',
        record: {
          session: {
            id: 'session-a', title: 'Historical', userId: 'user-a', mode: 'read', messages: [],
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
          },
          archived: false, createdAt: '1970-01-01T00:00:00.000Z',
          updatedAt: '1970-01-01T00:00:00.000Z', lastMessageAt: null,
        },
      },
      {
        entityType: 'message', legacyId: 'session-a:2', messageIndex: 2,
        sourceRunId: 'legacy-session:session-a',
        record: {
          role: 'assistant', content: 'Calling lookup', createdAt: '2026-08-08T00:00:02.000Z',
          toolCalls: [{ id: 'call-a', name: 'lookup', arguments: { id: 7 } }],
        },
      },
      {
        entityType: 'run', legacyId: 'run-a', sourceStatus: 'done', legacyPlan: { steps: ['inspect'] },
        record: {
          runId: 'run-a', sessionId: 'session-a', status: 'done', phase: 'done', iteration: 0,
          finalText: '', toolExecutions: [], createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:03.000Z',
        },
      },
      {
        entityType: 'preference', legacyId: 'preference-a',
        record: {
          id: 'preference-a', userId: 'user-a', key: 'language', value: 'English', confidence: 0.75,
          sourceSessionId: 'session-a', createdAt: '1970-01-01T00:00:00.000Z',
          updatedAt: '1970-01-01T00:00:00.000Z',
        },
      },
      {
        entityType: 'checkpoint', legacyId: 'session-a:4', sessionId: 'session-a',
        record: {
          version: 1, sequence: 4, trigger: 'auto', method: 'deterministic-fallback',
          summary: 'Historical summary', coveredConversationMessageCount: 0,
          sourceTokenEstimate: 0, summaryTokenEstimate: 0, modelContextTokens: null,
          createdAt: '2026-08-08T00:00:04.000Z',
        },
      },
      {
        entityType: 'subagent', legacyId: 'subagent-a',
        record: {
          id: 'subagent-a', parentSessionId: 'session-a', childSessionId: 'session-b',
          task: 'Legacy subagent task unavailable', contextStrategy: 'fresh', status: 'completed', depth: 1,
          createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
        },
      },
      {
        entityType: 'diagnostic', legacyId: 'diagnostic-a', code: 'LEGACY_WARNING',
        evidence: 'Historical diagnostic',
      },
      {
        entityType: 'archive', legacyId: 'archive-a', relativePath: 'audit/events.jsonl',
        archiveHandle: `legacy-archive:${'b'.repeat(64)}`, checksum: 'a'.repeat(64), byteSize: 12,
      },
    ]);
  });

  it('golden-upcasts all four historical message roles', () => {
    const records: PortableValue[] = [
      { role: 'user', content: 'user', createdAt: '2026-08-08T00:00:01.000Z' },
      { role: 'system', content: 'system', createdAt: '2026-08-08T00:00:02.000Z' },
      {
        role: 'assistant', content: 'assistant', createdAt: '2026-08-08T00:00:03.000Z',
        toolCalls: [{ id: 'call-a', name: 'lookup', arguments: { id: 7 } }],
      },
      {
        role: 'tool', content: 'tool', createdAt: '2026-08-08T00:00:04.000Z',
        toolCallId: 'call-a', toolName: 'lookup',
      },
    ];
    const roles = records.map((record, index) => upcastAgentEvent({
      eventId: `legacy-role-${index}`, projectId: 'project-a', sequence: index + 1,
      schemaVersion: 1, sessionId: 'session-a', runId: 'carrier-a',
      occurredAt: '2026-08-09T00:00:00.000Z', type: 'legacy.imported' as const,
      payload: {
        entityType: 'message', legacyId: `session-a:${index}`, messageIndex: index,
        ...(record as Record<string, PortableValue>),
      },
    }).payload);
    expect(roles.map((payload) => payload.entityType === 'message' && payload.record.role))
      .toEqual(['user', 'system', 'assistant', 'tool']);
  });

  it.each([
    ['unknown session mode', {
      entityType: 'session', legacyId: 'session-a', projectKey: 'a', projectRoot: '/a',
      title: 'a', userId: null, mode: 'unknown',
    }],
    ['unknown message role', {
      entityType: 'message', legacyId: 'session-a:0', messageIndex: 0,
      role: 'unknown', content: 'a', createdAt: '2026-08-08T00:00:00.000Z',
    }],
    ['unknown run status', {
      entityType: 'run', legacyId: 'run-a', sessionId: 'session-a', status: 'unknown',
      plan: null, createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    }],
    ['unknown subagent status', {
      entityType: 'subagent', legacyId: 'subagent-a', parentSessionId: 'session-a',
      childSessionId: null, status: 'unknown', depth: 1,
    }],
    ['zero checkpoint sequence', {
      entityType: 'checkpoint', legacyId: 'checkpoint-a', sessionId: 'session-a', sequence: 0,
      summary: 'a', createdAt: '2026-08-08T00:00:00.000Z',
    }],
    ['zero subagent depth', {
      entityType: 'subagent', legacyId: 'subagent-a', parentSessionId: 'session-a',
      childSessionId: null, status: 'running', depth: 0,
    }],
    ['missing diagnostic evidence', {
      entityType: 'diagnostic', legacyId: 'diagnostic-a', code: 'A',
    }],
    ['extra diagnostic key', {
      entityType: 'diagnostic', legacyId: 'diagnostic-a', code: 'A', evidence: 'a', extra: true,
    }],
  ] satisfies Array<[string, PortableValue]>)('rejects strict historical v1 payload: %s', (
    _case,
    payload,
  ) => {
    expect(() => upcastAgentEvent({
      eventId: 'legacy-negative', projectId: 'project-a', sequence: 1, schemaVersion: 1,
      sessionId: 'session-a', runId: 'carrier-a', occurredAt: '2026-08-09T00:00:00.000Z',
      type: 'legacy.imported' as const, payload,
    })).toThrow(/CORRUPT_EVENT/u);
  });

  it('rejects producer-controlled metadata, unknown schemas, secrets, and non-portable payloads', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 10_000,
    });
    const base = {
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    };

    await expect(
      journal.commit({
        ...base,
        commandId: 'invent-metadata',
        events: [
          {
            type: 'run.started',
            payload: {},
            schemaVersion: 99,
            audience: ['user'],
          } as never,
        ],
      }),
    ).rejects.toMatchObject({ code: 'PRODUCER_METADATA_FORBIDDEN' });
    await expect(
      journal.commit({
        ...base,
        commandId: 'invent-type',
        events: [{ type: 'run.invented', payload: {} } as never],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EVENT_TYPE' });
    await expect(
      journal.commit({
        ...base,
        commandId: 'secret-payload',
        events: [{ type: 'run.failed', payload: { code: 'AUTH', detail: { apiKey: 'sk-secret' } } }],
      }),
    ).rejects.toBeInstanceOf(AgentJournalError);
    await expect(
      journal.commit({
        ...base,
        commandId: 'error-payload',
        events: [{ type: 'run.failed', payload: new Error('raw error') } as never],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(journal.countEvents(undefined, 'project-a')).resolves.toBe(2);
  });

  it('reserves committed model and proposed Tool facts for RunEventCommitter', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 10_000,
    });

    await expect(
      journal.commit({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'raw-model-commit',
        lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
        expectedRunRevision: 1,
        events: [
          {
            type: 'model_attempt_committed',
            turnId: 'turn-a',
            attemptId: 'attempt-a',
            payload: {
              attemptId: 'attempt-a',
              blocks: [{ type: 'text', text: 'bypass' }],
              finishReason: 'stop',
              protocolEnvelopeRef: 'forged-envelope',
            },
          } as never,
        ],
      }),
    ).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(0);
  });

  it('rejects unknown command and draft keys before they can override journal-owned identity', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const first = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'a',
    });
    const second = await journal.createRun({
      projectId: 'project-b', sessionId: 'session-b', clientRequestId: 'request-b', input: 'b',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: first.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    const base = {
      projectId: 'project-a', sessionId: 'session-a', runId: first.runId,
      commandId: 'identity-attack',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'run.started', payload: {}, projectId: 'project-b', sessionId: 'session-b',
        runId: second.runId, lease: { ownerId: 'attacker', fencingToken: 999 },
      }],
    } as unknown as Parameters<SqliteAgentJournal['commit']>[0];

    await expect(journal.commit(base)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.commit({ ...base, events: [{ type: 'run.started', payload: {} }], extra: true } as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.getRunProjection(first.runId)).resolves.toMatchObject({ revision: 1 });
    await expect(journal.getRunProjection(second.runId)).resolves.toMatchObject({ revision: 1 });
  });

  it.each([
    'run.completed', 'turn.started', 'model_attempt_started', 'model_failed',
    'tool.started', 'tool.succeeded', 'tool.observed',
  ] as const)('rejects generic writes of authority-bearing %s facts', async (type) => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'a',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: `reserved-${type}`,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{ type, payload: {} } as never],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
  });

  it('reserves input.received for createRun even when a generic producer holds the lease', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'input-authority',
      input: { text: 'original' },
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });

    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'forge-second-input',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'input.received',
        payload: { clientRequestId: 'forged-request', content: { text: 'forged' } },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    await expect(journal.countEvents('input.received', 'project-a')).resolves.toBe(1);
  });

  it('rejects a createRun input accessor before validation and persistence can observe different values', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    let valueReads = 0;
    const input: Record<string, PortableValue> = {};
    Object.defineProperty(input, 'text', {
      enumerable: true,
      get() {
        valueReads += 1;
        return valueReads === 1 ? 'validated' : 'persisted';
      },
    });

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'accessor-input', input,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(valueReads).toBe(0);
    await expect(journal.countEvents(undefined, 'project-a')).resolves.toBe(0);
  });

  it('rejects a generic command whose events accessor swaps into a reserved input fact', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'generic-swap', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    const command: Record<string, unknown> = {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'generic-events-swap',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    };
    let eventReads = 0;
    Object.defineProperty(command, 'events', {
      enumerable: true,
      get() {
        eventReads += 1;
        return eventReads === 1
          ? [{
              type: 'artifact.created',
              payload: {
                artifactId: 'a',
                handle: 'agent-artifact:a',
                checksum: 'a'.repeat(64),
                byteSize: 2,
                mediaType: 'text/plain',
                availability: 'available',
                summary: 'ok',
              },
            }]
          : [{ type: 'input.received', payload: { clientRequestId: 'forged', content: 'forged' } }];
      },
    });

    await expect(journal.commit(command as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(eventReads).toBe(0);
    await expect(journal.countEvents('input.received', 'project-a')).resolves.toBe(1);
  });

  it('rejects a Proxy event draft before its type or payload can change', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'draft-proxy', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    const draft = new Proxy({
      type: 'artifact.created' as const,
      payload: {
        artifactId: 'artifact-a',
        handle: 'agent-artifact:artifact-a',
        checksum: 'a'.repeat(64),
        byteSize: 4,
        mediaType: 'text/plain',
        availability: 'available' as const,
        summary: 'safe',
      },
    }, {});

    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'draft-proxy-command',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1, events: [draft],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.countEvents('artifact.created', 'project-a')).resolves.toBe(0);
  });

  it('keeps optional event draft causal keys optional after safe snapshotting', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'optional-draft', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });

    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'optional-draft-command',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'artifact.created',
        payload: {
          artifactId: `artifact_${'a'.repeat(64)}`,
          handle: `agent-artifact:0e3ffbf31db2e5b45f9fe42a:${'a'.repeat(40)}`,
          checksum: 'a'.repeat(64),
          byteSize: 4,
          mediaType: 'text/plain',
          availability: 'available',
          summary: 'safe',
        },
      }],
    })).resolves.toMatchObject({ events: [{ type: 'artifact.created' }] });
  });

  it('snapshots null-prototype Portable records and empty arrays without changing persisted input', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const input = Object.assign(Object.create(null) as Record<string, PortableValue>, {
      request: 'inspect', refs: [],
      nested: Object.assign(Object.create(null) as Record<string, PortableValue>, { ok: true }),
    });

    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'null-prototype', input,
    });

    await expect(journal.getRunProjection(created.runId)).resolves.toMatchObject({
      input: { request: 'inspect', refs: [], nested: { ok: true } },
    });
  });

  it('rejects a huge sparse Portable array without expanding its declared length', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const hugeLength = 0xffff_ffff;
    const sparse: PortableValue[] = [];
    Object.defineProperty(sparse, 'length', { value: hugeLength, writable: true });
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array, 'from');
    if (originalDescriptor === undefined) throw new Error('Array.from descriptor is unavailable.');
    const originalArrayFrom = Array.from;
    let attemptedDeclaredLengthExpansion = false;
    Object.defineProperty(Array, 'from', {
      ...originalDescriptor,
      value(this: unknown, ...args: unknown[]): unknown {
        const source = args[0];
        if (source !== null && typeof source === 'object') {
          const lengthDescriptor = Object.getOwnPropertyDescriptor(source, 'length');
          if (lengthDescriptor?.value === hugeLength) {
            attemptedDeclaredLengthExpansion = true;
            throw new Error('DECLARED_LENGTH_EXPANSION_BLOCKED');
          }
        }
        return Reflect.apply(originalArrayFrom, this, args) as unknown;
      },
    });

    try {
      await expect(journal.createRun({
        projectId: 'project-a', sessionId: 'session-a',
        clientRequestId: 'huge-sparse-array', input: sparse,
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(attemptedDeclaredLengthExpansion).toBe(false);
    } finally {
      Object.defineProperty(Array, 'from', originalDescriptor);
    }
  });

  it('rejects a cyclic Portable record at public ingress with a typed error', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const cyclic: Record<string, PortableValue> = {};
    cyclic.self = cyclic;

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'cyclic-input', input: cyclic,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects an ordinary sparse Portable array at public ingress with a typed error', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const sparse = new Array<PortableValue>(2);
    sparse[1] = 'present';

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'sparse-input', input: sparse,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects an extra own array key at public ingress with a typed error', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const value: PortableValue[] = [];
    Object.defineProperty(value, 'metadata', { value: 'forbidden', enumerable: true });

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'array-extra-key', input: value,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects a nested non-plain record at public ingress with a typed error', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'non-plain-input',
      input: { nested: new Date(0) } as never,
    })).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
  });

  it('rejects a startRun lease accessor before it can splice owner and token from different values', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'start-run-swap', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    const command: Record<string, unknown> = {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'start-run-accessor', expectedRunRevision: 1,
    };
    let leaseReads = 0;
    Object.defineProperty(command, 'lease', {
      enumerable: true,
      get() {
        leaseReads += 1;
        return leaseReads === 1
          ? { ownerId: lease.ownerId, fencingToken: 999 }
          : { ownerId: 'attacker', fencingToken: lease.fencingToken };
      },
    });

    await expect(journal.startRun(command as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(leaseReads).toBe(0);
    await expect(journal.countEvents('run.started', 'project-a')).resolves.toBe(0);
  });

  it('rejects a startTurn lease accessor before it can splice owner and token from different values', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'start-turn-swap', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    await journal.startRun({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'start-before-turn-swap',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken }, expectedRunRevision: 1,
    });
    const command: Record<string, unknown> = {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: 'turn-accessor', commandId: 'start-turn-accessor', expectedRunRevision: 2,
    };
    let leaseReads = 0;
    Object.defineProperty(command, 'lease', {
      enumerable: true,
      get() {
        leaseReads += 1;
        return leaseReads === 1
          ? { ownerId: lease.ownerId, fencingToken: 999 }
          : { ownerId: 'attacker', fencingToken: lease.fencingToken };
      },
    });

    await expect(journal.startTurn(command as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(leaseReads).toBe(0);
    await expect(journal.countEvents('turn.started', 'project-a')).resolves.toBe(0);
  });

  it('rejects an acquireRunLease Proxy before validation and SQL can observe different owners', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'acquire-proxy', input: 'go',
    });
    let ownerReads = 0;
    const target = {
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    };
    const attack = new Proxy(target, {
      get(value, property) {
        if (property !== 'ownerId') return value[property as keyof typeof value];
        ownerReads += 1;
        return ownerReads === 1 ? 'worker-a' : 'worker-b';
      },
    });

    await expect(journal.acquireRunLease(attack))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ownerReads).toBe(0);
  });

  it('rejects a renewRunLease Proxy before validation and SQL can observe different ttl and token values', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'renew-proxy', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    let ttlReads = 0;
    let tokenReads = 0;
    const target = {
      projectId: 'project-a', runId: created.runId, ownerId: lease.ownerId,
      ttlMs: 10_000, fencingToken: lease.fencingToken,
    };
    const attack = new Proxy(target, {
      get(value, property) {
        if (property === 'ttlMs') {
          ttlReads += 1;
          return ttlReads < 4 ? 10_000 : 1;
        }
        if (property === 'fencingToken') {
          tokenReads += 1;
          return tokenReads === 1 ? 999 : lease.fencingToken;
        }
        return value[property as keyof typeof value];
      },
    });

    await expect(journal.renewRunLease(attack))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ttlReads).toBe(0);
    expect(tokenReads).toBe(0);
  });

  it('does not expose the prepared model-attempt persistence primitive', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    expect('commitPreparedModelAttempt' in journal).toBe(false);
  });
});

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-journal-'));
  tempDirs.push(directory);
  return join(directory, 'nested', 'agent-journal.db');
}
