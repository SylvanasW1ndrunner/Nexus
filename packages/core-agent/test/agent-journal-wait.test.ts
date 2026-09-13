import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/events/agent-event.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { RunController } from '../src/kernel/run-controller.js';
import { resolveViteNodeEntry } from './fixtures/vite-node-entry.js';

const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all([...liveChildren].map(async (child) => {
    child.kill('SIGKILL');
    await waitForChild(child, 2_000).catch(() => undefined);
  }));
  liveChildren.clear();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('SQLite Agent Journal Run wait', () => {
  it('requires exact Project/Session/Run scope and strict bounded cursors', async () => {
    const fixture = await createdRun('strict');
    const base = {
      ...fixture.scope,
      afterSequence: 0,
      limit: 100,
      timeoutMs: 10,
    };

    const page = await waitRunEvents(fixture.journal, base);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) =>
      event.projectId === fixture.scope.projectId &&
      event.sessionId === fixture.scope.sessionId &&
      event.runId === fixture.scope.runId)).toBe(true);

    await expectCode(waitRunEvents(fixture.journal, {
      ...base, projectId: 'project-from-another-scope',
    }), 'RUN_IDENTITY_CONFLICT');
    await expectCode(waitRunEvents(fixture.journal, {
      ...base, sessionId: 'session-from-another-scope',
    }), 'RUN_IDENTITY_CONFLICT');
    await expectCode(waitRunEvents(fixture.journal, {
      ...base, runId: 'run-does-not-exist',
    }), 'RUN_NOT_FOUND');

    for (const afterSequence of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expectCode(waitRunEvents(fixture.journal, {
        ...base, afterSequence,
      }), 'INVALID_ARGUMENT');
    }
    for (const limit of [0, 1.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expectCode(waitRunEvents(fixture.journal, {
        ...base, limit,
      }), 'INVALID_ARGUMENT');
    }
  });

  it('returns existing events immediately in source-sequence order and honors limit/afterSequence', async () => {
    const fixture = await createdRun('immediate');
    const startedAt = performance.now();
    const first = await waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence: 0, limit: 1, timeoutMs: 5_000,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(first.events).toHaveLength(1);
    expect(first.nextSequence).toBe(first.events[0]?.sequence);
    expect(first.closed).toBe(false);

    const second = await waitRunEvents(fixture.journal, {
      ...fixture.scope,
      afterSequence: first.events[0]!.sequence,
      limit: 1,
      timeoutMs: 5_000,
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.sequence).toBeGreaterThan(first.events[0]!.sequence);
    expect(second.events[0]!.runId).toBe(fixture.scope.runId);
  });

  it('returns an empty open page when a timed wait sees no newer committed event', async () => {
    const fixture = await createdRun('timeout');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const startedAt = performance.now();

    const page = await waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 30,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(page).toEqual({ events: [], nextSequence: null, closed: false });
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('rejects promptly with AbortError for both pre-aborted and in-flight waits', async () => {
    const fixture = await createdRun('abort');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const preAborted = new AbortController();
    preAborted.abort();
    await expectName(waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 5_000,
      signal: preAborted.signal,
    }), 'AbortError');

    const controller = new AbortController();
    const startedAt = performance.now();
    const waiting = waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expectName(waiting, 'AbortError');
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('sets closed only when a terminal Run has no unread event remaining', async () => {
    const fixture = await terminalRun('terminal');
    const first = await waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence: 0, limit: 1, timeoutMs: 5_000,
    });
    expect(first.events).toHaveLength(1);
    expect(first.closed).toBe(false);

    const rest = await waitRunEvents(fixture.journal, {
      ...fixture.scope,
      afterSequence: first.events[0]!.sequence,
      limit: 1_000,
      timeoutMs: 5_000,
    });
    expect(rest.events.length).toBeGreaterThan(0);
    expect(rest.events.at(-1)?.type).toBe('run.failed');
    expect(rest.closed).toBe(true);

    const drained = await waitRunEvents(fixture.journal, {
      ...fixture.scope,
      afterSequence: rest.events.at(-1)!.sequence,
      limit: 1_000,
      timeoutMs: 5_000,
    });
    expect(drained).toEqual({ events: [], nextSequence: null, closed: true });
  });

  it('wakes concurrent subscribers independently for the same committed source event', async () => {
    const fixture = await createdRun('concurrent');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const waits = Array.from({ length: 8 }, () => waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 2_000,
    }));
    await nextMacrotask();
    const lease = await fixture.journal.acquireRunLease({
      projectId: fixture.scope.projectId,
      runId: fixture.scope.runId,
      ownerId: 'concurrent-writer',
      ttlMs: 60_000,
    });
    await fixture.journal.startRun({
      ...fixture.scope,
      commandId: 'concurrent-start',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });

    const pages = await Promise.all(waits);
    expect(pages).toHaveLength(8);
    expect(pages.every((page) =>
      page.events.length === 1 && page.events[0]?.type === 'run.started')).toBe(true);
    expect(new Set(pages.map((page) => page.events[0]!.eventId)).size).toBe(1);
  });

  it('removes abort listeners and pending timers after an event settles the wait', async () => {
    vi.useFakeTimers();
    const fixture = await createdRun('cleanup');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 60_000,
      signal: controller.signal,
    });
    await flushMicrotasks();
    const lease = await fixture.journal.acquireRunLease({
      projectId: fixture.scope.projectId,
      runId: fixture.scope.runId,
      ownerId: 'cleanup-writer',
      ttlMs: 60_000,
    });
    await fixture.journal.startRun({
      ...fixture.scope,
      commandId: 'cleanup-start',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({
      events: [expect.objectContaining({ type: 'run.started' })],
      closed: false,
    });
    expect(add).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats reopened SQLite state as truth, including commits from another Journal instance', async () => {
    const fixture = await createdRun('reopen');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const waiting = waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 2_000,
    });
    await nextMacrotask();

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    const lease = await reopened.acquireRunLease({
      projectId: fixture.scope.projectId,
      runId: fixture.scope.runId,
      ownerId: 'reopened-writer',
      ttlMs: 60_000,
    });
    await reopened.startRun({
      ...fixture.scope,
      commandId: 'reopened-start',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });

    const page = await waiting;
    expect(page.events.map(({ type }) => type)).toEqual(['run.started']);
    expect(page.closed).toBe(false);
    expect(await waitRunEvents(reopened, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 5_000,
    })).toEqual(page);
  });

  it('polls durable SQLite truth when an independent OS process commits', async () => {
    const fixture = await createdRun('process');
    const afterSequence = await runTail(fixture.journal, fixture.scope);
    const startedAt = performance.now();
    const waiting = waitRunEvents(fixture.journal, {
      ...fixture.scope, afterSequence, limit: 100, timeoutMs: 5_000,
    });
    await nextMacrotask();

    const writer = spawn(process.execPath, [viteNodePath(), waitWriterPath()], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
      env: {
        ...process.env,
        SCHEMANAUT_JOURNAL_WAIT_WRITER: JSON.stringify({
          filePath: fixture.filePath,
          ...fixture.scope,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    liveChildren.add(writer);
    let output = '';
    writer.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    writer.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const exit = await waitForChild(writer, 10_000);
    liveChildren.delete(writer);
    expect(exit.code, output).toBe(0);

    await expect(waiting).resolves.toMatchObject({
      events: [expect.objectContaining({ type: 'run.started' })],
      closed: false,
    });
    expect(performance.now() - startedAt).toBeLessThan(4_000);
  }, 15_000);
});

type RunScope = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
}>;

type WaitRunEventsInput = RunScope & Readonly<{
  afterSequence: number;
  limit: number;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

type WaitRunEventsResult = Readonly<{
  events: readonly AgentEvent[];
  nextSequence: number | null;
  closed: boolean;
}>;

function waitRunEvents(
  journal: SqliteAgentJournal,
  input: WaitRunEventsInput,
): Promise<WaitRunEventsResult> {
  const wait = Reflect.get(journal, 'waitRunEvents') as unknown;
  if (typeof wait !== 'function') {
    throw new Error(
      'RED contract: Journal must expose waitRunEvents({projectId,sessionId,runId,' +
      'afterSequence,limit,timeoutMs,signal?}).',
    );
  }
  return Reflect.apply(wait, journal, [input]) as Promise<WaitRunEventsResult>;
}

async function createdRun(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `agent-journal-wait-${label}-`));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'journal.db');
  const journal = new SqliteAgentJournal({ filePath });
  const projectId = `project-${label}`;
  const sessionId = `session-${label}`;
  const created = await journal.createRun({
    projectId,
    sessionId,
    clientRequestId: `request-${label}`,
    input: `wait fixture ${label}`,
  });
  return {
    journal,
    filePath,
    scope: { projectId, sessionId, runId: created.runId },
  };
}

async function terminalRun(label: string) {
  const fixture = await createdRun(label);
  const controller = new RunController({
    journal: fixture.journal,
    ...fixture.scope,
    ownerId: `terminal-owner-${label}`,
    leaseTtlMs: 60_000,
  });
  const lease = await controller.acquire();
  await fixture.journal.startRun({
    ...fixture.scope,
    commandId: `terminal-start-${label}`,
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    expectedRunRevision: 1,
  });
  await controller.fail({
    commandId: `terminal-fail-${label}`,
    expectedRunRevision: 2,
    code: 'TEST_TERMINAL',
    detail: { source: 'wait acceptance' },
  });
  return fixture;
}

async function runTail(journal: SqliteAgentJournal, scope: RunScope): Promise<number> {
  const page = await journal.readRunEvents({
    ...scope, afterSequence: 0, limit: 1_000,
  });
  const sequence = page.events.at(-1)?.sequence;
  if (sequence === undefined) throw new Error('Expected at least one Run event.');
  return sequence;
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function viteNodePath(): string {
  return resolveViteNodeEntry();
}

function waitWriterPath(): string {
  return fileURLToPath(new URL('./fixtures/journal-wait-writer.ts', import.meta.url));
}

function waitForChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      rejectExit(new Error('Timed out waiting for Journal writer process.'));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

async function expectName(promise: Promise<unknown>, name: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ name });
}
