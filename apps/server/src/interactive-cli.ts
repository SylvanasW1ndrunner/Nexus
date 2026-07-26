import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  DatabaseAgentRuntime,
  OpenAICompatibleProvider,
  initializeAgentProject,
  type AgentMode,
  type AgentUserEvent,
  type PostgresConnectionInput,
} from '@dbagent/sdk';

export type InteractiveCliOptions = {
  projectDirectory?: string;
  input?: Readable;
  output?: Writable;
  env?: NodeJS.ProcessEnv;
};

type PendingCliApproval = {
  sessionId?: string;
  resolve: (approved: boolean) => void;
};

export function classifyCliApprovalInput(value: string): 'approve' | 'reject' | 'steer' {
  const normalized = value.trim();
  if (/^(?:y|yes|允许)$/i.test(normalized)) return 'approve';
  if (!normalized || /^(?:n|no|拒绝)$/i.test(normalized)) return 'reject';
  return 'steer';
}

export async function initializeCliProject(directory = process.cwd()): Promise<string> {
  await mkdir(directory, { recursive: true });
  const project = await initializeAgentProject(directory);
  return project.rootPath;
}

export async function listCliSkills(
  options: Pick<InteractiveCliOptions, 'projectDirectory' | 'env'> = {},
): Promise<Array<{ name: string; description: string; scope: string }>> {
  const runtime = new DatabaseAgentRuntime({
    projectDirectory: options.projectDirectory ?? process.cwd(),
    ...(options.env?.SCHEMANAUT_STATE_DATABASE_PATH?.trim()
      ? {
          sessionDatabasePath: options.env.SCHEMANAUT_STATE_DATABASE_PATH.trim(),
        }
      : {}),
  });
  try {
    await runtime.refreshSkills();
    return await runtime.listAgentSkills();
  } finally {
    await runtime.close();
  }
}

export async function listCliSessions(
  options: Pick<InteractiveCliOptions, 'projectDirectory' | 'env'> = {},
): Promise<Array<{ id: string; title: string; mode: AgentMode }>> {
  const runtime = new DatabaseAgentRuntime({
    projectDirectory: options.projectDirectory ?? process.cwd(),
    ...(options.env?.SCHEMANAUT_STATE_DATABASE_PATH?.trim()
      ? {
          sessionDatabasePath: options.env.SCHEMANAUT_STATE_DATABASE_PATH.trim(),
        }
      : {}),
  });
  try {
    return (await runtime.listAgentSessions({ limit: 100 })).map((session) => ({
      id: session.id,
      title: session.title,
      mode: session.mode,
    }));
  } finally {
    await runtime.close();
  }
}

export async function startInteractiveCli(options: InteractiveCliOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const config = cliConfigFromEnv(env);

  let pendingApproval: PendingCliApproval | undefined;
  const runtime = new DatabaseAgentRuntime({
    projectDirectory,
    ...(env.SCHEMANAUT_STATE_DATABASE_PATH?.trim()
      ? { sessionDatabasePath: env.SCHEMANAUT_STATE_DATABASE_PATH.trim() }
      : {}),
    provider: new OpenAICompatibleProvider({
      id: 'cli-openai-compatible',
      name: 'CLI OpenAI-compatible',
      baseUrl: config.baseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(isLocalModelUrl(config.baseUrl)
        ? { allowUnauthenticated: true, metadataSource: 'ollama' as const }
        : {}),
    }),
    model: config.model,
    approvalProvider: async (request) =>
      await new Promise((resolveApproval) => {
        let settled = false;
        function onAbort(): void {
          finish(false);
        }
        function finish(approved: boolean): void {
          if (settled) return;
          settled = true;
          request.signal?.removeEventListener('abort', onAbort);
          if (pendingApproval?.resolve === finish) pendingApproval = undefined;
          resolveApproval(approved);
        }
        pendingApproval = {
          resolve: finish,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        };
        if (request.signal?.aborted) {
          finish(false);
          return;
        }
        request.signal?.addEventListener('abort', onAbort, { once: true });
        write(output, `\n${paint(output, 'yellow', '需要许可')}: ${request.tool.name}\n`);
        const sql = request.toolCall.arguments.sql;
        if (typeof sql === 'string') write(output, `${sql.trim()}\n`);
        write(output, '输入 y 本次允许，n 拒绝；也可直接输入新的任务要求 > ');
      }),
  });
  let indexed: Awaited<ReturnType<DatabaseAgentRuntime['indexSchema']>>;
  try {
    await runtime.connect(parseCliPostgresUrl(config.databaseUrl));
    indexed = await runtime.indexSchema({ maxTables: config.maxTables });
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }

  const cli = createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
    prompt: `${paint(output, 'cyan', 'schemanaut')}> `,
  });
  write(
    output,
    [
      `${paint(output, 'cyan', 'SchemaNaut Agent CLI')}`,
      `项目: ${projectDirectory}`,
      `数据库知识目录: ${indexed.tableCount} 张表，${indexed.columnCount} 个字段`,
      '输入 /help 查看命令；普通输入会交给 Agent。',
      '',
    ].join('\n'),
  );

  let mode: Extract<AgentMode, 'read' | 'edit' | 'full'> = 'read';
  let sessionId: string | undefined;
  let activeRun = false;
  let activeRunSessionId: string | undefined;
  let controller: AbortController | undefined;
  const steeringBeforeSession: string[] = [];

  const showPrompt = () => {
    if (!activeRun && !pendingApproval) cli.prompt();
  };

  cli.on('SIGINT', () => {
    if (activeRun) {
      controller?.abort();
      write(output, '\n正在取消当前执行；会话记录会保留。\n');
      return;
    }
    cli.close();
  });

  cli.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (pendingApproval) {
      const approval = pendingApproval;
      const decision = classifyCliApprovalInput(line);
      if (decision === 'approve') {
        approval.resolve(true);
      } else if (decision === 'reject') {
        approval.resolve(false);
      } else {
        const steered = approval.sessionId
          ? runtime.steerAgentSession(approval.sessionId, line)
          : false;
        approval.resolve(false);
        if (steered) {
          write(output, `${paint(output, 'dim', '已拒绝原操作，并更新当前任务')}\n`);
        } else {
          steeringBeforeSession.push(line);
          write(output, `${paint(output, 'dim', '已拒绝原操作；新要求将在会话建立后加入')}\n`);
        }
      }
      return;
    }
    if (!line) {
      showPrompt();
      return;
    }
    if (activeRun) {
      if (activeRunSessionId && runtime.steerAgentSession(activeRunSessionId, line)) {
        write(output, `${paint(output, 'dim', '已补充到当前任务')}\n`);
      } else {
        steeringBeforeSession.push(line);
        write(output, `${paint(output, 'dim', '将在会话建立后补充')}\n`);
      }
      return;
    }
    void handleLine(line).catch((error: unknown) => {
      write(
        output,
        `${paint(output, 'red', '错误')}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      activeRun = false;
      activeRunSessionId = undefined;
      controller = undefined;
      steeringBeforeSession.length = 0;
      showPrompt();
    });
  });

  async function handleLine(line: string): Promise<void> {
    if (line.startsWith('/')) {
      const [command = '', ...argumentsList] = line.split(/\s+/);
      const argument = argumentsList.join(' ');
      if (command === '/exit' || command === '/quit') {
        cli.close();
        return;
      }
      if (command === '/help') {
        write(output, cliHelp());
        showPrompt();
        return;
      }
      if (command === '/mode') {
        if (!['read', 'edit', 'full'].includes(argument)) {
          throw new Error('/mode 只接受 read、edit 或 full。');
        }
        mode = argument as typeof mode;
        write(output, `权限模式已切换为 ${mode}。\n`);
        showPrompt();
        return;
      }
      if (command === '/new') {
        sessionId = undefined;
        write(output, '已开始一个全新的隔离会话。\n');
        showPrompt();
        return;
      }
      if (command === '/resume') {
        if (!argument) throw new Error('用法：/resume <session-id>');
        const session = await runtime.getAgentSession(argument);
        if (!session) throw new Error(`未找到会话：${argument}`);
        sessionId = session.id;
        write(output, `已恢复会话：${session.title} (${session.id})\n`);
        showPrompt();
        return;
      }
      if (command === '/sessions') {
        const sessions = await runtime.listAgentSessions({ limit: 30 });
        write(
          output,
          sessions.length === 0
            ? '暂无会话。\n'
            : `${sessions
                .map((session) => `${session.id}  ${session.mode.padEnd(4)}  ${session.title}`)
                .join('\n')}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/skills') {
        await runtime.refreshSkills();
        const skills = await runtime.listAgentSkills();
        write(
          output,
          `${skills
            .map((skill) => `/${skill.scope}:${skill.name}  ${skill.description}`)
            .join('\n')}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/compact') {
        if (!sessionId) throw new Error('当前还没有可压缩的会话。');
        const compacted = await runtime.compactAgentSession({
          sessionId,
          ...(argument ? { focus: argument } : {}),
        });
        write(
          output,
          compacted.status === 'compacted'
            ? `上下文已压缩，保留完整历史；当前摘要约 ${compacted.report.summaryTokenEstimate ?? 0} tokens。\n`
            : '当前上下文尚不需要压缩。\n',
        );
        showPrompt();
        return;
      }
      if (command === '/mcp') {
        const [action = 'list', serverId] = argumentsList;
        if (action === 'start') {
          if (!serverId) throw new Error('用法：/mcp start <server-id>');
          const started = await runtime.startMcpServer(serverId);
          write(
            output,
            `${serverId}: ${started.server.status}，发现 ${started.tools.length} 个工具。\n`,
          );
          showPrompt();
          return;
        }
        if (action === 'stop') {
          if (!serverId) throw new Error('用法：/mcp stop <server-id>');
          const stopped = await runtime.stopMcpServer(serverId);
          write(
            output,
            `${serverId}: ${stopped.status}，已移除 ${stopped.removedTools.length} 个工具。\n`,
          );
          showPrompt();
          return;
        }
        if (action !== 'list') {
          throw new Error('用法：/mcp [list|start <id>|stop <id>]');
        }
        const servers = await runtime.listMcpServers();
        write(
          output,
          servers.length === 0
            ? '尚未配置 MCP Server；请编辑 .schemanaut/mcp.json。\n'
            : `${servers
                .map((server) => `${server.id.padEnd(24)} ${server.status}  ${server.transport}`)
                .join('\n')}\n`,
        );
        showPrompt();
        return;
      }
      if (['/agent', '/init', '/permissions', '/session'].includes(command)) {
        throw new Error(`命令 ${command} 尚未在交互模式中提供。`);
      }
      // Other slash commands are standard Skill invocations.
    }

    activeRun = true;
    activeRunSessionId = sessionId;
    controller = new AbortController();
    write(output, `${paint(output, 'dim', '正在处理…')}\n`);
    const run = await runtime.runAgent({
      message: line,
      ...(sessionId === undefined ? {} : { sessionId }),
      mode,
      signal: controller.signal,
      onEvent: (event) => {
        activeRunSessionId = event.sessionId;
        while (steeringBeforeSession.length > 0) {
          const steering = steeringBeforeSession.shift();
          if (steering) runtime.steerAgentSession(event.sessionId, steering);
        }
        renderEvent(output, event);
      },
    });
    sessionId = run.result.session.id;
    write(output, `\n${paint(output, 'green', '回答')}\n${run.result.finalText.trim()}\n`);
    if ((run.result.artifacts ?? []).length > 0) {
      write(
        output,
        `${paint(output, 'cyan', '产物')}: ${(run.result.artifacts ?? [])
          .map((artifact) => artifact.path)
          .join('、')}\n`,
      );
    }
    write(
      output,
      `${paint(output, 'dim', `Session ${sessionId} · ${run.result.session.tokenUsage.totalTokens} tokens`)}\n`,
    );
    activeRun = false;
    activeRunSessionId = undefined;
    controller = undefined;
    showPrompt();
  }

  return await new Promise<void>((resolveDone) => {
    cli.once('close', () => {
      void runtime
        .close()
        .catch(() => undefined)
        .finally(resolveDone);
    });
    showPrompt();
  });
}

function cliConfigFromEnv(env: NodeJS.ProcessEnv): {
  baseUrl: string;
  apiKey?: string;
  model: string;
  databaseUrl: string;
  maxTables: number;
} {
  const baseUrl = env.SCHEMANAUT_LLM_BASE_URL?.trim();
  const model = env.SCHEMANAUT_LLM_MODEL?.trim();
  const databaseUrl = env.SCHEMANAUT_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!baseUrl || !model || !databaseUrl) {
    throw new Error(
      [
        'CLI 缺少连接配置。',
        '请设置 SCHEMANAUT_LLM_BASE_URL、SCHEMANAUT_LLM_MODEL、SCHEMANAUT_DATABASE_URL，',
        '远程模型另需 SCHEMANAUT_LLM_API_KEY；本地 Ollama 可不设置密钥。',
      ].join(' '),
    );
  }
  const maxTables = Number(env.SCHEMANAUT_MAX_SCHEMA_TABLES ?? '500');
  if (!Number.isSafeInteger(maxTables) || maxTables < 1 || maxTables > 1_000) {
    throw new Error('SCHEMANAUT_MAX_SCHEMA_TABLES 必须是 1 到 1000 的整数。');
  }
  return {
    baseUrl,
    ...(env.SCHEMANAUT_LLM_API_KEY?.trim() ? { apiKey: env.SCHEMANAUT_LLM_API_KEY.trim() } : {}),
    model,
    databaseUrl,
    maxTables,
  };
}

export function parseCliPostgresUrl(value: string): PostgresConnectionInput {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SCHEMANAUT_DATABASE_URL 不是有效的 PostgreSQL URL。');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('CLI 当前仅支持 postgres:// 或 postgresql:// URL。');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database || !url.username) {
    throw new Error('PostgreSQL URL 必须包含主机、数据库名和用户名。');
  }
  const sslMode = url.searchParams.get('sslmode');
  const supportedSslModes = new Set(['disable', 'require', 'verify-ca', 'verify-full']);
  if (sslMode && !supportedSslModes.has(sslMode)) {
    throw new Error(
      'PostgreSQL URL 的 sslmode 只接受 disable、require、verify-ca 或 verify-full。',
    );
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PostgreSQL URL 的端口必须是 1 到 65535 之间的整数。');
  }
  return {
    name: 'CLI database',
    host: url.hostname,
    port,
    database,
    username: decodeURIComponent(url.username),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(sslMode
      ? {
          ssl:
            sslMode === 'disable'
              ? false
              : (sslMode as Exclude<PostgresConnectionInput['ssl'], boolean | undefined>),
        }
      : {}),
  };
}

function renderEvent(output: Writable, event: AgentUserEvent): void {
  if (event.type === 'completed') return;
  const symbol =
    event.type === 'approval-required'
      ? '!'
      : event.type === 'correcting'
        ? '↻'
        : event.type === 'artifact-created'
          ? '+'
          : '·';
  write(output, `${paint(output, 'dim', `${symbol} ${event.message}`)}\n`);
}

function cliHelp(): string {
  return [
    '',
    '命令',
    '  /mode read|edit|full  切换数据库权限',
    '  /new                  新建隔离会话',
    '  /resume <id>          恢复会话',
    '  /sessions             查看会话',
    '  /skills               查看可用 Skills',
    '  /<skill> [任务]       显式执行 Skill',
    '  /compact [关注点]     手动压缩上下文',
    '  /mcp [list|start|stop] 管理项目 MCP Server',
    '  /exit                 退出',
    '',
    'Agent 工作时继续输入普通文字，会作为补充要求加入当前任务；Ctrl+C 取消当前执行。',
    '',
  ].join('\n');
}

function isLocalModelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function paint(
  output: Writable,
  color: 'cyan' | 'green' | 'yellow' | 'red' | 'dim',
  value: string,
): string {
  if (!(output as NodeJS.WriteStream).isTTY) return value;
  const codes = {
    cyan: 36,
    green: 32,
    yellow: 33,
    red: 31,
    dim: 2,
  };
  return `\u001B[${codes[color]}m${value}\u001B[0m`;
}

function write(output: Writable, value: string): void {
  output.write(value);
}
