import { executionPermissionAudit, permissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { createRuntimeCommandIssuer } from '../src/internal/runtime-command-authority.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import type {
  RuntimeCommand,
  RuntimeCommandApplicationResult,
  RuntimeCommandProjection,
  RuntimeSkillActivation,
  RuntimeToolActivation,
} from '../src/kernel/runtime-command.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const MAX_RUNTIME_RECEIPT_BYTES = 16 * 1024;
const MAX_RUNTIME_PROJECTION_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_CHILDREN = 256;

const temporaryDirectories: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('Runtime Command durable concurrency, receipts and projection bounds', () => {
  it('lets only one non-commuting child mutation win from a shared revision and replays that outcome', async () => {
    const fixture = await startedInvocationFixture('child-cas');
    const secondOrigin = await startSecondInvocation(fixture, 'child-cas');
    const application = await runtimeCommandApplication(fixture.journal);

    const childStarted = await application.apply(fixture.issue({
      commandId: 'child-cas-start',
      kind: 'child.start',
      expectedRunRevision: await currentRunRevision(fixture.journal, fixture.scope),
      payload: { task: 'Inspect one partition', context: { partition: '2026-08-11' } },
    }));
    const child = childStarted.projection.children[0];
    if (child === undefined) throw new Error('Expected a started child Run.');
    const sharedRevision = childStarted.run.revision;
    const steer = fixture.issue({
      commandId: 'child-cas-steer',
      kind: 'child.steer',
      expectedRunRevision: sharedRevision,
      payload: {
        childRunId: child.childRunId,
        expectedChildRevision: child.revision,
        input: { focus: 'late arrivals' },
      },
    });
    const cancel = fixture.issue({
      commandId: 'child-cas-cancel',
      kind: 'child.cancel',
      origin: secondOrigin,
      expectedRunRevision: sharedRevision,
      payload: {
        childRunId: child.childRunId,
        expectedChildRevision: child.revision,
        reason: 'parent changed direction',
      },
    });

    const settled = await Promise.allSettled([
      application.apply(steer),
      application.apply(cancel),
    ]);
    const fulfilled = settled.filter(
      (outcome): outcome is PromiseFulfilledResult<RuntimeCommandApplicationResult> =>
        outcome.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled, 'non-commuting child mutations must have exactly one winner').toHaveLength(1);
    expect(rejected, 'the stale child mutation must be rejected').toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'REVISION_CONFLICT' });

    const winningCommand = settled[0]?.status === 'fulfilled' ? steer : cancel;
    const losingCommand = winningCommand === steer ? cancel : steer;
    const winningResult = fulfilled[0]?.value;
    if (winningResult === undefined) throw new Error('Expected one Runtime Command winner.');
    const online = await runtimeCommandProjection(fixture.journal, fixture.scope);
    expect(online).toEqual(winningResult.projection);

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    const reopenedApplication = await runtimeCommandApplication(reopened);
    const replayedWinner = await reopenedApplication.apply(winningCommand);
    await expectCode(reopenedApplication.apply(losingCommand), 'REVISION_CONFLICT');
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(online);
    await reopened.rebuildProjectProjections(fixture.scope.projectId);
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(online);
    expect(replayedWinner).toEqual(winningResult);
  });

  it('rejects a structurally forged Runtime receipt instead of returning unverified JSON', async () => {
    const fixture = await startedInvocationFixture('receipt-shape');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'receipt-shape-command',
      kind: 'discovery.activate',
      payload: discoveryActivation('query_database'),
    });
    const committed = await application.apply(command);
    const online = await runtimeCommandProjection(fixture.journal, fixture.scope);
    tamperRuntimeReceipt(fixture.filePath, command.commandId, {
      schemaVersion: 1,
      commandId: command.commandId,
      eventIds: [42],
      runRevision: 'forged',
    });

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    await expectCode(
      (await runtimeCommandApplication(reopened)).apply(command),
      'PROJECTION_CORRUPT',
    );
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(online);
    expect(committed.projection).toEqual(online);
  });

  it('rejects an unknown durable Runtime receipt schema version', async () => {
    const fixture = await startedInvocationFixture('receipt-version');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'receipt-version-command',
      kind: 'skill.activate',
      payload: { activations: [skillActivation('inspect-schema')] },
    });
    await application.apply(command);
    const receipt = readRuntimeReceipt(fixture.filePath, command.commandId);
    tamperRuntimeReceipt(fixture.filePath, command.commandId, {
      ...receipt,
      schemaVersion: 999,
    });

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    await expectCode(
      (await runtimeCommandApplication(reopened)).apply(command),
      'UNSUPPORTED_EVENT_SCHEMA',
    );
  });

  it('rejects a same-Run receipt interval expanded with another command event', async () => {
    const fixture = await startedInvocationFixture('receipt-semantic-interval');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'receipt-semantic-command',
      kind: 'discovery.activate',
      payload: discoveryActivation('query_database'),
    });
    await application.apply(command);
    const receipt = readRuntimeReceipt(fixture.filePath, command.commandId);
    const firstSequence = Number(receipt.firstSequence);
    const eventCount = Number(receipt.eventCount);
    tamperRuntimeReceipt(fixture.filePath, command.commandId, {
      ...receipt,
      firstSequence: firstSequence - 1,
      eventCount: eventCount + 1,
    });

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    await expectCode(
      (await runtimeCommandApplication(reopened)).apply(command),
      'PROJECTION_CORRUPT',
    );
  });

  it('keeps receipts small and rejects an oversized Runtime projection atomically', async () => {
    const fixture = await startedInvocationFixture('projection-bytes');
    const application = await runtimeCommandApplication(fixture.journal);
    let revision = fixture.runRevision;

    let result = await application.apply(fixture.issue({
      commandId: 'large-plan-create',
      kind: 'plan.create',
      expectedRunRevision: revision,
      payload: { planId: 'large-plan', plan: { body: 'p'.repeat(230 * 1024) } },
    }));
    revision = result.run.revision;
    result = await application.apply(fixture.issue({
      commandId: 'large-plan-update-1',
      kind: 'plan.update',
      expectedRunRevision: revision,
      payload: {
        planId: 'large-plan', expectedPlanRevision: 1,
        plan: { body: 'q'.repeat(230 * 1024) },
      },
    }));
    revision = result.run.revision;
    result = await application.apply(fixture.issue({
      commandId: 'large-plan-update-2',
      kind: 'plan.update',
      expectedRunRevision: revision,
      payload: {
        planId: 'large-plan', expectedPlanRevision: 2,
        plan: { body: 'r'.repeat(230 * 1024) },
      },
    }));
    revision = result.run.revision;
    for (let index = 0; index < 16; index += 1) {
      result = await application.apply(fixture.issue({
        commandId: `large-child-start-${String(index).padStart(2, '0')}`,
        kind: 'child.start',
        expectedRunRevision: revision,
        payload: {
          task: `Inspect bounded shard ${index}`,
          context: { body: 'c'.repeat(230 * 1024) },
        },
      }));
      revision = result.run.revision;
    }

    const receipts = readRuntimeReceipts(fixture.filePath);
    expect(receipts).toHaveLength(19);
    for (const receipt of receipts) {
      expect(receipt.bytes).toBeLessThanOrEqual(MAX_RUNTIME_RECEIPT_BYTES);
      expect(receipt.value).toMatchObject({ schemaVersion: 1 });
      expect(receipt.value).not.toHaveProperty('run');
      expect(receipt.value).not.toHaveProperty('projection');
    }

    const beforeProjection = await runtimeCommandProjection(fixture.journal, fixture.scope);
    expect(utf8Bytes(beforeProjection)).toBeLessThanOrEqual(MAX_RUNTIME_PROJECTION_BYTES);
    const beforeEvents = await countRuntimeAppliedEvents(fixture.journal, fixture.scope.projectId);
    const beforeCommands = countRuntimeCommands(fixture.filePath);
    const overflow = fixture.issue({
      commandId: 'projection-bytes-overflow',
      kind: 'child.start',
      expectedRunRevision: revision,
      payload: {
        task: 'This child would exceed the projection',
        context: { body: 'x'.repeat(230 * 1024) },
      },
    });

    const overflowError = await captureError(application.apply(overflow));
    expect(await currentRunRevision(fixture.journal, fixture.scope)).toBe(revision);
    expect(await runtimeCommandProjection(fixture.journal, fixture.scope)).toEqual(beforeProjection);
    expect(await countRuntimeAppliedEvents(fixture.journal, fixture.scope.projectId)).toBe(beforeEvents);
    expect(countRuntimeCommands(fixture.filePath)).toBe(beforeCommands);

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(beforeProjection);
    await reopened.rebuildProjectProjections(fixture.scope.projectId);
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(beforeProjection);
    expect(overflowError).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('enforces the explicit child-count boundary before committing the overflow child', async () => {
    const fixture = await startedInvocationFixture('projection-count', 5 * 60_000);
    const application = await runtimeCommandApplication(fixture.journal);
    let revision = fixture.runRevision;
    for (let index = 0; index < MAX_RUNTIME_CHILDREN; index += 1) {
      const result = await application.apply(fixture.issue({
        commandId: `bounded-child-${String(index).padStart(2, '0')}`,
        kind: 'child.start',
        expectedRunRevision: revision,
        payload: { task: `Inspect shard ${index}`, context: { shard: index } },
      }));
      revision = result.run.revision;
    }
    const beforeProjection = await runtimeCommandProjection(fixture.journal, fixture.scope);
    expect(beforeProjection.children).toHaveLength(MAX_RUNTIME_CHILDREN);
    const beforeEvents = await countRuntimeAppliedEvents(fixture.journal, fixture.scope.projectId);
    const beforeCommands = countRuntimeCommands(fixture.filePath);

    const overflowError = await captureError(application.apply(fixture.issue({
      commandId: 'bounded-child-overflow',
      kind: 'child.start',
      expectedRunRevision: revision,
      payload: { task: 'Must not be committed', context: { shard: 'overflow' } },
    })));
    expect(await currentRunRevision(fixture.journal, fixture.scope)).toBe(revision);
    expect(await runtimeCommandProjection(fixture.journal, fixture.scope)).toEqual(beforeProjection);
    expect(await countRuntimeAppliedEvents(fixture.journal, fixture.scope.projectId)).toBe(beforeEvents);
    expect(countRuntimeCommands(fixture.filePath)).toBe(beforeCommands);

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    await reopened.rebuildProjectProjections(fixture.scope.projectId);
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(beforeProjection);
    expect(overflowError).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

type RuntimeCommandApplication = Readonly<{
  apply(command: RuntimeCommand): Promise<RuntimeCommandApplicationResult>;
}>;

type RuntimeCommandScope = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
}>;

type RuntimeCommandValue =
  | null | boolean | number | string
  | readonly RuntimeCommandValue[]
  | { readonly [key: string]: RuntimeCommandValue };

type IssueOverride =
  | Readonly<{ commandId: string; kind: 'plan.create'; payload: { planId: string; plan: RuntimeCommandValue } }>
  | Readonly<{
      commandId: string;
      kind: 'plan.update';
      payload: { planId: string; expectedPlanRevision: number; plan: RuntimeCommandValue };
    }>
  | Readonly<{
      commandId: string;
      kind: 'discovery.activate';
      payload: { tools: RuntimeToolActivation[]; targets: []; bindings: [] };
    }>
  | Readonly<{
      commandId: string;
      kind: 'skill.activate';
      payload: { activations: RuntimeSkillActivation[] };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.start';
      payload: { task: string; context: RuntimeCommandValue };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.steer';
      payload: {
        childRunId: string;
        expectedChildRevision: number;
        input: RuntimeCommandValue;
      };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.cancel';
      payload: { childRunId: string; expectedChildRevision: number; reason?: string };
    }>;

function skillActivation(id: string): RuntimeSkillActivation {
  return {
    id,
    revision: {
      schemaVersion: 1,
      revisionId: `${id}@1`,
      scope: 'project',
      sourceId: `${id}-source`,
      sourcePath: `C:/project/.schemanaut/skills/${id}`,
      bundleRoot: 'C:/project/.schemanaut/skills',
      sourceOrder: 0,
      name: id,
      contentDigest: `${id}-content`,
      bundleDigest: `${id}-bundle`,
    },
  };
}

function discoveryActivation(name: string): {
  tools: RuntimeToolActivation[];
  targets: [];
  bindings: [];
} {
  return {
    tools: [{ name, toolRevision: `${name}@1`, handlerRevision: `${name}-handler@1` }],
    targets: [],
    bindings: [],
  };
}

async function runtimeCommandApplication(
  journal: SqliteAgentJournal,
): Promise<RuntimeCommandApplication> {
  const module: object = await import('../src/internal/runtime-command-authority.js');
  const open = Reflect.get(module, 'openRuntimeCommandApplication') as unknown;
  if (typeof open !== 'function') {
    throw new Error('Runtime Command application authority is unavailable.');
  }
  return Reflect.apply(open, undefined, [journal]) as RuntimeCommandApplication;
}

async function startedInvocationFixture(label: string, leaseTtlMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), `runtime-command-durability-${label}-`));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'journal.db');
  const journal = new SqliteAgentJournal({ filePath });
  const scopeSeed = { projectId: `project-${label}`, sessionId: `session-${label}` };
  const ingress = await journal.createRun({
    ...scopeSeed,
    clientRequestId: `request-${label}`,
    input: `exercise Runtime durability ${label}`,
  });
  const scope = { ...scopeSeed, runId: ingress.runId };
  const ownerId = `owner-${label}`;
  const lease = await journal.acquireRunLease({
    projectId: scope.projectId, runId: scope.runId, ownerId, ttlMs: leaseTtlMs,
  });
  const leaseReference = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  const turnId = `turn-${label}`;
  await journal.startRun({
    ...scope, commandId: `start-${label}`, lease: leaseReference, expectedRunRevision: 1,
  });
  await journal.startTurn({
    ...scope, turnId, commandId: `turn-start-${label}`,
    lease: leaseReference, expectedRunRevision: 2,
  });
  const attempt = await validatedAttemptFixture(`runtime-durability-${label}`);
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    ...scope,
    turnId,
    commandId: `attempt-commit-${label}`,
    lease: leaseReference,
    expectedRunRevision: 3,
    expectedTurnRevision: 1,
    billingMode: 'byok',
    attempt,
  });
  const first = committed.invocations[0];
  const proposed = committed.invocations[1];
  if (first === undefined || proposed === undefined) {
    throw new Error('Expected two proposed Invocations from the real validated-attempt fixture.');
  }
  const lifecycle = openToolLifecycleCommitter(journal);
  let runRevision = await currentRunRevision(journal, scope);
  const preparedTool = preparedToolIntent({
    actionSummary: 'Read the first exact test value.',
  });
  const prepared = await lifecycle.commit({
    action: 'prepare',
    ...scope,
    turnId,
    invocationId: first.invocationId,
    commandId: `invocation-prepare-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: first.revision,
    canonicalToolId: { name: 'query_database' },
    catalogRevision: 'fixture-catalog@1',
    intent: preparedTool.intent,
    intentDigest: preparedTool.intentDigest,
    deadline: '2030-01-01T00:00:00.000Z',
  });
  runRevision = await currentRunRevision(journal, scope);
  const validated = await lifecycle.commit({
    action: 'validate',
    ...scope,
    turnId,
    invocationId: first.invocationId,
    commandId: `invocation-validate-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: prepared.invocation.revision,
    canonicalToolId: { name: 'query_database' },
    toolRevision: 'query_database@1',
    recoveryClass: 'read',
    intentDigest: preparedTool.intentDigest,
    authorization: 'allow', permissionAudit: permissionAudit('allow'),
    actionSummary: 'Read the first exact test value.',
    approvalSummary: 'Allow the first exact test read.',
  });
  runRevision = await currentRunRevision(journal, scope);
  await lifecycle.commit({
    action: 'start',
    ...scope,
    turnId,
    invocationId: first.invocationId,
    commandId: `invocation-start-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: validated.invocation.revision,
    idempotencyKey: `effect-${label}`,
    attempt: 1,
    permissionAudit: executionPermissionAudit(),
    intentDigest: preparedTool.intentDigest,
  });
  runRevision = await currentRunRevision(journal, scope);
  const origin = { runId: scope.runId, turnId, invocationId: first.invocationId };
  const issuer = createRuntimeCommandIssuer();
  return {
    journal,
    filePath,
    scope,
    origin,
    runRevision,
    turnId,
    leaseReference,
    lifecycle,
    proposedInvocation: proposed,
    fencingToken: lease.fencingToken,
    issue(overrides: IssueOverride & Partial<Pick<
      RuntimeCommand,
      'origin' | 'expectedRunRevision' | 'fencingToken'
    >>): RuntimeCommand {
      return issuer.issue({
        schemaVersion: 2,
        origin,
        expectedRunRevision: runRevision,
        fencingToken: lease.fencingToken,
        ...overrides,
      } as RuntimeCommand);
    },
  };
}

async function startSecondInvocation(
  fixture: Awaited<ReturnType<typeof startedInvocationFixture>>,
  label: string,
) {
  const proposed = fixture.proposedInvocation;
  let runRevision = await currentRunRevision(fixture.journal, fixture.scope);
  const preparedTool = preparedToolIntent({
    toolName: 'read_result',
    actionSummary: 'Read the second exact test value.',
  });
  const prepared = await fixture.lifecycle.commit({
    action: 'prepare',
    ...fixture.scope,
    turnId: fixture.turnId,
    invocationId: proposed.invocationId,
    commandId: `second-invocation-prepare-${label}`,
    lease: fixture.leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: proposed.revision,
    canonicalToolId: { name: 'read_result' },
    catalogRevision: 'fixture-catalog@1',
    intent: preparedTool.intent,
    intentDigest: preparedTool.intentDigest,
    deadline: '2030-01-01T00:00:00.000Z',
  });
  runRevision = await currentRunRevision(fixture.journal, fixture.scope);
  const validated = await fixture.lifecycle.commit({
    action: 'validate',
    ...fixture.scope,
    turnId: fixture.turnId,
    invocationId: proposed.invocationId,
    commandId: `second-invocation-validate-${label}`,
    lease: fixture.leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: prepared.invocation.revision,
    canonicalToolId: { name: 'read_result' },
    toolRevision: 'read_result@1',
    recoveryClass: 'read',
    intentDigest: preparedTool.intentDigest,
    authorization: 'allow', permissionAudit: permissionAudit('allow', 'read', 'read_result'),
    actionSummary: 'Read the second exact test value.',
    approvalSummary: 'Allow the second exact test read.',
  });
  runRevision = await currentRunRevision(fixture.journal, fixture.scope);
  await fixture.lifecycle.commit({
    action: 'start',
    ...fixture.scope,
    turnId: fixture.turnId,
    invocationId: proposed.invocationId,
    commandId: `second-invocation-start-${label}`,
    lease: fixture.leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: validated.invocation.revision,
    idempotencyKey: `second-effect-${label}`,
    attempt: 1,
    permissionAudit: executionPermissionAudit('read', 'read_result'),
    intentDigest: preparedTool.intentDigest,
  });
  return {
    ...fixture.origin,
    invocationId: proposed.invocationId,
  };
}

async function runtimeCommandProjection(
  journal: SqliteAgentJournal,
  scope: RuntimeCommandScope,
): Promise<RuntimeCommandProjection> {
  const projection = await journal.getRuntimeCommandProjection(scope);
  if (projection === null) throw new Error('Expected a durable Runtime Command projection.');
  return projection;
}

async function currentRunRevision(
  journal: SqliteAgentJournal,
  scope: RuntimeCommandScope,
): Promise<number> {
  const projection = await journal.getKernelRunProjection(scope);
  if (projection === null) throw new Error('Expected a Kernel Run projection.');
  return projection.revision;
}

async function countRuntimeAppliedEvents(
  journal: SqliteAgentJournal,
  projectId: string,
): Promise<number> {
  return (await journal.readProject(projectId, 0, 10_000))
    .filter(({ type }) => type === 'runtime.command_applied').length;
}

function readRuntimeReceipt(filePath: string, commandId: string): Record<string, unknown> {
  const database = new DatabaseSync(filePath);
  try {
    const row = database.prepare(
      `SELECT result_json FROM agent_commands
       WHERE command_id = ? AND command_kind LIKE 'runtime.%'`,
    ).get(commandId) as { result_json: string } | undefined;
    if (row === undefined) throw new Error(`Expected Runtime receipt ${commandId}.`);
    const value: unknown = JSON.parse(row.result_json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected Runtime receipt ${commandId} to be an object.`);
    }
    return value as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function readRuntimeReceipts(
  filePath: string,
): readonly Readonly<{ value: Record<string, unknown>; bytes: number }>[] {
  const database = new DatabaseSync(filePath);
  try {
    const rows = database.prepare(
      `SELECT result_json FROM agent_commands
       WHERE command_kind LIKE 'runtime.%' ORDER BY committed_at, command_id`,
    ).all() as { result_json: string }[];
    return rows.map(({ result_json }) => ({
      value: JSON.parse(result_json) as Record<string, unknown>,
      bytes: Buffer.byteLength(result_json, 'utf8'),
    }));
  } finally {
    database.close();
  }
}

function tamperRuntimeReceipt(
  filePath: string,
  commandId: string,
  receipt: Record<string, unknown>,
): void {
  const database = new DatabaseSync(filePath);
  try {
    const result = database.prepare(
      `UPDATE agent_commands SET result_json = ?
       WHERE command_id = ? AND command_kind LIKE 'runtime.%'`,
    ).run(JSON.stringify(receipt), commandId);
    expect(Number(result.changes)).toBe(1);
  } finally {
    database.close();
  }
}

function countRuntimeCommands(filePath: string): number {
  const database = new DatabaseSync(filePath);
  try {
    const row = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_commands WHERE command_kind LIKE 'runtime.%'`,
    ).get() as { count: number | bigint };
    return Number(row.count);
  } finally {
    database.close();
  }
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const caught = await captureError(promise);
  expect(caught).toMatchObject({ code });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject.');
}
