import type {
  AgentSession,
  AgentSessionExportFormat,
  AgentSessionListFilter,
  AgentSessionSummary,
  AgentStreamRecord,
  ToolRegistry,
} from '@dbagent/core-agent';
import type {
  DatabaseCapabilities,
  DatabaseConnectionConfig,
  IDatabaseDriver,
  QueryExecutionObserver,
  TableSummary,
} from '@dbagent/core-db';
import { SchemaRagEngine } from '@dbagent/core-rag';
import {
  registerDatabaseTools,
  registerWorkspaceScriptTools,
  registerWorkspaceTools,
  runWorkspacePythonScript,
  type WorkspaceScriptRunner,
} from '@dbagent/core-tools';
import { WorkspaceCore, type WorkspaceScriptTool } from '@dbagent/core-workspace';
import type {
  ConnectionId,
  DatabaseEngine,
  QueryCancelResponse,
  QueryExecutionResult,
  QueryRequest,
  Result,
  SavedConnection,
  TableDetail,
  WorkspaceProject,
} from '@dbagent/shared';
import { resolveWorkspacePythonExecution } from './python-environment.js';

type ConnectionReader = {
  list(): Promise<SavedConnection[]>;
};

type WorkspaceReader = {
  loadActive(): Promise<WorkspaceProject | undefined>;
};

type AgentSessionHistoryReader = {
  list(filter?: AgentSessionListFilter): Promise<AgentSessionSummary[]>;
  load(id: string): Promise<AgentSession | undefined>;
  export(id: string, format: AgentSessionExportFormat): Promise<string>;
};

type AgentStreamHistoryReader = {
  listBySession(sessionId: string): Promise<AgentStreamRecord[]>;
  load(streamId: string): Promise<AgentStreamRecord | undefined>;
  listRecoverable(): Promise<AgentStreamRecord[]>;
};

export type AgentToolBootstrapDependencies = {
  registry: ToolRegistry;
  connections: ConnectionReader;
  workspaceProjects: WorkspaceReader;
  driverForEngine: (engine: DatabaseEngine) => IDatabaseDriver;
  rag?: SchemaRagEngine;
  workspace?: WorkspaceCore;
  scriptRunner?: WorkspaceScriptRunner;
  agentSessions?: AgentSessionHistoryReader;
  agentStreams?: AgentStreamHistoryReader;
};

export type DesktopAgentToolRegistration = {
  refreshWorkspaceScriptTools(): Promise<WorkspaceScriptTool[]>;
  registeredWorkspaceScriptToolNames(): string[];
};

export function registerDesktopAgentTools(
  dependencies: AgentToolBootstrapDependencies,
): DesktopAgentToolRegistration {
  const rag = dependencies.rag ?? new SchemaRagEngine();
  const workspace = dependencies.workspace ?? new WorkspaceCore();
  const registeredScriptToolNames = new Set<string>();
  registerDatabaseTools({
    registry: dependencies.registry,
    driver: new ConnectionRoutingDatabaseDriver(
      dependencies.connections,
      dependencies.driverForEngine,
    ),
    getConnection: async (connectionId) =>
      (await dependencies.connections.list()).find(
        (connection) => connection.id === connectionId && connection.status === 'connected',
      ),
    rag,
  });
  registerWorkspaceTools({
    registry: dependencies.registry,
    workspace,
    getWorkspaceRoot: async () => (await dependencies.workspaceProjects.loadActive())?.rootPath,
  });
  registerAgentHistoryTools(dependencies);

  return {
    async refreshWorkspaceScriptTools() {
      unregisterWorkspaceScriptTools(dependencies.registry, registeredScriptToolNames);
      const activeWorkspace = await dependencies.workspaceProjects.loadActive();
      if (!activeWorkspace) return [];
      const scriptTools = await registerWorkspaceScriptTools({
        registry: dependencies.registry,
        workspace,
        getWorkspaceRoot: () => activeWorkspace.rootPath,
        runner: createWorkspaceScriptRunner(dependencies, activeWorkspace.rootPath),
      });
      for (const scriptTool of scriptTools) registeredScriptToolNames.add(scriptTool.name);
      return scriptTools;
    },
    registeredWorkspaceScriptToolNames() {
      return [...registeredScriptToolNames].sort();
    },
  };
}

function registerAgentHistoryTools(dependencies: AgentToolBootstrapDependencies): void {
  if (dependencies.agentSessions) {
    registerAgentSessionHistoryTools(dependencies.registry, dependencies.agentSessions);
  }
  if (dependencies.agentStreams) {
    registerAgentStreamHistoryTools(dependencies.registry, dependencies.agentStreams);
  }
}

function registerAgentSessionHistoryTools(
  registry: ToolRegistry,
  sessions: AgentSessionHistoryReader,
): void {
  registry.register(
    {
      name: 'list_agent_sessions',
      description:
        'List persisted Agent sessions with summary metadata. Use to find prior work or conversation context.',
      inputSchema: objectSchema({
        archived: { type: 'boolean' },
        query: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'list_agent_sessions',
    },
    async (args) => ({
      sessions: await sessions.list(buildSessionListFilter(args)),
    }),
  );

  registry.register(
    {
      name: 'read_agent_session',
      description:
        'Read a persisted Agent session, including recent messages and tool-call context.',
      inputSchema: objectSchema({
        sessionId: { type: 'string' },
        maxMessages: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'read_agent_session',
    },
    async (args) => {
      const sessionId = requireString(args, 'sessionId');
      const session = await sessions.load(sessionId);
      if (!session) throw new Error(`Agent session not found: ${sessionId}`);
      const maxMessages = optionalBoundedInteger(args, 'maxMessages', 100, 1, 500);
      const messages = session.messages.slice(Math.max(0, session.messages.length - maxMessages));
      return {
        id: session.id,
        title: session.title,
        mode: session.mode,
        strategy: session.strategy,
        tokenUsage: session.tokenUsage,
        aborted: session.aborted,
        messageCount: session.messages.length,
        returnedMessageCount: messages.length,
        omittedMessageCount: session.messages.length - messages.length,
        messages,
      };
    },
  );

  registry.register(
    {
      name: 'export_agent_session',
      description:
        'Export a persisted Agent session as markdown or JSON for reports, handoff, or audit review.',
      inputSchema: objectSchema({
        sessionId: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'json'] },
        maxChars: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'export_agent_session',
    },
    async (args) => {
      const sessionId = requireString(args, 'sessionId');
      const format = optionalExportFormat(args, 'format') ?? 'markdown';
      const maxChars = optionalBoundedInteger(args, 'maxChars', 16_000, 1, 100_000);
      const content = await sessions.export(sessionId, format);
      const truncated = content.length > maxChars;
      return {
        sessionId,
        format,
        charCount: content.length,
        truncated,
        content: truncated ? content.slice(0, maxChars) : content,
      };
    },
  );
}

function registerAgentStreamHistoryTools(
  registry: ToolRegistry,
  streams: AgentStreamHistoryReader,
): void {
  registry.register(
    {
      name: 'list_agent_streams',
      description:
        'List persisted stream records for an Agent session. Use to inspect generation status and failures.',
      inputSchema: objectSchema({
        sessionId: { type: 'string' },
        limit: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'list_agent_streams',
    },
    async (args) => {
      const sessionId = requireString(args, 'sessionId');
      const limit = optionalBoundedInteger(args, 'limit', 50, 1, 100);
      return {
        streams: (await streams.listBySession(sessionId)).slice(-limit).map(streamSummary),
      };
    },
  );

  registry.register(
    {
      name: 'list_recoverable_agent_streams',
      description:
        'List streaming or incomplete Agent stream records that may need recovery after interruption.',
      inputSchema: objectSchema({
        limit: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'list_recoverable_agent_streams',
    },
    async (args) => {
      const limit = optionalBoundedInteger(args, 'limit', 50, 1, 100);
      return {
        streams: (await streams.listRecoverable()).slice(0, limit).map(streamSummary),
      };
    },
  );

  registry.register(
    {
      name: 'read_agent_stream',
      description:
        'Read a persisted Agent stream record, optionally including recent stream chunks.',
      inputSchema: objectSchema({
        streamId: { type: 'string' },
        includeChunks: { type: 'boolean' },
        maxChunks: { type: 'number' },
        maxTextChars: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'official',
      sourceId: 'official.agent-session-history',
      originalName: 'read_agent_stream',
    },
    async (args) => {
      const streamId = requireString(args, 'streamId');
      const stream = await streams.load(streamId);
      if (!stream) throw new Error(`Agent stream not found: ${streamId}`);
      const maxTextChars = optionalBoundedInteger(args, 'maxTextChars', 16_000, 1_000, 100_000);
      const includeChunks = optionalBoolean(args, 'includeChunks') ?? false;
      const maxChunks = optionalBoundedInteger(args, 'maxChunks', 200, 1, 1_000);
      const textTruncated = stream.text.length > maxTextChars;
      const chunks = includeChunks
        ? stream.chunks.slice(Math.max(0, stream.chunks.length - maxChunks))
        : undefined;
      return {
        ...streamSummary(stream),
        text: textTruncated ? stream.text.slice(0, maxTextChars) : stream.text,
        textCharCount: stream.text.length,
        textTruncated,
        toolCalls: stream.toolCalls,
        usage: stream.usage,
        finalResponse: stream.finalResponse,
        errorMessage: stream.errorMessage,
        chunkCount: stream.chunks.length,
        ...(chunks === undefined
          ? {}
          : {
              returnedChunkCount: chunks.length,
              omittedChunkCount: stream.chunks.length - chunks.length,
              chunks,
            }),
      };
    },
  );
}

function unregisterWorkspaceScriptTools(
  registry: ToolRegistry,
  registeredScriptToolNames: Set<string>,
): void {
  for (const name of registeredScriptToolNames) registry.unregister(name);
  registeredScriptToolNames.clear();
}

function createWorkspaceScriptRunner(
  dependencies: AgentToolBootstrapDependencies,
  registeredRootPath: string,
): WorkspaceScriptRunner {
  return async (request) => {
    const activeWorkspace = await dependencies.workspaceProjects.loadActive();
    if (!activeWorkspace || activeWorkspace.rootPath !== registeredRootPath) {
      throw new Error('Workspace script tool is no longer active.');
    }
    const runScript = dependencies.scriptRunner ?? runWorkspacePythonScript;
    return runScript({
      ...request,
      ...resolveWorkspacePythonExecution(activeWorkspace.rootPath, activeWorkspace.python),
    });
  };
}

class ConnectionRoutingDatabaseDriver implements IDatabaseDriver {
  readonly capabilities: DatabaseCapabilities = {
    engine: 'postgres',
    supportsTransactions: true,
    supportsExplain: true,
    supportsSchemas: true,
  };

  constructor(
    private readonly connections: ConnectionReader,
    private readonly driverForEngine: (engine: DatabaseEngine) => IDatabaseDriver,
  ) {}

  async test(config: DatabaseConnectionConfig): Promise<Result<{ latencyMs: number }>> {
    return this.driverForEngine(config.engine).test(config);
  }

  async connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>> {
    return this.driverForEngine(config.engine).connect(config);
  }

  async disconnect(connectionId: ConnectionId): Promise<Result<void>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).disconnect(connectionId);
  }

  async execute(
    request: QueryRequest,
    connection: SavedConnection,
    observer?: QueryExecutionObserver,
  ): Promise<Result<QueryExecutionResult>> {
    return this.driverForEngine(connection.engine).execute(request, connection, observer);
  }

  async cancel(
    request: QueryCancelResponse,
    connection: SavedConnection,
  ): Promise<Result<QueryCancelResponse>> {
    const driver = this.driverForEngine(connection.engine);
    if (!driver.cancel) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_OPERATION',
          message: `Cancel is not supported for ${connection.engine}.`,
        },
      };
    }
    return driver.cancel(request, connection);
  }

  async listTables(connectionId: ConnectionId): Promise<Result<TableSummary[]>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).listTables(connectionId);
  }

  async describeTable(
    connectionId: ConnectionId,
    schema: string,
    table: string,
  ): Promise<Result<TableDetail>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).describeTable(connectionId, schema, table);
  }

  private async requireKnownConnection(connectionId: ConnectionId): Promise<SavedConnection> {
    const connection = (await this.connections.list()).find((item) => item.id === connectionId);
    if (!connection) throw new Error(`Connection is not registered: ${connectionId}`);
    return connection;
  }
}

function streamSummary(stream: AgentStreamRecord): Omit<
  AgentStreamRecord,
  'chunks' | 'text' | 'toolCalls' | 'finalResponse'
> & {
  textChars: number;
  toolCallCount: number;
  chunkCount: number;
} {
  const { chunks, text, toolCalls, finalResponse, ...summary } = stream;
  void finalResponse;
  return {
    ...summary,
    textChars: text.length,
    toolCallCount: toolCalls.length,
    chunkCount: chunks.length,
  };
}

function buildSessionListFilter(args: Record<string, unknown>): AgentSessionListFilter {
  const archived = optionalBoolean(args, 'archived');
  const query = optionalTrimmedString(args, 'query');
  return {
    ...(archived === undefined ? {} : { archived }),
    ...(query === undefined ? {} : { query }),
    limit: optionalBoundedInteger(args, 'limit', 20, 1, 100),
    offset: optionalBoundedInteger(args, 'offset', 0, 0, 10_000),
  };
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function optionalTrimmedString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}

function optionalBoundedInteger(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function optionalExportFormat(
  args: Record<string, unknown>,
  key: string,
): AgentSessionExportFormat | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === 'json' || value === 'markdown') return value;
  throw new Error(`${key} must be json or markdown.`);
}
