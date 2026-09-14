import { executionPermissionAudit, permissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  ModelExecutionGateway,
  createModelSessionBundle,
  describeModelSessionBundle,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import {
  createRuntimeCommandIssuer,
} from '../src/internal/runtime-command-authority.js';
import {
  openSubagentOutcomeRecoveryCommitter,
} from '../src/internal/subagent-outcome-authority.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import { createJournalAgentKernel } from '../src/kernel/agent-kernel.js';
import type { JournalAgentModelResolver } from '../src/kernel/journal-agent-kernel-port.js';
import type {
  RuntimeCommand,
  RuntimeCommandApplicationResult,
  RuntimeCommandProjection,
  RuntimeSkillActivation,
  RuntimeToolActivation,
} from '../src/kernel/runtime-command.js';
import { RunController } from '../src/kernel/run-controller.js';
import { PermissionManager } from '../src/permission-manager.js';
import { BASE_TOOL_MANIFEST } from '../src/base-tool-manifest.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { PREPARED_TOOL_INTENT_REVISION } from '../src/tools/tool-protocol.js';
import { createTestModelSession } from './model-session-fixture.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];
const temporaryControllers: RunController[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(async () => {
  await Promise.all(temporaryControllers.splice(0).map(async (controller) => {
    await controller.release();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('sealed Runtime Command application', () => {
  it('checks the WeakMap admission token before reading or cloning an untrusted value', async () => {
    const fixture = await startedInvocationFixture('admission-order');
    const application = await runtimeCommandApplication(fixture.journal);
    let propertyReads = 0;
    const forged = new Proxy(Object.create(null) as object, {
      get: () => {
        propertyReads += 1;
        throw new Error('forged Runtime Command was inspected');
      },
      ownKeys: () => {
        propertyReads += 1;
        throw new Error('forged Runtime Command keys were inspected');
      },
      getOwnPropertyDescriptor: () => {
        propertyReads += 1;
        throw new Error('forged Runtime Command descriptor was inspected');
      },
    });

    await expectCode(
      Promise.resolve().then(async () => await application.apply(forged as RuntimeCommand)),
      'RUNTIME_COMMAND_UNAUTHENTIC',
    );
    expect(propertyReads).toBe(0);
  });

  it('rejects clones, wrong origin, stale fences/revisions and non-started Invocations', async () => {
    const fixture = await startedInvocationFixture('origin-binding');
    const application = await runtimeCommandApplication(fixture.journal);
    const exact = fixture.issue({
      commandId: 'plan-exact-origin',
      kind: 'plan.create',
      payload: { planId: 'plan-origin', plan: { goal: 'inspect exact bindings' } },
    });

    await expectCode(application.apply(structuredClone(exact)), 'RUNTIME_COMMAND_UNAUTHENTIC');
    await expectCode(application.apply(fixture.issue({
      commandId: 'wrong-run',
      kind: 'plan.create',
      origin: { ...fixture.origin, runId: 'run-from-another-scope' },
      payload: { planId: 'plan-wrong-run', plan: {} },
    })), 'COMMAND_CONFLICT');
    await expectCode(application.apply(fixture.issue({
      commandId: 'wrong-turn',
      kind: 'plan.create',
      origin: { ...fixture.origin, turnId: 'turn-from-another-scope' },
      payload: { planId: 'plan-wrong-turn', plan: {} },
    })), 'COMMAND_CONFLICT');
    await expectCode(application.apply(fixture.issue({
      commandId: 'missing-invocation',
      kind: 'plan.create',
      origin: { ...fixture.origin, invocationId: 'invocation-does-not-exist' },
      payload: { planId: 'plan-missing-invocation', plan: {} },
    })), 'INVOCATION_NOT_FOUND');
    await expectCode(application.apply(fixture.issue({
      commandId: 'non-started-invocation',
      kind: 'plan.create',
      origin: { ...fixture.origin, invocationId: fixture.proposedInvocationId },
      payload: { planId: 'plan-proposed-invocation', plan: {} },
    })), 'INVOCATION_STATE_CONFLICT');
    await expectCode(application.apply(fixture.issue({
      commandId: 'stale-fence',
      kind: 'plan.create',
      fencingToken: fixture.fencingToken + 1,
      payload: { planId: 'plan-stale-fence', plan: {} },
    })), 'FENCING_TOKEN_STALE');
    await expectCode(application.apply(fixture.issue({
      commandId: 'stale-run-revision',
      kind: 'plan.create',
      expectedRunRevision: fixture.runRevision - 1,
      payload: { planId: 'plan-stale-run', plan: {} },
    })), 'REVISION_CONFLICT');

    expect(await fixture.journal.countEvents('plan.created')).toBe(0);
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(0);
  });

  it('applies Plan create/update atomically, idempotently and with both Run and Plan CAS', async () => {
    const fixture = await startedInvocationFixture('plan-cas');
    const application = await runtimeCommandApplication(fixture.journal);
    const create = fixture.issue({
      commandId: 'plan-create',
      kind: 'plan.create',
      payload: {
        planId: 'plan-main',
        plan: { goal: 'inspect database', steps: [{ id: 'step-1', status: 'pending' }] },
      },
    });

    const first = await application.apply(create);
    expect(first.events.map(({ type }) => type)).toEqual(expect.arrayContaining([
      'plan.created', 'runtime.command_applied',
    ]));
    expect(first.run.revision).toBe(fixture.runRevision + 1);
    expect(first.projection.plan).toEqual({
      planId: 'plan-main',
      revision: 1,
      plan: { goal: 'inspect database', steps: [{ id: 'step-1', status: 'pending' }] },
    });
    expect(await application.apply(create)).toEqual(first);
    expect(await fixture.journal.countEvents('plan.created')).toBe(1);
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(1);

    await expectCode(application.apply(fixture.issue({
      commandId: create.commandId,
      kind: 'plan.create',
      expectedRunRevision: create.expectedRunRevision,
      payload: { planId: 'plan-main', plan: { goal: 'changed under the same command id' } },
    })), 'IDEMPOTENCY_CONFLICT');

    const afterCreate = await currentRunRevision(fixture.journal, fixture.scope);
    const update = fixture.issue({
      commandId: 'plan-update',
      kind: 'plan.update',
      expectedRunRevision: afterCreate,
      payload: {
        planId: 'plan-main',
        expectedPlanRevision: 1,
        plan: { goal: 'inspect database', steps: [{ id: 'step-1', status: 'completed' }] },
      },
    });
    const updated = await application.apply(update);
    expect(updated.projection.plan).toEqual({
      planId: 'plan-main',
      revision: 2,
      plan: { goal: 'inspect database', steps: [{ id: 'step-1', status: 'completed' }] },
    });

    const afterUpdate = await currentRunRevision(fixture.journal, fixture.scope);
    await expectCode(application.apply(fixture.issue({
      commandId: 'plan-update-stale-plan-cas',
      kind: 'plan.update',
      expectedRunRevision: afterUpdate,
      payload: {
        planId: 'plan-main', expectedPlanRevision: 1,
        plan: { goal: 'must not commit' },
      },
    })), 'REVISION_CONFLICT');
    expect(await fixture.journal.countEvents('plan.updated')).toBe(1);
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(2);
    expect((await runtimeCommandProjection(fixture.journal, fixture.scope)).plan)
      .toEqual(updated.projection.plan);
  });

  it('keeps the originating Tool lifecycle finishable and observable after applying a command', async () => {
    const fixture = await startedInvocationFixture('finish-after-apply');
    const application = await runtimeCommandApplication(fixture.journal);
    await application.apply(fixture.issue({
      commandId: 'plan-before-finish',
      kind: 'plan.create',
      payload: { planId: 'plan-before-finish', plan: { goal: 'finish cleanly' } },
    }));
    const started = await fixture.journal.getInvocation(fixture.origin.invocationId);
    if (started?.intentDigest === undefined) throw new Error('Expected the started Invocation intent.');
    let runRevision = await currentRunRevision(fixture.journal, fixture.scope);
    const finished = await fixture.lifecycle.commit({
      action: 'finish',
      ...fixture.scope,
      turnId: fixture.turnId,
      invocationId: fixture.origin.invocationId,
      commandId: 'finish-after-runtime-command',
      lease: fixture.leaseReference,
      expectedRunRevision: runRevision,
      expectedInvocationRevision: started.revision,
      outcome: 'succeeded',
      intentDigest: started.intentDigest,
      summary: 'Runtime command and Tool effect completed.',
      resultRefs: [],
    });
    runRevision = await currentRunRevision(fixture.journal, fixture.scope);
    const observed = await fixture.lifecycle.commit({
      action: 'observe',
      ...fixture.scope,
      turnId: fixture.turnId,
      invocationId: fixture.origin.invocationId,
      commandId: 'observe-after-runtime-command',
      lease: fixture.leaseReference,
      expectedRunRevision: runRevision,
      expectedInvocationRevision: finished.invocation.revision,
      observation: {
        observationId: 'observation-after-runtime-command',
        invocationId: fixture.origin.invocationId,
        summary: 'Runtime command and Tool effect completed.',
        evidenceRefs: [],
        outcome: 'succeeded',
      },
    });
    expect(observed.invocation.state).toBe('observed');
    expect((await runtimeCommandProjection(fixture.journal, fixture.scope)).plan)
      .toMatchObject({ planId: 'plan-before-finish' });
  });

  it('persists trusted capability targets through discovery.activate without activating Tools', async () => {
    const fixture = await startedInvocationFixture('capability-discovery');
    const application = await runtimeCommandApplication(fixture.journal);
    const result = await application.apply(fixture.issue({
      commandId: 'discover-database-capability',
      kind: 'discovery.activate',
      payload: { tools: [], targets: [{ moduleId: 'schemanaut.database', instanceId: 'primary' }], bindings: [] },
    }));

    expect(result.events.map(({ type }) => type)).toEqual([
      'capability.discovered', 'runtime.command_applied',
    ]);
    expect(result.projection).toMatchObject({
      discoveredCapabilities: [{ moduleId: 'schemanaut.database', instanceId: 'primary' }],
      activeTools: [],
    });
    expect(await runtimeCommandProjection(fixture.journal, fixture.scope)).toMatchObject({
      discoveredCapabilities: [{ moduleId: 'schemanaut.database', instanceId: 'primary' }],
    });
  });

  it('serializes commands from two concurrently started Invocations on the shared Turn window', async () => {
    const fixture = await startedInvocationFixture('parallel-applications');
    const proposed = fixture.proposedInvocation;
    let runRevision = await currentRunRevision(fixture.journal, fixture.scope);
    const preparedTool = preparedToolIntent({
      toolName: 'read_result',
      actionSummary: 'Read in parallel.',
    });
    const prepared = await fixture.lifecycle.commit({
      action: 'prepare',
      ...fixture.scope,
      turnId: fixture.turnId,
      invocationId: proposed.invocationId,
      commandId: 'prepare-second-parallel-invocation',
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
      commandId: 'validate-second-parallel-invocation',
      lease: fixture.leaseReference,
      expectedRunRevision: runRevision,
      expectedInvocationRevision: prepared.invocation.revision,
      canonicalToolId: { name: 'read_result' },
      toolRevision: 'read_result@1',
      recoveryClass: 'read',
      intentDigest: preparedTool.intentDigest,
      authorization: 'allow', permissionAudit: permissionAudit('allow', 'read', 'read_result'),
      actionSummary: 'Read in parallel.',
      approvalSummary: 'Allow the second parallel read.',
    });
    runRevision = await currentRunRevision(fixture.journal, fixture.scope);
    await fixture.lifecycle.commit({
      action: 'start',
      ...fixture.scope,
      turnId: fixture.turnId,
      invocationId: proposed.invocationId,
      commandId: 'start-second-parallel-invocation',
      lease: fixture.leaseReference,
      expectedRunRevision: runRevision,
      expectedInvocationRevision: validated.invocation.revision,
      idempotencyKey: 'effect-second-parallel',
      attempt: 1,
      permissionAudit: executionPermissionAudit('read', 'read_result'),
      intentDigest: preparedTool.intentDigest,
    });
    const sharedRevision = await currentRunRevision(fixture.journal, fixture.scope);
    const application = await runtimeCommandApplication(fixture.journal);
    await Promise.all([
      application.apply(fixture.issue({
        commandId: 'parallel-tool-activation',
        kind: 'discovery.activate',
        expectedRunRevision: sharedRevision,
        payload: discoveryActivation('query_database'),
      })),
      application.apply(fixture.issue({
        commandId: 'parallel-skill-activation',
        kind: 'skill.activate',
        origin: { ...fixture.origin, invocationId: proposed.invocationId },
        expectedRunRevision: sharedRevision,
        payload: { activations: [skillActivation('analysis-skill')] },
      })),
    ]);
    expect(await runtimeCommandProjection(fixture.journal, fixture.scope)).toMatchObject({
      revision: 2,
      activeTools: [toolActivation('query_database')],
      activeSkills: [skillActivation('analysis-skill')],
    });
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(2);
  });

  it('rejects a queued follow-up Runtime Command after cancellation supersedes execution', async () => {
    const fixture = await startedInvocationFixture('cancel-supersedes-runtime');
    const application = await runtimeCommandApplication(fixture.journal);
    const pending = fixture.issue({
      commandId: 'runtime-after-cancel',
      kind: 'discovery.activate',
      payload: discoveryActivation('query_database'),
    });
    const controller = new RunController({
      journal: fixture.journal,
      ...fixture.scope,
      ownerId: fixture.ownerId,
      leaseTtlMs: 60_000,
    });
    await controller.acquire();
    await controller.requestCancel({
      commandId: 'cancel-before-runtime-command',
      expectedRunRevision: fixture.runRevision,
      reason: 'User cancelled the task.',
    });
    await expectCode(application.apply(pending), 'COMMAND_CONFLICT');
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(0);
    await controller.release();
  });

  it.each(['limit', 'interrupt', 'steer-after-limit'] as const)(
    'rejects a compatible-window command after %s crosses the Tool execution upper bound',
    async (control) => {
      const fixture = await startedInvocationFixture(`upper-bound-${control}`);
      const application = await runtimeCommandApplication(fixture.journal);
      const pending = fixture.issue({
        commandId: `runtime-after-${control}`,
        kind: 'skill.activate',
        payload: { activations: [skillActivation('analysis-skill')] },
      });
      const controller = new RunController({
        journal: fixture.journal,
        ...fixture.scope,
        ownerId: fixture.ownerId,
        leaseTtlMs: 60_000,
      });
      await controller.acquire();
      const limited = control === 'interrupt'
        ? await controller.interrupt({
            commandId: 'interrupt-before-runtime-command',
            expectedRunRevision: fixture.runRevision,
            code: 'RUNTIME_TEST_INTERRUPTED',
          })
        : await controller.reachLimit({
            commandId: `limit-before-${control}`,
            expectedRunRevision: fixture.runRevision,
            limit: 'runtime-test-limit',
          });
      if (control === 'steer-after-limit') {
        await controller.steer({
          commandId: 'steer-after-runtime-limit',
          expectedRunRevision: limited.run.revision,
          clientRequestId: 'steer-runtime-upper-bound',
          value: 'Continue with a different task.',
        });
      }
      await expectCode(application.apply(pending), 'COMMAND_CONFLICT');
      expect(await countEventsByName(
        fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
      )).toBe(0);
      await controller.release();
    },
  );

  it.each(['limit', 'interrupt'] as const)(
    'rotates the Tool command epoch after %s resume without losing persisted work',
    async (control) => {
      const fixture = await startedInvocationFixture(`resume-epoch-${control}`);
      const application = await runtimeCommandApplication(fixture.journal);
      const stale = fixture.issue({
        commandId: `stale-runtime-after-${control}-resume`,
        kind: 'skill.activate',
        payload: { activations: [skillActivation('stale-skill')] },
      });
      const controller = new RunController({
        journal: fixture.journal,
        ...fixture.scope,
        ownerId: fixture.ownerId,
        leaseTtlMs: 60_000,
      });
      await controller.acquire();
      const suspended = control === 'limit'
        ? await controller.reachLimit({
            commandId: `epoch-limit-${control}`,
            expectedRunRevision: fixture.runRevision,
            limit: 'runtime-test-limit',
          })
        : await controller.interrupt({
            commandId: `epoch-interrupt-${control}`,
            expectedRunRevision: fixture.runRevision,
            code: 'RUNTIME_TEST_INTERRUPTED',
          });
      const resumed = await controller.resume({
        commandId: `epoch-resume-${control}`,
        expectedRunRevision: suspended.run.revision,
        reason: 'resume persisted Tool work',
      });
      await expectCode(application.apply(stale), 'REVISION_CONFLICT');
      const recovered = await application.apply(fixture.issue({
        commandId: `fresh-runtime-after-${control}-resume`,
        kind: 'skill.activate',
        expectedRunRevision: resumed.run.revision,
        payload: { activations: [skillActivation('recovered-skill')] },
      }));
      expect(resumed.run).toMatchObject({
        state: 'ExecutingTools',
      });
      expect(recovered.projection.activeSkills).toEqual([skillActivation('recovered-skill')]);
      expect(await fixture.journal.getInvocation(fixture.origin.invocationId)).toMatchObject({
        state: 'started',
        started: { idempotencyKey: `effect-resume-epoch-${control}` },
      });
      await controller.release();
      await fixture.journal.rebuildProjectProjections(fixture.scope.projectId);
      expect(await runtimeCommandProjection(fixture.journal, fixture.scope)).toMatchObject({
        activeSkills: [skillActivation('recovered-skill')],
      });
      expect(await fixture.journal.getKernelRunProjection(fixture.scope)).toMatchObject({
        state: 'ExecutingTools',
      });
    },
  );

  it('projects captured Tool/Skill activation and complete child intent facts', async () => {
    const fixture = await startedInvocationFixture('activation-child');
    const application = await runtimeCommandApplication(fixture.journal);

    let revision = fixture.runRevision;
    let result = await application.apply(fixture.issue({
      commandId: 'activate-tool', kind: 'discovery.activate', expectedRunRevision: revision,
      payload: discoveryActivation('query_database'),
    }));
    revision = result.run.revision;
    expect(result.projection.activeTools).toEqual([toolActivation('query_database')]);

    result = await application.apply(fixture.issue({
      commandId: 'activate-skill', kind: 'skill.activate', expectedRunRevision: revision,
      payload: { activations: [skillActivation('analysis-skill')] },
    }));
    revision = result.run.revision;
    expect(result.projection.activeSkills).toEqual([skillActivation('analysis-skill')]);

    const startCommand = fixture.issue({
      commandId: 'child-start', kind: 'child.start', expectedRunRevision: revision,
      payload: {
        task: 'Inspect the failed partitions',
        context: { dataset: 'events', partition: '2026-08-11' },
      },
    }) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    result = await application.apply(startCommand);
    revision = result.run.revision;
    const child = result.projection.children[0];
    if (child === undefined) throw new Error('Expected child.start to return a projected child.');
    expect(child.childRunId).toMatch(/^child_[a-f0-9]{32}$/u);
    expect(child.childSessionId).toMatch(/^child_session_[a-f0-9]{32}$/u);
    expect(child).toMatchObject({
      parentRunId: fixture.scope.runId,
      parentInvocationId: fixture.origin.invocationId,
      task: 'Inspect the failed partitions',
      context: { dataset: 'events', partition: '2026-08-11' },
    });
    const childIngress = await fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: { task: child.task, context: child.context },
      parent: fixture.origin,
    });
    expect(childIngress.runId).toBe(child.childRunId);
    expect(await fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: { task: child.task, context: child.context },
      parent: fixture.origin,
    })).toEqual(childIngress);
    expect(await fixture.journal.getSessionIndex(
      fixture.scope.projectId, child.childSessionId,
    )).toMatchObject({
      kind: 'delegated', visibility: 'internal',
      parentRunId: fixture.scope.runId, parentSessionId: fixture.scope.sessionId,
    });
    const childCreated = (await readAllProjectEvents(
      fixture.journal,
      fixture.scope.projectId,
    )).find((event) => event.runId === child.childRunId && event.type === 'run.created');
    expect(childCreated?.payload).toMatchObject({ parent: fixture.origin });

    const childController = new RunController({
      journal: fixture.journal,
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      ownerId: 'child-outcome-owner',
      leaseTtlMs: 60_000,
    });
    await childController.acquire();
    let childRun = await fixture.journal.getKernelRunProjection({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
    });
    if (childRun === null) throw new Error('Expected child Kernel Run.');
    childRun = (await childController.requestCancel({
      commandId: 'cancel-child-run',
      expectedRunRevision: childRun.revision,
      reason: 'test child terminal',
    })).run;
    childRun = (await childController.settleCancellation({
      commandId: 'settle-child-run',
      expectedRunRevision: childRun.revision,
    })).run;
    await childController.release();
    const terminalObservation = {
      schemaVersion: 1 as const,
      kind: 'subagent' as const,
      childRunId: child.childRunId,
      childSessionId: child.childSessionId,
      parentRunId: fixture.scope.runId,
      parentInvocationId: fixture.origin.invocationId,
      status: 'cancelled' as const,
      summary: 'Child Agent was cancelled.',
      evidenceRefs: [],
      artifactRefs: [],
    };
    const recoveryCommitter = openSubagentOutcomeRecoveryCommitter(fixture.journal);
    if (recoveryCommitter === undefined) throw new Error('Expected recovery outcome committer.');
    const recovery = {
      commandId: startCommand.commandId,
      origin: structuredClone(startCommand.origin),
      childRunId: child.childRunId,
      childSessionId: child.childSessionId,
      task: child.task,
      context: structuredClone(child.context),
    };
    // Recovery admits only this durable identity. It deliberately has no
    // executable revision/fencing fields, and every identity component is
    // rechecked by the SQLite Journal against runtime.command_applied.
    await expect(recoveryCommitter.commit({ ...recovery, task: 'forged recovery payload' }, terminalObservation))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(recoveryCommitter.commit({ ...recovery, context: { forged: true } }, terminalObservation))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(recoveryCommitter.commit({
      ...recovery,
      origin: { ...recovery.origin, turnId: 'forged-turn' },
    }, terminalObservation)).rejects.toMatchObject({ code: 'INVOCATION_STATE_CONFLICT' });
    await expect(recoveryCommitter.commit({ ...recovery, childRunId: 'forged-child' }, terminalObservation))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await recoveryCommitter.commit(recovery, terminalObservation);
    const restartedJournal = new SqliteAgentJournal({ filePath: fixture.filePath });
    const restartedOutcomeCommitter = openSubagentOutcomeRecoveryCommitter(restartedJournal);
    if (restartedOutcomeCommitter === undefined) {
      throw new Error('Expected reopened Subagent outcome committer.');
    }
    await restartedOutcomeCommitter.commit(recovery, terminalObservation);
    expect((await readAllProjectEvents(fixture.journal, fixture.scope.projectId)).filter(
      (event) => event.type === 'subagent.cancelled' &&
        event.invocationId === fixture.origin.invocationId,
    )).toHaveLength(1);
    expect((await runtimeCommandProjection(restartedJournal, fixture.scope)).children[0]).toMatchObject({
      childRunId: child.childRunId,
      status: 'cancelled',
      reason: 'Child Agent was cancelled.',
    });

    await expect(application.apply(fixture.issue({
      commandId: 'child-steer', kind: 'child.steer', expectedRunRevision: revision,
      payload: {
        childRunId: child.childRunId,
        expectedChildRevision: child.revision,
        input: { focus: 'late arrivals' },
      },
    }))).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });

    await expect(application.apply(fixture.issue({
      commandId: 'child-cancel', kind: 'child.cancel', expectedRunRevision: revision,
      payload: {
        childRunId: child.childRunId,
        expectedChildRevision: child.revision,
        reason: 'parent request changed',
      },
    }))).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });

    const eventNames = (await readAllProjectEvents(fixture.journal, fixture.scope.projectId))
      .map(({ type }) => type);
    expect(eventNames).toEqual(expect.arrayContaining([
      'tool.activated', 'skill.activated',
      'subagent.started', 'subagent.cancelled',
    ]));
    expect(eventNames.filter((type) => type === 'runtime.command_applied')).toHaveLength(3);
  });

  it('reopens and rebuilds the same projection from facts without persisting admission tokens', async () => {
    const fixture = await startedInvocationFixture('durable-replay');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'durable-plan', kind: 'plan.create',
      payload: { planId: 'durable-plan', plan: { goal: 'survive reopen and rebuild' } },
    });
    const applied = await application.apply(command);
    const online = await runtimeCommandProjection(fixture.journal, fixture.scope);
    expect(online).toEqual(applied.projection);

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(online);
    await reopened.rebuildProjectProjections(fixture.scope.projectId);
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(online);

    const reopenedApplication = await runtimeCommandApplication(reopened);
    expect(await reopenedApplication.apply(command)).toEqual(applied);
    const projectionBeforeForgery = await runtimeCommandProjection(reopened, fixture.scope);
    await expectCode(
      reopenedApplication.apply(structuredClone(command)),
      'RUNTIME_COMMAND_UNAUTHENTIC',
    );
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toEqual(projectionBeforeForgery);
  });

  it('rejects a root Session collision instead of rewriting delegated Session identity', async () => {
    const fixture = await startedInvocationFixture('child-session-identity-conflict');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'child-session-identity-conflict-start', kind: 'child.start',
      payload: { task: 'Do not rewrite an existing root Session.', context: {} },
    }) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const applied = await application.apply(command);
    const child = applied.projection.children[0];
    if (child === undefined) throw new Error('Expected committed child identity.');
    await fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      clientRequestId: 'preexisting-root-session',
      input: 'Independent user Session using the same id.',
    });

    await expect(fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: { task: child.task, context: child.context },
      parent: fixture.origin,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(await fixture.journal.getSessionIndex(
      fixture.scope.projectId, child.childSessionId,
    )).toMatchObject({ kind: 'root', visibility: 'public' });
  });

  it('rejects a mismatched delegated parent identity rather than coalescing it', async () => {
    const fixture = await startedInvocationFixture('child-session-parent-identity-conflict');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'child-session-parent-identity-conflict-start', kind: 'child.start',
      payload: { task: 'Do not rewrite delegated parents.', context: {} },
    }) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const applied = await application.apply(command);
    const child = applied.projection.children[0];
    if (child === undefined) throw new Error('Expected committed child identity.');
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.prepare(`
        INSERT INTO agent_sessions (
          project_id, session_id, session_kind, visibility, parent_run_id, parent_session_id,
          archive_revision, archived, title, created_at, updated_at, last_activity_sequence, run_count
        ) VALUES (?, ?, 'delegated', 'internal', 'other-parent-run', 'other-parent-session',
                  0, 0, NULL, ?, ?, 0, 0)
      `).run(
        fixture.scope.projectId, child.childSessionId,
        '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z',
      );
    } finally {
      database.close();
    }

    await expect(fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: { task: child.task, context: child.context },
      parent: fixture.origin,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(await fixture.journal.getSessionIndex(
      fixture.scope.projectId, child.childSessionId,
    )).toMatchObject({
      kind: 'delegated', visibility: 'internal',
      parentRunId: 'other-parent-run', parentSessionId: 'other-parent-session',
    });
  });

  it('inherits the parent Run environment while recapturing the child Turn capabilities', async () => {
    const fixture = await startedInvocationFixture('child-environment');
    const application = await runtimeCommandApplication(fixture.journal);
    const startCommand = fixture.issue({
      commandId: 'child-environment-start', kind: 'child.start',
      payload: { task: 'Inspect the durable parent environment.', context: {} },
    }) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const applied = await application.apply(startCommand);
    const child = applied.projection.children[0];
    if (child === undefined) throw new Error('Expected committed child identity.');
    await fixture.journal.createRun({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: { task: child.task, context: child.context },
      parent: fixture.origin,
    });

    const childRun = await fixture.journal.getRunProjection(child.childRunId);
    expect(childRun?.parent).toEqual(fixture.origin);
    const parentRun = childRun?.parent === undefined
      ? null
      : await fixture.journal.getRunProjection(childRun.parent.runId);
    expect(parentRun).toMatchObject({
      projectId: fixture.scope.projectId,
      sessionId: fixture.scope.sessionId,
      runId: fixture.scope.runId,
    });

    const latestSession = await createTestModelSession({
      connectionId: 'connection-latest', modelId: 'model-latest', outputText: 'latest',
    });
    const resolutionInputs: Array<Parameters<JournalAgentModelResolver>[0]> = [];
    const kernel = createJournalAgentKernel({
      journal: fixture.journal,
      gateway: new ModelExecutionGateway(),
      resolveModelSession: (input) => {
        resolutionInputs.push(structuredClone(input));
        return input.binding?.model.descriptor.primary.route.modelId === fixture.parentModelId
          ? fixture.parentSession
          : latestSession;
      },
      resolveUsageBillingMode: () => 'byok',
      toolCatalog: fixedBaselineCatalog(),
      permissionManager: new PermissionManager(),
      runtimeProtocol: {
        id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
        revision: 'runtime-current', cacheability: 'stable',
        content: [{ type: 'text', text: 'Complete the child task.' }], tokenEstimate: 8,
      },
      capability: { snapshotId: 'child-capability', revision: 'capability-current' },
      promptRevision: 'prompt-current',
      settingsRevision: 'settings-latest',
      permissionPolicyRevision: 'permission-latest',
      ownerId: 'child-environment-owner',
    });

    await expect(kernel.advance(child.childRunId)).resolves.toMatchObject({ state: 'Completed' });
    const resolutionInput = resolutionInputs.find((input) =>
      input.projectId === fixture.scope.projectId &&
      input.sessionId === child.childSessionId &&
      input.runId === child.childRunId &&
      input.binding?.source === 'run-environment' &&
      input.binding.runId === child.childRunId &&
      input.binding.sessionId === child.childSessionId);
    expect(resolutionInput).toBeDefined();
    expect(resolutionInput?.projectId).toBe(fixture.scope.projectId);
    expect(resolutionInput?.sessionId).toBe(child.childSessionId);
    expect(resolutionInput?.runId).toBe(child.childRunId);
    expect(resolutionInput?.parent).toEqual(fixture.origin);
    if (resolutionInput?.binding?.source !== 'run-environment') {
      throw new Error('Expected the child to resolve from its inherited Run environment.');
    }
    expect(resolutionInput.binding.runId).toBe(child.childRunId);
    expect(resolutionInput.binding.sessionId).toBe(child.childSessionId);
    const childEnvironment = await fixture.journal.getEnvironmentBinding({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
    });
    expect(childEnvironment?.payload).toMatchObject({
      settingsRevision: 'settings-parent-r1',
      permissionPolicyRevision: 'permission-parent-r1',
      modelSession: fixture.parentDescriptor,
    });
    expect(childEnvironment?.environmentBindingId).not.toBe(
      `environment_${fixture.parentDescriptor.bindingDigest}`,
    );
    const completedChild = await fixture.journal.getKernelRunProjection({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
    });
    if (completedChild?.currentTurnId === null || completedChild?.currentTurnId === undefined) {
      throw new Error('Expected child Turn.');
    }
    expect((await fixture.journal.getTurnSnapshot({
      projectId: fixture.scope.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      turnId: completedChild.currentTurnId,
    }))?.payload.capability).toEqual({
      snapshotId: 'child-capability', revision: 'capability-current',
    });
  }, 60_000);

  it('replays exactly after the transaction commits but its response is lost', async () => {
    const fixture = await startedInvocationFixture('response-loss');
    const application = await runtimeCommandApplication(fixture.journal);
    const command = fixture.issue({
      commandId: 'runtime-response-lost',
      kind: 'plan.create',
      payload: { planId: 'response-loss-plan', plan: { goal: 'commit exactly once' } },
    });
    fixture.journal.failRuntimeCommandAt('after-runtime-command-commit-before-response');
    await expect(application.apply(command)).rejects.toThrow(
      'INJECTED_RUNTIME_COMMAND_FAILURE:after-runtime-command-commit-before-response',
    );
    const committedRevision = await currentRunRevision(fixture.journal, fixture.scope);
    expect(committedRevision).toBe(fixture.runRevision + 1);
    expect(await countEventsByName(
      fixture.journal, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(1);
    expect(await fixture.journal.countEvents('plan.created', fixture.scope.projectId)).toBe(1);

    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    const replay = await (await runtimeCommandApplication(reopened)).apply(command);
    expect(replay.run.revision).toBe(committedRevision);
    expect(replay.projection).toEqual(
      await runtimeCommandProjection(reopened, fixture.scope),
    );
    expect(await countEventsByName(
      reopened, fixture.scope.projectId, 'runtime.command_applied',
    )).toBe(1);
    expect(await reopened.countEvents('plan.created', fixture.scope.projectId)).toBe(1);
  });

  it('rejects a structurally corrupted durable projection instead of trusting table JSON', async () => {
    const fixture = await startedInvocationFixture('projection-corruption');
    const application = await runtimeCommandApplication(fixture.journal);
    await application.apply(fixture.issue({
      commandId: 'activation-before-corruption',
      kind: 'discovery.activate',
      payload: discoveryActivation('query_database'),
    }));
    const database = new DatabaseSync(fixture.filePath);
    try {
      const row = database.prepare(
        'SELECT payload_json FROM agent_runtime_command_projections WHERE run_id = ?',
      ).get(fixture.scope.runId) as { payload_json: string } | undefined;
      if (row === undefined) throw new Error('Expected Runtime Command projection row.');
      const projection = JSON.parse(row.payload_json) as { activeTools: RuntimeToolActivation[] };
      projection.activeTools = [toolActivation('query_database'), toolActivation('query_database')];
      database.prepare(
        'UPDATE agent_runtime_command_projections SET payload_json = ? WHERE run_id = ?',
      ).run(JSON.stringify(projection), fixture.scope.runId);
    } finally {
      database.close();
    }
    const reopened = new SqliteAgentJournal({ filePath: fixture.filePath });
    await expect(reopened.getRuntimeCommandProjection(fixture.scope)).rejects.toMatchObject({
      code: 'PROJECTION_CORRUPT',
    });
    await reopened.rebuildProjectProjections(fixture.scope.projectId);
    expect(await runtimeCommandProjection(reopened, fixture.scope)).toMatchObject({
      activeTools: [toolActivation('query_database')],
    });
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

async function runtimeCommandApplication(journal: SqliteAgentJournal): Promise<RuntimeCommandApplication> {
  const module: object = await import('../src/internal/runtime-command-authority.js');
  const open = Reflect.get(module, 'openRuntimeCommandApplication') as unknown;
  if (typeof open !== 'function') {
    throw new Error(
      'RED contract: export openRuntimeCommandApplication(journal).apply(authenticCommand).',
    );
  }
  const candidate: unknown = Reflect.apply(open, undefined, [journal]);
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('Runtime Command application authority must be an object.');
  }
  const apply = Reflect.get(candidate, 'apply') as unknown;
  if (typeof apply !== 'function') {
    throw new Error('Runtime Command application authority must expose apply(command).');
  }
  return Object.freeze({
    apply: async (command) => await Reflect.apply(apply, candidate, [command]) as
      RuntimeCommandApplicationResult,
  });
}

async function runtimeCommandProjection(
  journal: SqliteAgentJournal,
  scope: RuntimeCommandScope,
): Promise<RuntimeCommandProjection> {
  const getter = Reflect.get(journal, 'getRuntimeCommandProjection') as unknown;
  if (typeof getter !== 'function') {
    throw new Error(
      'RED contract: Journal must expose getRuntimeCommandProjection({projectId,sessionId,runId}).',
    );
  }
  const projection: unknown = await Reflect.apply(getter, journal, [scope]);
  if (projection === null || typeof projection !== 'object') {
    throw new Error('Expected a durable Runtime Command projection.');
  }
  return projection as RuntimeCommandProjection;
}

type IssueOverride =
  | Readonly<{
      commandId: string;
      kind: 'plan.create';
      payload: { planId: string; plan: RuntimeCommandPlanValue };
    }>
  | Readonly<{
      commandId: string;
      kind: 'plan.update';
      payload: {
        planId: string;
        expectedPlanRevision: number;
        plan: RuntimeCommandPlanValue;
      };
    }>
  | Readonly<{
      commandId: string;
      kind: 'discovery.activate';
      payload: {
        tools: RuntimeToolActivation[];
        targets: Array<{ moduleId: string; instanceId: string }>;
        bindings: [];
      };
    }>
  | Readonly<{
      commandId: string;
      kind: 'skill.activate';
      payload: { activations: RuntimeSkillActivation[] };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.start';
      payload: { task: string; context: RuntimeCommandPlanValue };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.steer';
      payload: {
        childRunId: string;
        expectedChildRevision: number;
        input: RuntimeCommandPlanValue;
      };
    }>
  | Readonly<{
      commandId: string;
      kind: 'child.cancel';
      payload: { childRunId: string; expectedChildRevision: number; reason?: string };
    }>;

type RuntimeCommandPlanValue =
  | null | boolean | number | string
  | readonly RuntimeCommandPlanValue[]
  | { readonly [key: string]: RuntimeCommandPlanValue };

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

function toolActivation(name: string): RuntimeToolActivation {
  return { name, toolRevision: `${name}@1`, handlerRevision: `${name}-handler@1` };
}

function discoveryActivation(name: string): {
  tools: RuntimeToolActivation[];
  targets: [];
  bindings: [];
} {
  return { tools: [toolActivation(name)], targets: [], bindings: [] };
}

/** Publishes the whole fixed manifest: individual fixed names cannot be pinned ad hoc. */
function fixedBaselineCatalog() {
  const registry = new ToolRegistry();
  registry.publishBaselineInvocations(BASE_TOOL_MANIFEST.map(({ name, schemaRevision }) => {
    const handlerRevision = `${schemaRevision}:handler@1`;
    return {
      definition: {
        name,
        description: `Fixed Runtime Tool ${name}.`,
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        dangerLevel: 'safe' as const,
        readonly: true,
        source: 'runtime' as const,
        exposure: 'direct' as const,
        access: 'read' as const,
        recoveryClass: 'read' as const,
        limits: {
          timeoutMs: 1_000,
          maxInputBytes: 4_096,
          maxOutputBytes: 65_536,
          maxArtifactBytes: 1_048_576,
          maxDepth: 8,
          maxRecords: 128,
        },
        toolRevision: schemaRevision,
        handlerRevision,
        intentRevision: PREPARED_TOOL_INTENT_REVISION,
        execution: { concurrency: 'read' as const, timeoutMs: 1_000 },
        failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } },
      },
      runtime: {
        revision: {
          toolName: name,
          toolRevision: schemaRevision,
          handlerRevision,
          intentRevision: PREPARED_TOOL_INTENT_REVISION,
        },
        prepare: () => preparedToolIntent({
          toolName: name,
          toolRevision: schemaRevision,
          handlerRevision,
          actionSummary: `Execute fixed Tool ${name}.`,
        }).intent,
        execute: () => ({}),
      },
    };
  }));
  return registry.captureSnapshot();
}

async function startedInvocationFixture(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `runtime-command-${label}-`));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'journal.db');
  const journal = new SqliteAgentJournal({ filePath });
  const parentModelId = 'model-current';
  const parentSession = await createTestModelSession({
    connectionId: 'connection-current',
    modelId: parentModelId,
    outputText: 'parent',
  });
  const parentDescriptor = describeModelSessionBundle(createModelSessionBundle({
    primary: parentSession,
  }));
  const scopeSeed = {
    projectId: `project-${label}`,
    sessionId: `session-${label}`,
  };
  const ingress = await journal.createRun({
    ...scopeSeed,
    clientRequestId: `request-${label}`,
    input: `exercise Runtime Command ${label}`,
  });
  const scope = { ...scopeSeed, runId: ingress.runId };
  const controller = new RunController({
    journal,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    runId: scope.runId,
    ownerId: `owner-${label}`,
    leaseTtlMs: 60_000,
  });
  const lease = await controller.acquire();
  temporaryControllers.push(controller);
  const ownerId = `owner-${label}`;
  const leaseReference = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  const turnId = `turn-${label}`;
  const captured = await controller.captureTurn({
    commandId: `capture-${label}`,
    expectedRunRevision: 1,
    turnId,
    environment: {
      environmentBindingId: `environment_${parentDescriptor.bindingDigest}`,
      settingsRevision: 'settings-parent-r1',
      permissionPolicyRevision: 'permission-parent-r1',
      modelSession: parentDescriptor,
    },
    snapshot: {
      turnSnapshotId: `snapshot-parent-${label}`,
      capability: { snapshotId: 'parent-capability', revision: 'capability-parent-r1' },
      promptRevision: 'prompt-parent-r1',
      tools: [],
      skills: [],
      verifiers: [],
    },
  });
  const attempt = await validatedAttemptFixture(`runtime-command-${label}`);
  const contextReady = await controller.commitContextReady({
    commandId: `context-ready-${label}`,
    expectedRunRevision: captured.run.revision,
    turnId,
    expectedTurnRevision: 1,
  });
  const modelStarted = await controller.startModelAttempt({
    commandId: `model-start-${label}`,
    expectedRunRevision: contextReady.run.revision,
    turnId,
    expectedTurnRevision: 1,
    attemptId: attempt.attemptId,
    origin: attempt.origin,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    ...scope,
    turnId,
    commandId: `attempt-commit-${label}`,
    lease: leaseReference,
    expectedRunRevision: modelStarted.run.revision,
    expectedTurnRevision: 1,
    billingMode: 'byok',
    attempt,
  });
  const invocation = committed.invocations[0];
  const proposed = committed.invocations[1];
  if (invocation === undefined || proposed === undefined) {
    throw new Error('Expected two proposed Invocations from the validated attempt fixture.');
  }
  const lifecycle = openToolLifecycleCommitter(journal);
  let runRevision = await currentRunRevision(journal, scope);
  const preparedTool = preparedToolIntent({ actionSummary: 'Read exact test data.' });
  const prepared = await lifecycle.commit({
    action: 'prepare',
    ...scope,
    turnId,
    invocationId: invocation.invocationId,
    commandId: `invocation-prepare-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: invocation.revision,
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
    invocationId: invocation.invocationId,
    commandId: `invocation-validate-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: prepared.invocation.revision,
    canonicalToolId: { name: 'query_database' },
    toolRevision: 'query_database@1',
    recoveryClass: 'read',
    intentDigest: preparedTool.intentDigest,
    authorization: 'allow', permissionAudit: permissionAudit('allow'),
    actionSummary: 'Read exact test data.',
    approvalSummary: 'Allow exact test read.',
  });
  runRevision = await currentRunRevision(journal, scope);
  const started = await lifecycle.commit({
    action: 'start',
    ...scope,
    turnId,
    invocationId: invocation.invocationId,
    commandId: `invocation-start-${label}`,
    lease: leaseReference,
    expectedRunRevision: runRevision,
    expectedInvocationRevision: validated.invocation.revision,
    idempotencyKey: `effect-${label}`,
    attempt: 1,
    permissionAudit: executionPermissionAudit(),
    intentDigest: preparedTool.intentDigest,
  });
  runRevision = started.invocation.state === 'started'
    ? await currentRunRevision(journal, scope)
    : -1;
  if (runRevision < 1) throw new Error('Expected a started Invocation.');
  const origin = {
    runId: scope.runId,
    turnId,
    invocationId: invocation.invocationId,
  };
  const issuer = createRuntimeCommandIssuer();
  return {
    journal,
    filePath,
    parentSession,
    parentDescriptor,
    parentModelId,
    scope,
    origin,
    runRevision,
    turnId,
    ownerId,
    leaseReference,
    lifecycle,
    proposedInvocation: proposed,
    fencingToken: lease.fencingToken,
    proposedInvocationId: proposed.invocationId,
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

async function currentRunRevision(
  journal: SqliteAgentJournal,
  scope: RuntimeCommandScope,
): Promise<number> {
  const projection = await journal.getKernelRunProjection(scope);
  if (projection === null) throw new Error('Expected Kernel Run projection.');
  return projection.revision;
}

async function readAllProjectEvents(journal: SqliteAgentJournal, projectId: string) {
  return await journal.readProject(projectId, 0, 10_000);
}

async function countEventsByName(
  journal: SqliteAgentJournal,
  projectId: string,
  eventType: string,
): Promise<number> {
  return (await readAllProjectEvents(journal, projectId))
    .filter(({ type }) => type === eventType).length;
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
