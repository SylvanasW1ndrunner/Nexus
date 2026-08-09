import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('run ingress idempotency', () => {
  it('returns the original run for a repeated clientRequestId without duplicate events', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const input = {
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: { text: 'inspect orders', artifacts: ['artifact-a'] },
    };

    const first = await journal.createRun(input);
    const second = await journal.createRun(input);

    expect(second).toEqual(first);
    expect(await journal.countEvents('input.received', 'project-a')).toBe(1);
    expect(await journal.countEvents('run.created', 'project-a')).toBe(1);
  });

  it('normalizes object keys but rejects conflicting reuse of a clientRequestId', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const base = {
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
    };
    const first = await journal.createRun({ ...base, input: { b: 2, a: 1 } });
    await expect(journal.createRun({ ...base, input: { a: 1, b: 2 } })).resolves.toEqual(first);
    await expect(journal.createRun({ ...base, input: { a: 1, b: 3 } })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await journal.countEvents('input.received', 'project-a')).toBe(1);
  });

  it('resolves a cross-instance createRun race to one durable run', async () => {
    const filePath = await journalPath();
    const firstWriter = new SqliteAgentJournal({ filePath, busyTimeoutMs: 5_000 });
    const secondWriter = new SqliteAgentJournal({ filePath, busyTimeoutMs: 5_000 });
    const input = {
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-race',
      input: { text: 'one request' },
    };

    const [first, second] = await Promise.all([
      firstWriter.createRun(input),
      secondWriter.createRun(input),
    ]);

    expect(first.runId).toBe(second.runId);
    expect(await firstWriter.countEvents('input.received', 'project-a')).toBe(1);
    expect((await firstWriter.readProject('project-a', 0, 100)).map(({ sequence }) => sequence)).toEqual([
      1, 2,
    ]);
  });
});

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-ingress-'));
  tempDirs.push(directory);
  return join(directory, 'agent-journal.db');
}
