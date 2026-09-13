import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { resolveViteNodeEntry } from './fixtures/vite-node-entry.js';

type CrashMode =
  | 'model-returned-before-commit'
  | 'attempt-committed-before-tool'
  | 'tool-started-before-terminal'
  | 'tool-terminal-before-observe'
  | 'context-started-before-result'
  | 'context-completed-before-next-step';

type Scenario = Readonly<{
  mode: CrashMode;
  barrier: string;
  terminalState: 'Completed' | 'AwaitingUser';
  waitReason?: 'outcome_resolution';
  counters: Readonly<Record<string, number>>;
  committedAttempts: number;
  usageFacts: number;
}>;

const scenarios: readonly Scenario[] = [
  {
    mode: 'model-returned-before-commit',
    barrier: 'model-returned-before-commit',
    terminalState: 'Completed',
    counters: { 'agent-model': 2, 'context-model': 0, 'tool-effect': 0 },
    committedAttempts: 1,
    // Both provider Attempts returned usage before the first process died / recovery committed.
    usageFacts: 2,
  },
  {
    mode: 'attempt-committed-before-tool',
    barrier: 'attempt-committed-before-tool',
    terminalState: 'Completed',
    counters: { 'agent-model': 2, 'context-model': 0, 'tool-effect': 1 },
    committedAttempts: 2,
    usageFacts: 2,
  },
  {
    mode: 'tool-started-before-terminal',
    barrier: 'tool-started-before-terminal',
    terminalState: 'AwaitingUser',
    waitReason: 'outcome_resolution',
    counters: { 'agent-model': 1, 'context-model': 0, 'tool-effect': 1 },
    committedAttempts: 1,
    usageFacts: 1,
  },
  {
    mode: 'tool-terminal-before-observe',
    barrier: 'tool-terminal-before-observe',
    terminalState: 'Completed',
    counters: { 'agent-model': 2, 'context-model': 0, 'tool-effect': 1 },
    committedAttempts: 2,
    usageFacts: 2,
  },
  {
    mode: 'context-started-before-result',
    barrier: 'context-started-before-result',
    terminalState: 'Completed',
    counters: { 'agent-model': 2, 'context-model': 2, 'tool-effect': 0 },
    committedAttempts: 2,
    usageFacts: 3,
  },
  {
    mode: 'context-completed-before-next-step',
    barrier: 'context-completed-before-next-step',
    terminalState: 'Completed',
    counters: { 'agent-model': 2, 'context-model': 1, 'tool-effect': 0 },
    committedAttempts: 2,
    usageFacts: 3,
  },
] as const;

const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
// These scenarios verify durable crash recovery, not heartbeat expiry. Keep the
// crashed owner's lease short, but give the replacement worker enough budget
// for loaded Windows runners and the projection-rebuild assertions below.
const RECOVERY_LEASE_TTL_MS = 5 * 60_000;
const RECOVERY_WORKER_TIMEOUT_MS = 2 * 60_000;
const CRASH_RECOVERY_TEST_TIMEOUT_MS = 3 * 60_000;

afterEach(async () => {
  await Promise.all([...liveChildren].map(async (child) => {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => undefined);
  }));
  liveChildren.clear();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('production Agent Kernel real process crash recovery', () => {
  it.each(scenarios)(
    'recovers $mode through the production factory without duplicate durable effects',
    async (scenario) => {
      const fixture = await scenarioFixture(scenario.mode);
      const crashing = startWorker({ ...fixture.worker, phase: 'crash' });
      await waitForFile(fixture.runPath, crashing, 15_000, 'Run identity', fixture.errorPath);
      await waitForFile(
        fixture.barrierPath, crashing, 15_000, scenario.barrier, fixture.errorPath,
      );
      expect((await readFile(fixture.barrierPath, 'utf8')).trim()).toBe(scenario.barrier);
      await assertCrashBoundary(fixture, scenario.mode);

      crashing.child.kill('SIGKILL');
      await waitForExit(crashing.child, 5_000);
      liveChildren.delete(crashing.child);
      await delay(fixture.worker.leaseTtlMs + 100);

      const recovering = startWorker({
        ...fixture.worker,
        phase: 'recover',
        leaseTtlMs: RECOVERY_LEASE_TTL_MS,
      });
      const recoveredExit = await waitForExit(recovering.child, RECOVERY_WORKER_TIMEOUT_MS);
      liveChildren.delete(recovering.child);
      if (recoveredExit.code !== 0) {
        throw new Error(
          `Recovery worker failed for ${scenario.mode}: ${recovering.output()}\n` +
          await optionalFile(fixture.errorPath),
        );
      }

      const result = await readJson<WorkerResult>(fixture.resultPath);
      expect(result.result, JSON.stringify(result, null, 2)).toMatchObject({
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        state: scenario.terminalState,
        ...(scenario.waitReason === undefined ? {} : { waitReason: scenario.waitReason }),
      });
      if (scenario.waitReason === undefined) expect(result.pending).toEqual([]);
      else expect(result.pending).toEqual([
        scenario.waitReason === 'outcome_resolution'
          ? expect.objectContaining({ kind: 'outcome-resolution' })
          : expect.objectContaining({ kind: 'input', reason: scenario.waitReason }),
      ]);

      const counters = await readCounters(fixture.counterPath);
      for (const [name, expected] of Object.entries(scenario.counters)) {
        expect(counters[name] ?? 0, `${scenario.mode}:${name}`).toBe(expected);
      }

      const journal = new SqliteAgentJournal({ filePath: fixture.journalPath });
      const run = await readJson<{ runId: string }>(fixture.runPath);
      const scope = {
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        runId: run.runId,
      };
      const events = await allRunEvents(journal, scope);
      expect(events.filter(({ type }) => type === 'model_attempt_committed'))
        .toHaveLength(scenario.committedAttempts);
      expect(events.filter(({ type }) => type === 'usage.recorded'))
        .toHaveLength(scenario.usageFacts);
      expect(result.usage).toMatchObject({
        inputTokens: scenario.usageFacts * 4,
        outputTokens: scenario.usageFacts * 2,
        totalTokens: scenario.usageFacts * 6,
      });
      if (scenario.terminalState === 'Completed') {
        expect(events.filter(({ type }) => type === 'run.completed')).toHaveLength(1);
      } else {
        expect(events.filter(({ type }) => type === 'run.completed')).toHaveLength(0);
        expect(events.filter(({ type }) => type === 'tool.unknown')).toHaveLength(1);
        expect(events.filter(({ type }) => type === 'run.input_requested')).toHaveLength(1);
      }
      if (isToolMode(scenario.mode)) {
        expect(events.filter(({ type }) => type === 'tool.started')).toHaveLength(1);
        expect(events.filter(({ type }) => type === 'tool.observed')).toHaveLength(1);
      }
      if (isContextMode(scenario.mode)) {
        expect(events.filter(({ type }) => type === 'context.compaction_started')).toHaveLength(1);
        expect(events.filter(({ type }) => type === 'context.compacted')).toHaveLength(1);
      }

      const online = await durableProjectionSnapshot(journal, scope);
      await journal.rebuildProjectProjections(scope.projectId);
      expect(await durableProjectionSnapshot(journal, scope)).toEqual(online);
    },
    CRASH_RECOVERY_TEST_TIMEOUT_MS,
  );
});

type WorkerResult = Readonly<{
  result: Readonly<{
    projectId: string;
    sessionId: string;
    runId: string;
    state: string;
    waitReason: string | null;
  }>;
  pending: readonly unknown[];
  usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
}>;

type ScenarioFixture = Awaited<ReturnType<typeof scenarioFixture>>;

async function scenarioFixture(mode: CrashMode) {
  const directory = await mkdtemp(join(tmpdir(), `agent-kernel-real-crash-${mode}-`));
  temporaryDirectories.push(directory);
  const projectId = `project-${mode}`;
  const sessionId = `session-${mode}`;
  const journalPath = join(directory, 'journal.db');
  const counterPath = join(directory, 'external-counters.log');
  const barrierPath = join(directory, 'crash-ready.txt');
  const runPath = join(directory, 'run.json');
  const resultPath = join(directory, 'result.json');
  const errorPath = join(directory, 'worker-error.json');
  // The crashed owner's lease stays short so takeover is observable without slowing every case.
  // Recovery uses its own production-like lease budget; renewal timing has separate acceptance.
  const leaseTtlMs = 2_000;
  return {
    mode,
    directory,
    projectId,
    sessionId,
    journalPath,
    counterPath,
    barrierPath,
    runPath,
    resultPath,
    errorPath,
    worker: {
      mode,
      journalPath,
      counterPath,
      barrierPath,
      runPath,
      resultPath,
      errorPath,
      modelCachePath: join(directory, 'model-cache'),
      projectId,
      sessionId,
      leaseTtlMs,
    },
  };
}

async function assertCrashBoundary(fixture: ScenarioFixture, mode: CrashMode): Promise<void> {
  const journal = new SqliteAgentJournal({ filePath: fixture.journalPath });
  const run = await readJson<{ runId: string }>(fixture.runPath);
  const events = await allRunEvents(journal, {
    projectId: fixture.projectId, sessionId: fixture.sessionId, runId: run.runId,
  });
  const count = (type: string) => events.filter((event) => event.type === type).length;
  switch (mode) {
    case 'model-returned-before-commit':
      expect(count('model_attempt_started')).toBe(1);
      expect(count('model_attempt_committed')).toBe(0);
      return;
    case 'attempt-committed-before-tool':
      expect(count('model_attempt_committed')).toBe(1);
      expect(count('tool.proposed')).toBe(1);
      expect(count('tool.started')).toBe(0);
      return;
    case 'tool-started-before-terminal':
      expect(count('tool.started')).toBe(1);
      expect(count('tool.succeeded') + count('tool.failed') + count('tool.unknown')).toBe(0);
      return;
    case 'tool-terminal-before-observe':
      expect(count('tool.succeeded')).toBe(1);
      expect(count('tool.observed')).toBe(0);
      return;
    case 'context-started-before-result':
      expect(count('context.compaction_started')).toBe(1);
      expect(count('context.compacted')).toBe(0);
      return;
    case 'context-completed-before-next-step':
      expect(count('context.compaction_started')).toBe(1);
      expect(count('context.compacted')).toBe(1);
      return;
  }
}

type WorkerInput = Readonly<{
  phase: 'crash' | 'recover';
  mode: CrashMode;
  journalPath: string;
  counterPath: string;
  barrierPath: string;
  runPath: string;
  resultPath: string;
  errorPath: string;
  modelCachePath: string;
  projectId: string;
  sessionId: string;
  leaseTtlMs: number;
}>;

type RunningWorker = Readonly<{
  child: ChildProcessWithoutNullStreams;
  output(): string;
}>;

function startWorker(input: WorkerInput): RunningWorker {
  const child = spawn(process.execPath, [viteNodePath(), workerPath()], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    env: {
      ...process.env,
      SCHEMANAUT_KERNEL_CRASH_INPUT: JSON.stringify(input),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  liveChildren.add(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  return { child, output: () => output };
}

function workerPath(): string {
  return fileURLToPath(new URL('./fixtures/kernel-crash-worker.ts', import.meta.url));
}

function viteNodePath(): string {
  return resolveViteNodeEntry();
}

async function waitForFile(
  path: string,
  worker: RunningWorker,
  timeoutMs: number,
  label: string,
  errorPath?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (worker.child.exitCode !== null) {
      throw new Error(
        `${label} worker exited early: ${worker.output()}\n` +
        (errorPath === undefined ? '' : await optionalFile(errorPath)),
      );
    }
    await delay(20);
  }
  worker.child.kill('SIGKILL');
  throw new Error(`Timed out waiting for ${label}: ${worker.output()}`);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for worker exit.'));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function allRunEvents(
  journal: SqliteAgentJournal,
  scope: Readonly<{ projectId: string; sessionId: string; runId: string }>,
) {
  const events = [];
  let afterSequence = 0;
  while (true) {
    const page = await journal.readRunEvents({ ...scope, afterSequence, limit: 1_000 });
    events.push(...page.events);
    if (page.events.length < 1_000 || page.nextSequence === null) return events;
    afterSequence = page.nextSequence;
  }
}

async function durableProjectionSnapshot(
  journal: SqliteAgentJournal,
  scope: Readonly<{ projectId: string; sessionId: string; runId: string }>,
) {
  const events = await allRunEvents(journal, scope);
  const turnIds = [...new Set(events.flatMap((event) => typeof event.turnId === 'string'
    ? [event.turnId] : []))];
  return {
    kernel: await journal.getKernelRunProjection(scope),
    run: await journal.getRunProjection(scope.runId),
    usage: await journal.getRunUsage(scope),
    invocations: await journal.listInvocations(scope.runId),
    turns: await Promise.all(turnIds.map(async (turnId) => await journal.getTurnLifecycle({
      ...scope, turnId,
    }))),
  };
}

async function readCounters(path: string): Promise<Record<string, number>> {
  if (!existsSync(path)) return {};
  const counters: Record<string, number> = {};
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/u)) {
    if (line === '') continue;
    counters[line] = (counters[line] ?? 0) + 1;
  }
  return counters;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function optionalFile(path: string): Promise<string> {
  return existsSync(path) ? await readFile(path, 'utf8') : '';
}

function isToolMode(mode: CrashMode): boolean {
  return mode === 'attempt-committed-before-tool' ||
    mode === 'tool-started-before-terminal' ||
    mode === 'tool-terminal-before-observe';
}

function isContextMode(mode: CrashMode): boolean {
  return mode === 'context-started-before-result' ||
    mode === 'context-completed-before-next-step';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
