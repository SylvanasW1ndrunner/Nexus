import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { SessionModelBindingStore } from '../src/kernel/session-model-binding.js';
import { createTestModelSession } from './model-session-fixture.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Session-scoped model binding Journal', () => {
  it('persists before any Run exists and survives reopen without a synthetic Run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-binding-'));
    roots.push(root);
    const journal = new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
    const store = new SessionModelBindingStore(journal);
    const session = await createTestModelSession({
      connectionId: 'connection-1', modelId: 'model-1',
    });
    const binding = await store.bind({
      projectId: 'project-1', sessionId: 'session-1', commandId: 'bind-1',
      expectedRevision: 0, session,
    });
    expect(binding.revision).toBe(1);
    expect(await journal.countEvents(undefined, 'project-1')).toBe(0);
    const reopened = new SessionModelBindingStore(
      new SqliteAgentJournal({ filePath: journal.filePath }),
    );
    expect(await reopened.get('project-1', 'session-1')).toEqual(binding);
  });

  it('uses revision CAS, command replay and bounded session cursors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-binding-'));
    roots.push(root);
    const journal = new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
    const store = new SessionModelBindingStore(journal);
    const firstSession = await createTestModelSession({
      connectionId: 'connection-1', modelId: 'model-1',
    });
    const secondSession = await createTestModelSession({
      connectionId: 'connection-1', modelId: 'model-2',
    });
    const command = {
      projectId: 'project-1', sessionId: 'session-1', commandId: 'bind-1',
      expectedRevision: 0, session: firstSession,
    };
    expect(await store.bind(command)).toEqual(await store.bind(command));
    await expect(store.bind({
      ...command, commandId: 'bind-stale', session: secondSession,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await store.bind({
      ...command, commandId: 'bind-2', expectedRevision: 1, session: secondSession,
    });
    const first = await journal.readSessionEvents({
      projectId: 'project-1', sessionId: 'session-1', afterSequence: 0, limit: 1,
    });
    const second = await journal.readSessionEvents({
      projectId: 'project-1', sessionId: 'session-1',
      afterSequence: first.events[0]!.sequence, limit: 1,
    });
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.sequence).toBeGreaterThan(first.events[0]!.sequence);
  });
});
