import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCheckpointStore,
  AgentPlanExecutionStore,
  AgentRecoveryService,
  AgentSessionStore,
  AgentStreamStore,
  PlanExecuteRecoveryService,
  ToolRegistry,
  type AgentPlan,
  type AgentSession,
  type AgentToolContext,
} from '@dbagent/core-agent';
import type { IDatabaseDriver, TableSummary } from '@dbagent/core-db';
import {
  resolveOfficialPluginAgentTools,
  type WorkspaceScriptRunRequest,
} from '@dbagent/core-tools';
import { WorkspaceCore } from '@dbagent/core-workspace';
import {
  ok,
  type DatabaseEngine,
  type QueryCancelResponse,
  type QueryExecutionResult,
  type QueryRequest,
  type Result,
  type SavedConnection,
  type TableDetail,
  type WorkspaceProject,
} from '@dbagent/shared';
import { registerDesktopAgentTools } from './agent-tool-bootstrap.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('registerDesktopAgentTools', () => {
  it('registers database, schema RAG, and workspace tools for the headless desktop agent', () => {
    const registry = new ToolRegistry();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
    });

    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      'audit_sql',
      'build_schema_context',
      'describe_table',
      'execute_sql',
      'get_relations',
      'get_schema_rag_status',
      'install_python_deps',
      'list_schemas',
      'list_tables',
      'list_workspace_dir',
      'python_repl',
      'query_database',
      'read_workspace_file',
      'run_python_script',
      'run_shell_command',
      'search_schema',
      'write_workspace_file',
    ]);
    expect(registry.get('run_shell_command')).toMatchObject({
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.shell-command',
    });
  });

  it('reads the latest async connection state and routes SQL execution by engine', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    const routedEngines: DatabaseEngine[] = [];

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: (engine) => {
        routedEngines.push(engine);
        return driver;
      },
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'conn_desktop',
          sql: 'select count(*) as order_count from public.orders',
          limit: 20,
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      rowCount: 1,
      rows: [{ order_count: 42 }],
    });

    expect(driver.executed).toEqual([
      {
        connectionId: 'conn_desktop',
        database: 'analytics',
        sql: 'select count(*) as order_count from public.orders',
      },
    ]);
    expect(routedEngines).toEqual(['postgres']);
  });

  it('exposes the latest Schema RAG startup recovery summary as an official readonly tool', () => {
    const registry = new ToolRegistry();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
      schemaRagStartupRecovery: {
        latestSummary: () => ({
          activeConnectionCount: 2,
          loadedCount: 1,
          missingCount: 1,
          invalidCount: 0,
          errorCount: 0,
          restoredConnectionIds: ['conn_desktop'],
          failedConnectionIds: [],
          invalidSnapshotPaths: [],
        }),
      },
    });

    expect(registry.get('get_schema_rag_startup_recovery')?.handler({}, toolContext())).toEqual({
      available: true,
      summary: {
        activeConnectionCount: 2,
        loadedCount: 1,
        missingCount: 1,
        invalidCount: 0,
        errorCount: 0,
        restoredConnectionIds: ['conn_desktop'],
        failedConnectionIds: [],
        invalidSnapshotPaths: [],
      },
    });
    expect(registry.get('get_schema_rag_startup_recovery')).toMatchObject({
      source: 'official',
      sourceId: 'official.schema-rag',
      readonly: true,
    });
  });

  it('rejects SQL tools when the requested connection is not currently connected', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([{ ...connectedConnection(), status: 'disconnected' }]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => driver,
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'conn_desktop',
          sql: 'select 1',
        },
        toolContext(),
      ),
    ).rejects.toThrow('Connection is not active: conn_desktop');
    expect(driver.executed).toEqual([]);
  });

  it('keeps workspace tools registered with a clear inactive-workspace boundary', async () => {
    const registry = new ToolRegistry();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
    });

    await expect(
      registry.get('list_workspace_dir')?.handler({ path: '.' }, toolContext()),
    ).rejects.toThrow('No active workspace.');
  });

  it('resolves the active workspace root at tool execution time', async () => {
    const registry = new ToolRegistry();
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-workspace-'));
    tempDirs.push(rootPath);
    const workspace = new WorkspaceCore();
    await workspace.create({
      name: 'Desktop Agent Workspace',
      rootPath,
    });
    const activeProject: { value: WorkspaceProject | undefined } = { value: undefined };

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: {
        loadActive() {
          return Promise.resolve(activeProject.value);
        },
      },
      driverForEngine: () => fakeDriver(),
      workspace,
    });

    await expect(
      registry.get('read_workspace_file')?.handler({ path: 'outputs/summary.md' }, toolContext()),
    ).rejects.toThrow('No active workspace.');

    activeProject.value = workspaceProject(rootPath);

    await expect(
      registry
        .get('write_workspace_file')
        ?.handler(
          { path: 'outputs/summary.md', content: '# Summary\n\nactive workspace\n' },
          toolContext(),
        ),
    ).resolves.toMatchObject({
      relativePath: 'outputs/summary.md',
      bytes: 28,
    });
    await expect(readFile(join(rootPath, 'outputs', 'summary.md'), 'utf8')).resolves.toBe(
      '# Summary\n\nactive workspace\n',
    );
    await expect(
      registry.get('read_workspace_file')?.handler({ path: 'outputs/summary.md' }, toolContext()),
    ).resolves.toMatchObject({
      path: 'outputs/summary.md',
      content: '# Summary\n\nactive workspace\n',
      bytes: 28,
    });
  });

  it('refreshes workspace Python script tools from the active workspace', async () => {
    const registry = new ToolRegistry();
    const { workspace, rootPath } = await scriptWorkspace('summarize_orders');
    const activeProject = workspaceProject(rootPath);
    const launched: WorkspaceScriptRunRequest[] = [];
    const desktopTools = registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(activeProject),
      driverForEngine: () => fakeDriver(),
      workspace,
      scriptRunner: (request) => {
        launched.push(request);
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', elapsedMs: 12 });
      },
    });

    await expect(desktopTools.refreshWorkspaceScriptTools()).resolves.toMatchObject([
      {
        name: 'workspace_script:summarize_orders',
        relativePath: 'scripts/summarize_orders.py',
      },
    ]);
    expect(desktopTools.registeredWorkspaceScriptToolNames()).toEqual([
      'workspace_script:summarize_orders',
    ]);
    expect(registry.get('workspace_script:summarize_orders')).toMatchObject({
      dangerLevel: 'medium',
      readonly: false,
      source: 'workspace-script',
      sourceId: 'scripts/summarize_orders.py',
      originalName: 'workspace_script:summarize_orders',
    });

    await expect(
      registry
        .get('workspace_script:summarize_orders')
        ?.handler({ count: 3, region: 'east' }, toolContext()),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ok',
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      rootPath,
      relativePath: 'scripts/summarize_orders.py',
      args: { count: 3, region: 'east' },
      pythonPath: 'python',
      timeoutMs: 300_000,
    });
  });

  it('unregisters stale workspace script tools when the active workspace changes', async () => {
    const registry = new ToolRegistry();
    const first = await scriptWorkspace('summarize_orders');
    const second = await scriptWorkspace('plot_gmv');
    const activeProject: { value: WorkspaceProject | undefined } = {
      value: workspaceProject(first.rootPath),
    };
    const desktopTools = registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: {
        loadActive() {
          return Promise.resolve(activeProject.value);
        },
      },
      driverForEngine: () => fakeDriver(),
      workspace: first.workspace,
      scriptRunner: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }),
    });

    await desktopTools.refreshWorkspaceScriptTools();
    expect(registry.has('workspace_script:summarize_orders')).toBe(true);

    activeProject.value = undefined;
    await expect(
      registry
        .get('workspace_script:summarize_orders')
        ?.handler({ count: 1, region: 'east' }, toolContext()),
    ).rejects.toThrow('Workspace script tool is no longer active.');

    activeProject.value = workspaceProject(second.rootPath);
    await desktopTools.refreshWorkspaceScriptTools();
    expect(registry.has('workspace_script:summarize_orders')).toBe(false);
    expect(registry.has('workspace_script:plot_gmv')).toBe(true);
    expect(desktopTools.registeredWorkspaceScriptToolNames()).toEqual([
      'workspace_script:plot_gmv',
    ]);
  });

  it('exposes persisted Agent sessions and streams as official readonly tools', async () => {
    const registry = new ToolRegistry();
    const sessionStore = new AgentSessionStore(await sessionStorePath());
    const streamStore = new AgentStreamStore(await streamStorePath());
    await sessionStore.save({
      session: agentSession('session_orders', '订单分析'),
      now: '2026-07-09T10:00:00.000Z',
    });
    await streamStore.start({
      id: 'stream_orders',
      sessionId: 'session_orders',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-07-09T10:00:01.000Z',
    });
    await streamStore.appendEvent(
      'stream_orders',
      { type: 'text-delta', text: '订单总数为 42。' },
      '2026-07-09T10:00:02.000Z',
    );
    await streamStore.markIncomplete(
      'stream_orders',
      'network reset during stream',
      '2026-07-09T10:00:03.000Z',
    );

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
      agentSessions: sessionStore,
      agentStreams: streamStore,
    });

    await expect(
      registry.get('list_agent_sessions')?.handler({ query: '订单', limit: 5 }, toolContext()),
    ).resolves.toMatchObject({
      sessions: [{ id: 'session_orders', title: '订单分析', messageCount: 3, toolMessageCount: 1 }],
    });
    await expect(
      registry
        .get('read_agent_session')
        ?.handler({ sessionId: 'session_orders', maxMessages: 2 }, toolContext()),
    ).resolves.toMatchObject({
      id: 'session_orders',
      returnedMessageCount: 2,
      omittedMessageCount: 1,
      messages: [{ role: 'assistant' }, { role: 'tool' }],
    });
    await expect(
      registry
        .get('export_agent_session')
        ?.handler({ sessionId: 'session_orders', format: 'markdown', maxChars: 50 }, toolContext()),
    ).resolves.toMatchObject({
      sessionId: 'session_orders',
      format: 'markdown',
      truncated: true,
    });
    await expect(
      registry.get('list_recoverable_agent_streams')?.handler({ limit: 10 }, toolContext()),
    ).resolves.toMatchObject({
      streams: [{ id: 'stream_orders', status: 'incomplete', chunkCount: 1 }],
    });
    await expect(
      registry
        .get('read_agent_stream')
        ?.handler({ streamId: 'stream_orders', includeChunks: true }, toolContext()),
    ).resolves.toMatchObject({
      id: 'stream_orders',
      sessionId: 'session_orders',
      status: 'incomplete',
      text: '订单总数为 42。',
      chunkCount: 1,
      returnedChunkCount: 1,
    });

    const policy = resolveOfficialPluginAgentTools({
      toolRegistry: registry,
      readonlyOnly: true,
      skillAllowedTools: ['list_agent_sessions', 'read_agent_session', 'read_agent_stream'],
    });
    expect(policy.agentAllowedToolNames.sort()).toEqual([
      'list_agent_sessions',
      'read_agent_session',
      'read_agent_stream',
    ]);
    expect(policy.toolPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'read_agent_session',
          pluginId: 'official.agent-session-history',
          permissions: [
            expect.objectContaining({
              id: 'agent.session.read',
              resourceScopes: ['agent.session'],
            }),
          ],
        }),
      ]),
    );
  });

  it('exposes recoverable Plan & Execute snapshots as official readonly tools', async () => {
    const registry = new ToolRegistry();
    const planStore = new AgentPlanExecutionStore(await planStorePath());
    const recoveryService = new PlanExecuteRecoveryService(planStore);
    const plan = agentPlan('plan_refund_recovery', '退款异常分析');
    plan.steps[0]!.status = 'done';
    plan.steps[0]!.resultSummary = '已确认 orders 和 refunds 表关系';
    plan.steps[1]!.status = 'running';
    await planStore.save({
      plan,
      status: 'running',
      session: agentSession('session_refund_recovery', '退款分析'),
      finalText: '已完成 schema 检查，正在分析退款率。',
      executedSteps: 1,
      totalIterations: 3,
      toolExecutions: [
        {
          toolCallId: 'call_schema',
          toolName: 'search_schema',
          status: 'success',
          durationMs: 8,
          resultPreview: 'orders, refunds',
        },
        {
          toolCallId: 'call_refund',
          toolName: 'query_database',
          status: 'failed',
          durationMs: 12,
          resultPreview: 'relation refunds_2026 does not exist',
          failureKind: 'sql_repairable',
          retryable: true,
        },
      ],
      now: '2026-07-09T11:00:00.000Z',
    });

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
      agentPlans: planStore,
      agentPlanRecovery: recoveryService,
    });

    await expect(
      registry
        .get('list_recoverable_agent_plans')
        ?.handler({ query: '退款', limit: 5 }, toolContext()),
    ).resolves.toMatchObject({
      plans: [
        {
          planId: 'plan_refund_recovery',
          sessionId: 'session_refund_recovery',
          completedStepCount: 1,
          pendingStepCount: 1,
          actions: ['continue', 'restart', 'abandon'],
        },
      ],
    });
    await expect(
      registry
        .get('list_agent_plan_executions')
        ?.handler({ sessionId: 'session_refund_recovery', limit: 5 }, toolContext()),
    ).resolves.toMatchObject({
      plans: [
        {
          planId: 'plan_refund_recovery',
          status: 'running',
          completedStepCount: 1,
          runningStepCount: 1,
          toolExecutionCount: 2,
        },
      ],
    });
    await expect(
      registry.get('read_agent_plan_execution')?.handler(
        {
          planId: 'plan_refund_recovery',
          maxToolExecutions: 1,
          maxFinalTextChars: 8,
          includeSessionMessages: true,
          maxSessionMessages: 1,
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      planId: 'plan_refund_recovery',
      finalText: '已完成 sche',
      finalTextTruncated: true,
      returnedToolExecutionCount: 1,
      omittedToolExecutionCount: 1,
      toolExecutions: [{ toolName: 'query_database', status: 'failed' }],
      session: {
        id: 'session_refund_recovery',
        returnedMessageCount: 1,
        omittedMessageCount: 2,
        messages: [{ role: 'tool' }],
      },
    });

    const policy = resolveOfficialPluginAgentTools({
      toolRegistry: registry,
      readonlyOnly: true,
      skillAllowedTools: [
        'list_recoverable_agent_plans',
        'list_agent_plan_executions',
        'read_agent_plan_execution',
      ],
    });
    expect(policy.agentAllowedToolNames.sort()).toEqual([
      'list_agent_plan_executions',
      'list_recoverable_agent_plans',
      'read_agent_plan_execution',
    ]);
    expect(policy.toolPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'read_agent_plan_execution',
          pluginId: 'official.agent-plan-recovery',
          permissions: [
            expect.objectContaining({
              id: 'agent.plan.read',
              resourceScopes: ['agent.plan', 'agent.session'],
            }),
          ],
        }),
      ]),
    );
  });

  it('exposes persisted ReAct Agent checkpoints as official readonly tools', async () => {
    const registry = new ToolRegistry();
    const checkpointStore = new AgentCheckpointStore(await checkpointStorePath());
    const recoveryService = new AgentRecoveryService(checkpointStore);
    const session = agentSession('session_checkpoint_recovery', '订单查询恢复');
    session.messages.push({
      role: 'assistant',
      content: '我已经完成订单表查询，下一步分析退款。',
      createdAt: '2026-07-09T12:00:01.000Z',
    });
    await checkpointStore.save({
      session,
      iteration: 1,
      status: 'done',
      finalText: '已完成订单表查询。',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 9,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
      ],
      now: '2026-07-09T12:00:02.000Z',
    });
    await checkpointStore.save({
      session,
      iteration: 2,
      status: 'running',
      finalText: '正在分析退款表，需要继续。',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 9,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
        {
          toolCallId: 'call_refunds',
          toolName: 'query_database',
          status: 'failed',
          durationMs: 14,
          resultPreview: 'relation refunds_2026 does not exist',
          failureKind: 'sql_repairable',
          retryable: true,
        },
      ],
      now: '2026-07-09T12:01:00.000Z',
    });

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
      agentCheckpoints: checkpointStore,
      agentCheckpointRecovery: recoveryService,
    });

    await expect(
      registry
        .get('list_recoverable_agent_checkpoints')
        ?.handler({ query: '退款', limit: 5 }, toolContext()),
    ).resolves.toMatchObject({
      checkpoints: [
        {
          sessionId: 'session_checkpoint_recovery',
          interruptedIteration: 2,
          completedToolCount: 1,
          failedToolCount: 1,
          actions: ['continue', 'restart', 'abandon'],
        },
      ],
    });
    await expect(
      registry
        .get('list_agent_checkpoints')
        ?.handler({ sessionId: 'session_checkpoint_recovery', limit: 10 }, toolContext()),
    ).resolves.toMatchObject({
      checkpoints: [
        { iteration: 1, status: 'done', completedToolCount: 1 },
        { iteration: 2, status: 'running', completedToolCount: 1, failedToolCount: 1 },
      ],
    });
    await expect(
      registry.get('read_agent_checkpoint')?.handler(
        {
          sessionId: 'session_checkpoint_recovery',
          iteration: 2,
          maxToolExecutions: 1,
          maxFinalTextChars: 6,
          includeSessionMessages: true,
          maxSessionMessages: 1,
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      sessionId: 'session_checkpoint_recovery',
      iteration: 2,
      finalText: '正在分析退款',
      finalTextTruncated: true,
      returnedToolExecutionCount: 1,
      omittedToolExecutionCount: 1,
      toolExecutions: [{ toolName: 'query_database', status: 'failed' }],
      session: {
        id: 'session_checkpoint_recovery',
        returnedMessageCount: 1,
        omittedMessageCount: 3,
        messages: [{ role: 'assistant' }],
      },
    });

    const policy = resolveOfficialPluginAgentTools({
      toolRegistry: registry,
      readonlyOnly: true,
      skillAllowedTools: [
        'list_recoverable_agent_checkpoints',
        'list_agent_checkpoints',
        'read_agent_checkpoint',
      ],
    });
    expect(policy.agentAllowedToolNames.sort()).toEqual([
      'list_agent_checkpoints',
      'list_recoverable_agent_checkpoints',
      'read_agent_checkpoint',
    ]);
    expect(policy.toolPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'read_agent_checkpoint',
          pluginId: 'official.agent-checkpoint-recovery',
          permissions: [
            expect.objectContaining({
              id: 'agent.checkpoint.read',
              resourceScopes: ['agent.checkpoint', 'agent.session'],
            }),
          ],
        }),
      ]),
    );
  });
});

function connectionReader(connections: SavedConnection[]) {
  return {
    list() {
      return Promise.resolve(connections);
    },
  };
}

function workspaceReader(project?: WorkspaceProject) {
  return {
    loadActive() {
      return Promise.resolve(project);
    },
  };
}

function workspaceProject(rootPath: string): WorkspaceProject {
  return {
    version: 1,
    id: 'workspace_desktop_agent',
    name: 'Desktop Agent Workspace',
    rootPath,
    template: 'standard',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    connections: [],
    defaults: {
      agentMode: 'ask',
    },
    assetPaths: {
      sqlLibrary: 'sql/analytics',
      scripts: 'scripts',
      docs: 'docs',
      outputs: 'outputs',
    },
    python: {
      mode: 'system',
      requirementsPath: 'scripts/requirements.txt',
    },
    enabledSkills: [],
    enabledMcpServers: [],
    tags: [],
  };
}

async function scriptWorkspace(
  toolName: string,
): Promise<{ workspace: WorkspaceCore; rootPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-script-workspace-'));
  tempDirs.push(rootPath);
  const workspace = new WorkspaceCore();
  await workspace.create({
    name: `Script Workspace ${toolName}`,
    rootPath,
  });
  await workspace.writeFile(rootPath, `scripts/${toolName}.py`, scriptToolContent(toolName));
  return { workspace, rootPath };
}

async function sessionStorePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-session-tools-'));
  tempDirs.push(rootPath);
  return join(rootPath, 'agent-sessions.json');
}

async function streamStorePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-stream-tools-'));
  tempDirs.push(rootPath);
  return join(rootPath, 'agent-streams.json');
}

async function planStorePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-plan-tools-'));
  tempDirs.push(rootPath);
  return join(rootPath, 'agent-plan-executions.json');
}

async function checkpointStorePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-checkpoint-tools-'));
  tempDirs.push(rootPath);
  return join(rootPath, 'agent-checkpoints.json');
}

function agentPlan(id: string, title: string): AgentPlan {
  return {
    id,
    title,
    goal: '定位退款异常并给出业务解释。',
    createdAt: '2026-07-09T10:59:00.000Z',
    plannerModelText: 'Plan refund analysis.',
    steps: [
      {
        id: 'step_schema',
        title: '检查订单和退款表',
        instruction: '使用 Schema RAG 查找订单和退款相关表。',
        status: 'pending',
      },
      {
        id: 'step_query',
        title: '查询退款率',
        instruction: '执行只读 SQL 计算退款率。',
        status: 'pending',
        dependsOn: ['step_schema'],
      },
    ],
  };
}

function agentSession(id: string, title: string): AgentSession {
  return {
    id,
    title,
    mode: 'readonly',
    strategy: 'react',
    messages: [
      { role: 'user', content: '分析昨天订单总数。', createdAt: '2026-07-09T09:59:00.000Z' },
      {
        role: 'assistant',
        content: '我会先查询订单表。',
        toolCalls: [
          {
            id: 'call_orders',
            name: 'query_database',
            arguments: { connectionId: 'conn_desktop', sql: 'select count(*) from orders' },
          },
        ],
        createdAt: '2026-07-09T09:59:01.000Z',
      },
      {
        role: 'tool',
        toolCallId: 'call_orders',
        toolName: 'query_database',
        content: '{"rows":[{"count":42}]}',
        createdAt: '2026-07-09T09:59:02.000Z',
      },
    ],
    tokenUsage: {
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
    },
    aborted: false,
  };
}

function scriptToolContent(toolName: string): string {
  return [
    '"""',
    `@tool ${toolName}`,
    `Run ${toolName} for analytics.`,
    '@param count: int order count',
    '@param region: str region code',
    '"""',
    'import json',
    'import sys',
    'payload = json.loads(sys.argv[1])',
    'print(payload)',
    '',
  ].join('\n');
}

function connectedConnection(): SavedConnection {
  return {
    id: 'conn_desktop',
    name: 'Analytics Warehouse',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'analytics',
    username: 'analyst',
    ssl: true,
    readOnly: false,
    status: 'connected',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  };
}

function fakeDriver(): IDatabaseDriver & {
  executed: Array<{ connectionId: string; database: string; sql: string }>;
} {
  const executed: Array<{ connectionId: string; database: string; sql: string }> = [];
  return {
    executed,
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    test() {
      return Promise.resolve(ok({ latencyMs: 5 }));
    },
    connect() {
      return Promise.resolve(ok(connectedConnection()));
    },
    disconnect() {
      return Promise.resolve(ok(undefined));
    },
    execute(
      request: QueryRequest,
      connection: SavedConnection,
    ): Promise<Result<QueryExecutionResult>> {
      executed.push({
        connectionId: request.connectionId,
        database: connection.database,
        sql: request.sql,
      });
      return Promise.resolve(
        ok({
          queryId: 'query_desktop_agent',
          columns: [{ name: 'order_count', dataType: 'int8' }],
          rows: [{ order_count: 42 }],
          rowCount: 1,
          elapsedMs: 9,
          safety: {
            statementKind: 'SELECT',
            riskLevel: 'safe',
            requiresConfirmation: false,
            blocked: false,
            reasons: [],
          },
        }),
      );
    },
    cancel(request: QueryCancelResponse) {
      return Promise.resolve(ok(request));
    },
    listTables(): Promise<Result<TableSummary[]>> {
      return Promise.resolve(ok([{ schema: 'public', name: 'orders', type: 'table' }]));
    },
    describeTable(): Promise<Result<TableDetail>> {
      return Promise.resolve(
        ok({
          schema: 'public',
          name: 'orders',
          type: 'table',
          primaryKey: ['id'],
          columns: [
            {
              name: 'id',
              ordinal: 1,
              dataType: 'uuid',
              nullable: false,
              isPrimaryKey: true,
            },
          ],
        }),
      );
    },
  };
}

function toolContext(): AgentToolContext {
  return {
    session: {
      id: 'session_desktop_agent_tools',
      title: 'desktop agent tools',
      mode: 'readonly',
      strategy: 'react',
      messages: [],
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      aborted: false,
    },
  };
}
