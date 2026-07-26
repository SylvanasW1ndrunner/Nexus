import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunCoordinator,
  AgentSubagentPool,
  AgentUserEventProjector,
  agentProjectPathsEqual,
  agentProjectStorageIdentity,
  assertSameAgentProject,
  createAgentSession,
  createAgentTaskPlan,
  findAgentProject,
  initializeAgentProject,
  isAgentTaskPlanComplete,
  isUserRelevantAgentEvent,
  unresolvedAgentTasks,
  updateAgentTask,
  type AgentRunResult,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Agent project context', () => {
  it('initializes the minimal project layout and discovers it from descendants', async () => {
    const root = await temporaryDirectory();
    const project = await initializeAgentProject(root);
    const nested = join(root, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(project.instructionsPath, '# Project rule\nUse UTC.', 'utf8');

    const reopened = await initializeAgentProject(root);
    const discovered = await findAgentProject(nested);

    expect(reopened.rootPath).toBe(project.rootPath);
    await expect(readFile(project.instructionsPath, 'utf8')).resolves.toBe(
      '# Project rule\nUse UTC.',
    );
    expect(discovered).toMatchObject({
      rootPath: project.rootPath,
      instructions: '# Project rule\nUse UTC.',
    });
    expect((await stat(project.skillsDirectory)).isDirectory()).toBe(true);
    expect((await stat(join(root, 'sql'))).isDirectory()).toBe(true);
    expect((await stat(join(root, 'artifacts'))).isDirectory()).toBe(true);
    await expect(stat(join(root, '.schemanaut', 'agents'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prevents a durable Session from silently moving between projects', async () => {
    const left = await initializeAgentProject(await temporaryDirectory());
    const right = await initializeAgentProject(await temporaryDirectory());

    expect(() =>
      assertSameAgentProject(
        { rootPath: left.rootPath, configDirectory: left.configDirectory },
        right,
      ),
    ).toThrow('different project');
  });

  it('preserves case-sensitive project isolation outside Windows', () => {
    expect(agentProjectPathsEqual('/data/Foo', '/data/foo', 'linux')).toBe(false);
    expect(agentProjectPathsEqual('/data/Foo', '/data/foo', 'win32')).toBe(true);
    expect(
      agentProjectStorageIdentity(
        { rootPath: '/data/Foo', configDirectory: '/data/Foo/.schemanaut' },
        'linux',
      ).projectKey,
    ).not.toBe(
      agentProjectStorageIdentity(
        { rootPath: '/data/foo', configDirectory: '/data/foo/.schemanaut' },
        'linux',
      ).projectKey,
    );
    expect(
      agentProjectStorageIdentity(
        { rootPath: '/data/Foo', configDirectory: '/data/Foo/.schemanaut' },
        'win32',
      ).projectKey,
    ).toBe(
      agentProjectStorageIdentity(
        { rootPath: '/data/foo', configDirectory: '/data/foo/.schemanaut' },
        'win32',
      ).projectKey,
    );
  });
});

describe('Agent run coordination and planning', () => {
  it('isolates steering by Session and rejects concurrent runs for one Session', () => {
    const coordinator = new AgentRunCoordinator();
    const finish = coordinator.begin('session-a', '2026-07-25T00:00:00.000Z');

    expect(coordinator.steer('session-b', 'ignored')).toBe(false);
    expect(coordinator.steer('session-a', '只看上海')).toBe(true);
    expect(coordinator.list()).toEqual([
      {
        sessionId: 'session-a',
        startedAt: '2026-07-25T00:00:00.000Z',
        queuedSteering: 1,
      },
    ]);
    expect(coordinator.consume('session-a')).toMatchObject([{ content: '只看上海' }]);
    expect(() => coordinator.begin('session-a')).toThrow('active run');
    finish();
    finish();
    expect(coordinator.isActive('session-a')).toBe(false);
  });

  it('enforces dependencies, one active task, evidence, and terminal transitions', () => {
    let plan = createAgentTaskPlan({
      goal: 'Produce and verify SQL',
      tasks: [
        {
          id: 'discover',
          title: 'Discover schema',
          acceptanceCriteria: ['Relevant tables are identified'],
        },
        {
          id: 'query',
          title: 'Run query',
          dependsOn: ['discover'],
          acceptanceCriteria: ['Database result verifies the answer'],
        },
      ],
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(() => updateAgentTask(plan, { taskId: 'query', status: 'in_progress' })).toThrow(
      'incomplete task discover',
    );
    plan = updateAgentTask(plan, {
      taskId: 'discover',
      status: 'completed',
      evidence: {
        kind: 'tool-result',
        summary: 'orders and payments were found',
        reference: 'tool-call-discover',
      },
    });
    plan = updateAgentTask(plan, {
      taskId: 'query',
      status: 'in_progress',
    });
    plan = updateAgentTask(plan, {
      taskId: 'query',
      status: 'completed',
      evidence: {
        kind: 'database-result',
        summary: 'aggregate returned one row',
        reference: 'tool-call-query',
      },
    });

    expect(isAgentTaskPlanComplete(plan)).toBe(true);
    expect(unresolvedAgentTasks(plan)).toEqual([]);
    expect(plan.tasks[1]?.evidence[0]?.kind).toBe('database-result');
    expect(() => updateAgentTask(plan, { taskId: 'query', status: 'pending' })).toThrow(
      'cannot transition',
    );
    const unverifiable = createAgentTaskPlan({
      goal: 'Cannot self-certify',
      tasks: [{ id: 'claim', title: 'Claim success' }],
    });
    expect(() =>
      updateAgentTask(unverifiable, {
        taskId: 'claim',
        status: 'completed',
        evidence: { kind: 'observation', summary: 'The model says it is done.' },
      }),
    ).toThrow('requires concrete');
    expect(() =>
      updateAgentTask(unverifiable, {
        taskId: 'claim',
        status: 'cancelled',
      }),
    ).toThrow('runtime or user-confirmation');
    const revised = updateAgentTask(unverifiable, {
      taskId: 'claim',
      status: 'cancelled',
      evidence: {
        kind: 'database-result',
        summary: 'The configured source does not exist.',
        reference: 'tool-call-missing-source',
      },
    });
    expect(isAgentTaskPlanComplete(revised)).toBe(true);
    expect(() =>
      createAgentTaskPlan({
        goal: 'Cycle',
        tasks: [
          { id: 'a', title: 'A', dependsOn: ['b'] },
          { id: 'b', title: 'B', dependsOn: ['a'] },
        ],
      }),
    ).toThrow('cycle');
  });
});

describe('Agent user events and subagents', () => {
  it('emits only semantic user events and filters internal implementation metadata', async () => {
    const received: string[] = [];
    const projector = new AgentUserEventProjector(
      (event) => {
        received.push(event.message);
      },
      {
        now: () => '2026-07-25T00:00:00.000Z',
        createId: () => 'event-1',
      },
    );
    const event = await projector.emit('session-a', {
      type: 'exploring',
      message: '正在确认订单字段。',
    });

    expect(event).toMatchObject({
      id: 'event-1',
      sessionId: 'session-a',
      message: '正在确认订单字段。',
    });
    expect(received).toEqual(['正在确认订单字段。']);
    expect(isUserRelevantAgentEvent(event)).toBe(true);
    expect(
      isUserRelevantAgentEvent({
        ...event,
        message: 'catalog root hash = abc',
      }),
    ).toBe(false);
    await projector.emit('session-a', {
      type: 'exploring',
      message: 'node id = internal-1',
    });
    expect(received).toEqual(['正在确认订单字段。']);
  });

  it('runs children with independent options and distinguishes done, incomplete, and cancelled', async () => {
    const calls: string[] = [];
    const successful = new AgentSubagentPool((options) => {
      calls.push(options.userMessage);
      return Promise.resolve(runResult('done', options.userMessage));
    });
    const spawned = await successful.spawn({
      parentSessionId: 'parent',
      task: 'Inspect schema',
      options: {
        providerId: 'test',
        model: 'test',
        userMessage: 'Inspect schema',
        mode: 'read',
      },
    });
    const completed = await successful.wait(spawned.id);
    expect(completed).toMatchObject({
      parentSessionId: 'parent',
      task: 'Inspect schema',
      status: 'completed',
      summary: 'Inspect schema',
    });
    expect(calls).toEqual(['Inspect schema']);

    const incomplete = new AgentSubagentPool((options) =>
      Promise.resolve(runResult('max_iterations_reached', options.userMessage)),
    );
    const incompleteRecord = await incomplete.spawn({
      parentSessionId: 'parent',
      task: 'Unresolvable task',
      options: {
        providerId: 'test',
        model: 'test',
        userMessage: 'Unresolvable task',
        mode: 'read',
      },
    });
    await expect(incomplete.wait(incompleteRecord.id)).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Child Agent finished with status max_iterations_reached.',
    });

    const cancellable = new AgentSubagentPool(
      (options) =>
        new Promise<AgentRunResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
      { maxConcurrent: 1 },
    );
    const running = await cancellable.spawn({
      parentSessionId: 'parent',
      task: 'Long task',
      options: {
        providerId: 'test',
        model: 'test',
        userMessage: 'Long task',
        mode: 'read',
      },
    });
    await expect(
      cancellable.spawn({
        parentSessionId: 'parent',
        task: 'Second task',
        options: {
          providerId: 'test',
          model: 'test',
          userMessage: 'Second task',
          mode: 'read',
        },
      }),
    ).rejects.toThrow('concurrency limit');
    expect(cancellable.stop(running.id)).toBe(true);
    await expect(cancellable.wait(running.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
  });
});

function runResult(status: AgentRunResult['status'], finalText: string): AgentRunResult {
  return {
    status,
    session: createAgentSession({
      id: `child-${status}`,
      title: 'Child',
      mode: 'read',
      now: () => '2026-07-25T00:00:00.000Z',
    }),
    finalText,
    iterations: 1,
    toolExecutions: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-foundations-'));
  temporaryDirectories.push(directory);
  return directory;
}
