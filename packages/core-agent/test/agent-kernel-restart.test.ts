import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ModelExecutionGateway,
  createModelSessionBundle,
  describeModelSessionBundle,
  type ModelSession,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import { RunController } from '../src/kernel/run-controller.js';
import { PermissionManager } from '../src/permission-manager.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { createTestModelSession } from './model-session-fixture.js';
import { resolveViteNodeEntry } from './fixtures/vite-node-entry.js';

const roots: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Agent Kernel process restart recovery', () => {
  it('recovers an uncommitted Attempt through the production factory', async () => {
    const fixture = await preparedFixture();
    const exited = await runWorker(fixture, 'before-commit');
    expect(exited.code, exited.output).toBe(73);
    const journal = new SqliteAgentJournal({
      filePath: fixture.journalPath,
      now: () => fixture.recoveryNow,
    });
    expect(await journal.listInvocations(fixture.runId)).toEqual([]);
    expect(await journal.countEvents('tool.proposed')).toBe(0);
    const kernel = productionKernel(journal, fixture.session, 'recovery-one');

    await expect(kernel.advance(fixture.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(readFileSync(fixture.counterPath, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await journal.listInvocations(fixture.runId)).toHaveLength(0);
    expect(await journal.countEvents('model_attempt_committed')).toBe(1);
    expect(await journal.countEvents('model_attempt_discarded')).toBe(1);
  }, 15_000);

  it('reopens a committed Attempt through the production factory without another model call', async () => {
    const fixture = await preparedFixture();
    const exited = await runWorker(fixture, 'after-commit');
    expect(exited.code, exited.output).toBe(74);
    const journal = new SqliteAgentJournal({
      filePath: fixture.journalPath,
      now: () => fixture.recoveryNow,
    });
    const committed = await journal.getKernelRunProjection(scope(fixture.runId));
    if (committed === null) throw new Error('Missing Run');
    expect(committed.state).toBe('Finalizing');
    expect(await journal.listInvocations(fixture.runId)).toHaveLength(0);
    const kernel = productionKernel(journal, fixture.session, 'recovery-two');

    await expect(kernel.advance(fixture.runId)).resolves.toMatchObject({ state: 'Completed' });
    expect(readFileSync(fixture.counterPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(await journal.countEvents('model_attempt_committed')).toBe(1);
  }, 15_000);
});

async function preparedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kernel-restart-'));
  roots.push(root);
  const journalPath = join(root, 'journal.db');
  const counterPath = join(root, 'provider-calls.txt');
  const crashNow = '2030-01-01T00:00:00.000Z';
  const leaseTtlMs = 250;
  const recoveryNow = new Date(Date.parse(crashNow) + leaseTtlMs + 1).toISOString();
  const journal = new SqliteAgentJournal({ filePath: journalPath, now: () => crashNow });
  const ingress = await journal.createRun({
    projectId: 'project-1', sessionId: 'session-1', clientRequestId: 'request-1', input: 'go',
  });
  const controller = controllerFor(journal, ingress.runId);
  await controller.acquire();
  const session = await createTestModelSession({
    connectionId: 'connection-1', modelId: 'model-1', outputText: 'Recovered.',
    onExecute: () => { appendFileSync(counterPath, 'provider-call\n'); },
  });
  const captured = await controller.captureTurn({
    commandId: 'prepare', expectedRunRevision: 1, turnId: 'turn-crash',
    environment: {
      environmentBindingId: 'environment-1', settingsRevision: 'settings-r1',
      permissionPolicyRevision: 'permission-r1',
      modelSession: describeModelSessionBundle(createModelSessionBundle({ primary: session })),
    },
    snapshot: {
      turnSnapshotId: 'snapshot-crash', capability: { snapshotId: 'cap-1', revision: 'r1' },
      promptRevision: 'prompt-r1', tools: [],
      skills: [], verifiers: [],
    },
  });
  const ready = await controller.commitContextReady({
    commandId: 'context-ready', expectedRunRevision: captured.run.revision,
    turnId: 'turn-crash', expectedTurnRevision: 1,
  });
  await controller.release();
  return {
    journalPath, counterPath, runId: ingress.runId, session, leaseTtlMs, crashNow, recoveryNow,
    expectedRunRevision: ready.run.revision,
  };
}

function controllerFor(journal: SqliteAgentJournal, runId: string) {
  return new RunController({
    journal, projectId: 'project-1', sessionId: 'session-1', runId,
    // Fixture preparation is not the crash boundary under test. Keep this lease
    // above parallel-runner scheduling stalls; the spawned crash worker still
    // uses the short lease returned by preparedFixture().
    ownerId: 'fixture-owner', leaseTtlMs: 5_000,
  });
}

function scope(runId: string) {
  return { projectId: 'project-1', sessionId: 'session-1', runId };
}

function runWorker(
  fixture: Awaited<ReturnType<typeof preparedFixture>>,
  mode: 'before-commit' | 'after-commit',
): Promise<Readonly<{ code: number | null; output: string }>> {
  const viteNode = resolveViteNodeEntry();
  const worker = join(packageRoot, 'test', 'fixtures', 'model-attempt-crash-worker.ts');
  const child = spawn(process.execPath, [viteNode, worker], {
    cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      DBAGENT_MODEL_CRASH_INPUT: JSON.stringify({
        journalPath: fixture.journalPath,
        counterPath: fixture.counterPath,
        runId: fixture.runId,
        expectedRunRevision: fixture.expectedRunRevision,
        leaseTtlMs: fixture.leaseTtlMs,
        now: fixture.crashNow,
        mode,
      }),
    },
  });
  const output: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => output.push(chunk));
  child.stderr.on('data', (chunk: string) => output.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output: output.join('') }));
  });
}

function productionKernel(
  journal: SqliteAgentJournal,
  session: ModelSession,
  ownerId: string,
) {
  return createJournalAgentKernel({
    journal,
    gateway: new ModelExecutionGateway(),
    resolveModelSession: () => session,
    resolveUsageBillingMode: () => 'byok',
    toolCatalog: new ToolRegistry().captureSnapshot(),
    permissionManager: new PermissionManager(),
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 4,
      content: [{ type: 'text', text: 'Complete the current task.' }],
    },
    capability: { snapshotId: 'cap-1', revision: 'r1' },
    promptRevision: 'prompt-r1', settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1', ownerId, leaseTtlMs: 2_000,
  });
}
