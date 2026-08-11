import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { JournalDrivenAgentKernel, type AgentKernelPort } from '../src/kernel/agent-kernel.js';
import { RunController, type KernelRunProjection } from '../src/kernel/run-controller.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const roots: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Agent Kernel process restart recovery', () => {
  it('discards an uncommitted Attempt after hard process exit and never exposes its Tool actions', async () => {
    const fixture = await preparedFixture();
    expect(await runWorker(fixture, 'before-commit')).toBe(73);
    const journal = new SqliteAgentJournal({ filePath: fixture.journalPath });
    expect(await journal.listInvocations(fixture.runId)).toEqual([]);
    expect(await journal.countEvents('tool.proposed')).toBe(0);
    const controller = controllerFor(journal, fixture.runId);
    await controller.acquire();
    const active = await journal.getKernelRunProjection(scope(fixture.runId));
    if (active === null) throw new Error('Missing Run');
    const discarded = await controller.discardModelAttempt({
      commandId: 'restart-discard', expectedRunRevision: active.revision,
      turnId: 'turn-crash', expectedTurnRevision: 1, attemptId: 'attempt-crash',
      reason: 'runtime-restarted', failure: { code: 'MODEL_ATTEMPT_INTERRUPTED', retryable: true },
    });
    const started = await controller.startModelAttempt({
      commandId: 'restart-attempt', expectedRunRevision: discarded.run.revision,
      turnId: 'turn-crash', expectedTurnRevision: 1, attemptId: 'attempt-retry',
      origin: { connectionId: 'connection-current', model: 'model-current', protocol: 'openai-responses' },
    });
    appendFileSync(fixture.counterPath, 'provider-call\n');
    const attempt = await validatedAttemptFixture('attempt-retry');
    await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-1', sessionId: 'session-1', runId: fixture.runId,
      turnId: 'turn-crash', commandId: 'restart-commit',
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: started.run.revision, expectedTurnRevision: 1, attempt,
    });
    expect(readFileSync(fixture.counterPath, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await journal.listInvocations(fixture.runId)).toHaveLength(2);
    expect(await journal.countEvents('model_attempt_discarded')).toBe(1);
  });

  it('reopens a committed Attempt in a second Kernel without another model call', async () => {
    const fixture = await preparedFixture();
    expect(await runWorker(fixture, 'after-commit')).toBe(74);
    const journal = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const committed = await journal.getKernelRunProjection(scope(fixture.runId));
    if (committed === null) throw new Error('Missing Run');
    expect(committed.state).toBe('ResolvingActions');
    expect(await journal.listInvocations(fixture.runId)).toHaveLength(2);
    const modelCall = vi.fn();
    const port = recoveryPort(committed, modelCall);
    const result = await new JournalDrivenAgentKernel({ port }).advance(fixture.runId);
    expect(result.state).toBe('AwaitingUser');
    expect(modelCall).not.toHaveBeenCalled();
    expect(readFileSync(fixture.counterPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

async function preparedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kernel-restart-'));
  roots.push(root);
  const journalPath = join(root, 'journal.db');
  const counterPath = join(root, 'provider-calls.txt');
  const journal = new SqliteAgentJournal({ filePath: journalPath });
  const ingress = await journal.createRun({
    projectId: 'project-1', sessionId: 'session-1', clientRequestId: 'request-1', input: 'go',
  });
  const controller = controllerFor(journal, ingress.runId);
  await controller.acquire();
  await controller.prepareTurn({
    commandId: 'prepare', expectedRunRevision: 1, turnId: 'turn-crash',
    environment: {
      environmentBindingId: 'environment-1', settingsRevision: 'settings-r1',
      permissionPolicyRevision: 'permission-r1',
      modelRoute: {
        routeRevision: 'route-r1',
        primary: {
          connectionId: 'connection-current', modelId: 'model-current',
          protocol: 'openai-responses', codecRevision: 'openai-responses@1',
          maxInputTokens: 12_288, maxOutputTokens: 4_096, generation: {},
        }, fallbacks: [],
      },
    },
    snapshot: {
      turnSnapshotId: 'snapshot-crash', capability: { snapshotId: 'cap-1', revision: 'r1' },
      promptRevision: 'prompt-r1', tools: [{ name: 'query_database', revision: 'r1' }],
      skills: [], verifiers: [],
    },
  });
  return { journalPath, counterPath, runId: ingress.runId };
}

function controllerFor(journal: SqliteAgentJournal, runId: string) {
  return new RunController({
    journal, projectId: 'project-1', sessionId: 'session-1', runId,
    ownerId: 'owner-1', leaseTtlMs: 60_000,
  });
}

function scope(runId: string) {
  return { projectId: 'project-1', sessionId: 'session-1', runId };
}

function runWorker(
  fixture: Awaited<ReturnType<typeof preparedFixture>>,
  mode: 'before-commit' | 'after-commit',
): Promise<number | null> {
  const viteNode = join(
    repositoryRoot, 'node_modules', '.pnpm', 'vite-node@2.1.9_@types+node@22.19.20',
    'node_modules', 'vite-node', 'vite-node.mjs',
  );
  const worker = join(packageRoot, 'test', 'fixtures', 'model-attempt-crash-worker.ts');
  const child = spawn(process.execPath, [viteNode, worker], {
    cwd: repositoryRoot, stdio: 'ignore', env: {
      ...process.env,
      DBAGENT_MODEL_CRASH_INPUT: JSON.stringify({ ...fixture, mode }),
    },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

function recoveryPort(
  initial: KernelRunProjection,
  modelCall: ReturnType<typeof vi.fn>,
): AgentKernelPort {
  let current = initial;
  const unexpected = async () => { throw new Error('unexpected recovery branch'); };
  return {
    async read() { return current; }, async start() { return current; },
    prepare: unexpected, async callModel() { modelCall(); return unexpected(); },
    async runTools() {
      current = { ...current, state: 'AwaitingUser', waitReason: 'approval', revision: current.revision + 1 };
      return {
        run: current,
        signal: {
          type: 'schedule-decided' as const,
          decision: { state: 'AwaitingUser' as const, reason: 'approval' as const, invocationIds: [] },
        },
      };
    },
    finalize: unexpected, settleCancellation: unexpected,
    steer: unexpected, approve: unexpected, cancel: unexpected, resume: unexpected,
    requestManualCompaction: unexpected, recordNoProgress: unexpected,
    async listPending() { return []; }, async checkLimits() { return null; },
  };
}
