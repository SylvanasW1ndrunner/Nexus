import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  AnthropicProvider,
  LLM_PROVIDER_PRESETS,
  OpenAICompatibleProvider,
  createProviderFromPreset,
  getLlmProviderPreset,
  type LlmAsyncJob,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmGatewayResult,
  type LlmMetricsSnapshot,
  type LlmMessage,
  type LlmProvider,
  type LlmResponseFormat,
  type LlmTool,
  type RegisteredLlmModel,
} from '@dbagent/core-llm';
import {
  DatabaseAgentError,
  DatabaseAgentRuntime,
  DatabaseAccessRuntimeError,
  ResourceConflictError,
  asDatabaseAgentError,
  toAgentSessionView,
  toAiSqlAgentRunView,
  type ExecuteGeneratedOptions,
  type GenerateSqlInput,
  type GeneratedSqlRun,
  type IndexSchemaOptions,
  type LlmRuntimeCallOptions,
  type LlmRuntimeChatRequest,
  type PostgresConnectionInput,
  type RuntimeStatus,
  type SchemaIndexSnapshot,
  type SqlRunSnapshot,
  type ExecutedSqlRun,
  type ConnectionProfile,
  type AgentContextCheckpoint,
  type AgentApprovalRequest,
  type AgentRunRecord,
  type AgentSessionListInput,
  type AgentSessionListItem,
  type AgentSessionView,
  type AgentSkillCatalogEntry,
  type AgentSkillRefreshResult,
  type AiSqlAgentRun,
  type CompactAiSqlAgentSessionInput,
  type CompactAiSqlAgentSessionResult,
  type DatabaseAccessRuntime,
  type DatabaseCredential,
  type DatabaseOperationRequest,
  type QuerySubmission,
  type RunAiSqlAgentInput,
  type McpServerRegistrationInput,
  type McpServerStartSummary,
  type McpServerStopSummary,
  type McpServerSummary,
  type ResourceEventType,
  type ResourceKind,
  type ResourceQuery,
  type ResourceScope,
  type ResourceTraversalRequest,
} from '@dbagent/sdk';
import {
  ContractValidationError,
  parsePublicJson,
  stringifyPublicJson,
  type SavedConnection,
} from '@dbagent/shared';
import { WEB_UI_HTML } from './web-ui.js';

const MAX_BODY_BYTES = 1_048_576;
const MAX_AGENT_ITERATIONS = 64;
const MAX_TOOL_EXECUTION_MS = 300_000;
const RESOURCE_EVENT_TYPES = new Set<ResourceEventType>([
  'resource-created',
  'resource-updated',
  'resource-deleted',
  'resource-restored',
  'resource-bound',
  'relation-created',
  'relation-updated',
  'relation-deleted',
  'observation-recorded',
  'change-set-applied',
]);
export const DEFAULT_SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 3721;

export type LlmSetupInput = {
  protocol: 'openai-compatible' | 'anthropic-messages';
  baseUrl?: string;
  apiKey?: string;
  model: string;
  providerId?: string;
  presetId?: string;
  apiVersion?: string;
  allowUnauthenticated?: boolean;
};

export type DatabaseAgentRuntimePort = {
  readonly database?: DatabaseAccessRuntime;
  close?(): Promise<void>;
  configureProvider(provider: LlmProvider, model: string): void;
  connect(input: PostgresConnectionInput): Promise<SavedConnection>;
  disconnect(): Promise<void>;
  indexSchema(options?: IndexSchemaOptions): Promise<SchemaIndexSnapshot>;
  schemaStatus(): SchemaIndexSnapshot;
  status(): RuntimeStatus;
  generate(input: GenerateSqlInput): Promise<GeneratedSqlRun>;
  executeGenerated(runId: string, options?: ExecuteGeneratedOptions): Promise<ExecutedSqlRun>;
  reexecuteGenerated(runId: string, options?: ExecuteGeneratedOptions): Promise<ExecutedSqlRun>;
  getRun(runId: string): SqlRunSnapshot | undefined;
  runAgent?(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun>;
  getAgentRun?(runId: string): Promise<AgentRunRecord | undefined>;
  listAgentRuns?(sessionId?: string, limit?: number): Promise<AgentRunRecord[]>;
  steerAgentSession?(sessionId: string, message: string): boolean;
  listAgentSessions?(input?: AgentSessionListInput): Promise<AgentSessionListItem[]>;
  getAgentSession?(sessionId: string): Promise<AgentSessionView | undefined>;
  deleteAgentSession?(sessionId: string): Promise<boolean>;
  listAgentSkills?(): Promise<AgentSkillCatalogEntry[]>;
  refreshSkills?(): Promise<AgentSkillRefreshResult>;
  listAgentApprovals?(): AgentApprovalRequest[];
  resolveAgentApproval?(
    requestId: string,
    approved: boolean,
    options?: { resolvedBy?: string; reason?: string },
  ): boolean;
  listMcpServers?(): Promise<McpServerSummary[]>;
  upsertMcpServer?(input: McpServerRegistrationInput): Promise<McpServerSummary>;
  removeMcpServer?(serverId: string): Promise<boolean>;
  startMcpServer?(serverId: string): Promise<McpServerStartSummary>;
  stopMcpServer?(serverId: string): Promise<McpServerStopSummary>;
  compactAgentSession?(
    input: CompactAiSqlAgentSessionInput,
  ): Promise<CompactAiSqlAgentSessionResult>;
  agentContextCheckpoints?(sessionId: string, limit?: number): Promise<AgentContextCheckpoint[]>;
  llmModels?(): RegisteredLlmModel[];
  discoverLlmModels?(): Promise<RegisteredLlmModel[]>;
  llmMetrics?(): LlmMetricsSnapshot;
  llmChat?(
    request: LlmRuntimeChatRequest,
    options?: LlmRuntimeCallOptions,
  ): Promise<LlmChatResponse>;
  llmStream?(
    request: LlmRuntimeChatRequest,
    options?: LlmRuntimeCallOptions,
  ): AsyncIterable<LlmChatStreamEvent>;
  submitLlmBatch?(
    requests: LlmRuntimeChatRequest[],
    options?: LlmRuntimeCallOptions & { concurrency?: number },
  ): LlmAsyncJob<LlmGatewayResult>;
  getLlmJob?(id: string): LlmAsyncJob<LlmGatewayResult> | undefined;
  cancelLlmJob?(id: string): LlmAsyncJob<LlmGatewayResult> | undefined;
};

export type DatabaseAgentServerOptions = {
  runtime?: DatabaseAgentRuntimePort;
  createProvider?: (input: LlmSetupInput) => LlmProvider;
  /**
   * Allows REST clients to register and start process-backed stdio MCP servers.
   *
   * Disabled by default because a stdio MCP command executes with the server
   * process privileges. SDK and interactive CLI MCP usage are not affected.
   */
  allowProcessMcpManagement?: boolean;
};

export type StartDatabaseAgentServerOptions = DatabaseAgentServerOptions & {
  host?: string;
  port?: number;
};

export type StartedDatabaseAgentServer = {
  server: Server;
  runtime: DatabaseAgentRuntimePort;
  host: string;
  port: number;
  url: string;
  /** Stops accepting requests and waits for the runtime to release all resources. */
  close: () => Promise<void>;
};

type ServerRequestPolicy = {
  allowProcessMcpManagement: boolean;
  shutdownSignal: AbortSignal;
};

class ServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServerRequestError';
  }
}

export function createDatabaseAgentServer(options: DatabaseAgentServerOptions = {}): {
  server: Server;
  runtime: DatabaseAgentRuntimePort;
  close: () => Promise<void>;
} {
  const runtime = options.runtime ?? new DatabaseAgentRuntime();
  const createProvider = options.createProvider ?? defaultProviderFactory;
  const shutdownController = new AbortController();
  const requestPolicy: ServerRequestPolicy = {
    allowProcessMcpManagement: options.allowProcessMcpManagement === true,
    shutdownSignal: shutdownController.signal,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime, createProvider, requestPolicy);
  });
  let runtimeClosePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => {
    runtimeClosePromise ??= closeDatabaseAgentRuntime(runtime);
    return runtimeClosePromise;
  };
  const closeHttpServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    shutdownController.abort();
    void closeRuntime().catch(() => undefined);
    server.closeAllConnections();
    return closeHttpServer(callback);
  };
  server.on('close', () => {
    shutdownController.abort();
    // Low-level callers may still close the Node server directly. Start the
    // same idempotent cleanup path; the public close() method below awaits it
    // and reports failures to its caller.
    void closeRuntime().catch(() => undefined);
  });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let closeServer = Promise.resolve();
      if (server.listening) {
        closeServer = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      shutdownController.abort();
      server.closeAllConnections();
      const results = await Promise.allSettled([closeRuntime(), closeServer]);
      const failures: unknown[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          const reason: unknown = result.reason;
          failures.push(reason);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'SchemaNaut server did not close cleanly.');
      }
    })();
    return closePromise;
  };
  return { server, runtime, close };
}

export async function startDatabaseAgentServer(
  options: StartDatabaseAgentServerOptions = {},
): Promise<StartedDatabaseAgentServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DatabaseAgentError('INVALID_INPUT', 'port 必须是 0 到 65535 之间的整数。');
  }
  const { server, runtime, close } = createDatabaseAgentServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  return {
    server,
    runtime,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close,
  };
}

async function closeDatabaseAgentRuntime(runtime: DatabaseAgentRuntimePort): Promise<void> {
  if (runtime.close) {
    await runtime.close();
    return;
  }

  const failures: unknown[] = [];
  try {
    await runtime.disconnect();
  } catch (error) {
    failures.push(error);
  }
  try {
    await runtime.database?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'SchemaNaut server runtime did not close cleanly.');
  }
}

function bindRequestLifetime(
  request: IncomingMessage,
  response: ServerResponse,
  shutdownSignal: AbortSignal,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', abort);
  shutdownSignal.addEventListener('abort', abort, { once: true });
  if (request.aborted || response.destroyed || shutdownSignal.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      request.off('aborted', abort);
      response.off('close', abort);
      shutdownSignal.removeEventListener('abort', abort);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DatabaseAgentRuntimePort,
  createProvider: (input: LlmSetupInput) => LlmProvider,
  policy: ServerRequestPolicy,
): Promise<void> {
  setSecurityHeaders(response);
  try {
    validateLocalRequest(request);
    const method = request.method ?? 'GET';
    validateJsonContentType(request, method);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (method === 'GET' && url.pathname === '/') {
      sendHtml(response, WEB_UI_HTML);
      return;
    }
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'schemanaut-server', version: '0.1.0' });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/capabilities') {
      sendJson(response, 200, {
        databases: ['postgres'],
        llmProtocols: ['openai-compatible', 'anthropic-messages'],
        llmOperations: [
          'chat',
          'stream',
          'async-batch',
          'tool-calling',
          'structured-output',
          'embeddings',
          'rerank',
        ],
        agentOperations: [
          'run',
          'semantic-event-stream',
          'session-list-load-delete',
          'active-run-steering',
          'approval-resolution',
          'skills-discovery',
          'mcp-lifecycle',
          'automatic-context-compaction',
          'manual-context-compaction',
          'context-checkpoint-history',
        ],
        surfaces: ['typescript-sdk', 'rest', 'cli', 'webui'],
        safety: {
          permissionModes: ['read', 'edit', 'full'],
          oneTimeApproval: true,
          sqlClassifiedByAst: true,
          restProcessMcpManagement: policy.allowProcessMcpManagement,
        },
        limits: {
          defaultRows: 200,
          maxRows: 1000,
          maxRequestBytes: MAX_BODY_BYTES,
          maxAgentIterations: MAX_AGENT_ITERATIONS,
          maxToolExecutionMs: MAX_TOOL_EXECUTION_MS,
        },
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/llm/provider-presets') {
      sendJson(response, 200, LLM_PROVIDER_PRESETS);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/llm/models') {
      sendJson(response, 200, runtime.llmModels?.() ?? []);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/llm/metrics') {
      sendJson(response, 200, runtime.llmMetrics?.() ?? emptyLlmMetrics());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/setup') {
      const body = requireRecord(await readJson(request), 'request');
      const llm = parseLlmSetup(body.llm === undefined ? body : requireRecord(body.llm, 'llm'));
      const provider = createProvider(llm);
      runtime.configureProvider(provider, llm.model);
      const models = runtime.discoverLlmModels
        ? await runtime.discoverLlmModels()
        : (runtime.llmModels?.() ?? []);
      sendJson(response, 200, {
        providerId: provider.id,
        protocol: provider.protocol ?? llm.protocol,
        model: llm.model,
        models,
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/chat') {
      if (!runtime.llmChat)
        throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM chat is unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const parsed = parseLlmChatBody(body);
      const lifetime = bindRequestLifetime(request, response, policy.shutdownSignal);
      try {
        const result = await runtime.llmChat(
          { ...parsed.request, signal: lifetime.signal },
          parsed.options,
        );
        if (!lifetime.signal.aborted) sendJson(response, 200, result);
      } finally {
        lifetime.dispose();
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/chat/stream') {
      if (!runtime.llmStream)
        throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM streaming is unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const parsed = parseLlmChatBody(body);
      const lifetime = bindRequestLifetime(request, response, policy.shutdownSignal);
      try {
        await sendLlmStream(
          response,
          runtime.llmStream({ ...parsed.request, signal: lifetime.signal }, parsed.options),
        );
      } finally {
        lifetime.dispose();
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/jobs') {
      if (!runtime.submitLlmBatch)
        throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM batch jobs are unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const values = body.requests;
      if (!Array.isArray(values) || values.length === 0 || values.length > 1_000) {
        throw new DatabaseAgentError(
          'INVALID_INPUT',
          'requests must contain between 1 and 1000 items.',
        );
      }
      const parsed = values.map((value) => parseLlmChatBody(requireRecord(value, 'request item')));
      const concurrency = optionalInteger(body, 'concurrency');
      const options = parsed[0]?.options ?? {};
      sendJson(
        response,
        202,
        runtime.submitLlmBatch(
          parsed.map((item) => item.request),
          { ...options, ...(concurrency === undefined ? {} : { concurrency }) },
        ),
      );
      return;
    }
    const llmJobMatch = url.pathname.match(/^\/v1\/llm\/jobs\/([^/]+)$/);
    if (llmJobMatch?.[1] && method === 'GET') {
      const job = runtime.getLlmJob?.(decodeURIComponent(llmJobMatch[1]));
      if (!job) throw new DatabaseAgentError('RUN_NOT_FOUND', 'LLM job was not found.');
      sendJson(response, 200, job);
      return;
    }
    if (llmJobMatch?.[1] && method === 'DELETE') {
      const job = runtime.cancelLlmJob?.(decodeURIComponent(llmJobMatch[1]));
      if (!job) throw new DatabaseAgentError('RUN_NOT_FOUND', 'LLM job was not found.');
      sendJson(response, 200, job);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/status') {
      sendJson(response, 200, runtime.status());
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/database/connectors') {
      sendJson(response, 200, requireDatabaseRuntime(runtime).connectors.list());
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/database/profiles') {
      sendJson(response, 200, requireDatabaseRuntime(runtime).listProfiles());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/profiles') {
      const body = requireRecord(await readJson(request), 'request');
      const rawProfile = body.profile === undefined ? body : requireRecord(body.profile, 'profile');
      const profile = parseConnectionProfile(rawProfile);
      sendJson(response, 201, requireDatabaseRuntime(runtime).createProfile(profile));
      return;
    }
    const profileMatch = url.pathname.match(/^\/v1\/database\/profiles\/([^/]+)$/);
    if (profileMatch?.[1] && method === 'GET') {
      const database = requireDatabaseRuntime(runtime);
      const profile = database.getProfile(decodeURIComponent(profileMatch[1]));
      if (!profile) {
        throw new DatabaseAccessRuntimeError({
          code: 'PROFILE_NOT_FOUND',
          category: 'not-found',
          message: 'Connection profile was not found.',
          stage: 'profile',
          retryable: false,
          outcome: 'unchanged',
        });
      }
      sendJson(response, 200, profile);
      return;
    }
    if (profileMatch?.[1] && method === 'PATCH') {
      const body = requireRecord(await readJson(request), 'request');
      const profileId = decodeURIComponent(profileMatch[1]);
      const database = requireDatabaseRuntime(runtime);
      const current = database.getProfile(profileId);
      if (!current) {
        throw new DatabaseAccessRuntimeError({
          code: 'PROFILE_NOT_FOUND',
          category: 'not-found',
          message: 'Connection profile was not found.',
          stage: 'profile',
          retryable: false,
          outcome: 'unchanged',
        });
      }
      const merged = parseConnectionProfile({
        ...current,
        ...body,
        id: current.id,
        createdAt: current.createdAt,
      });
      const { id: _id, createdAt: _createdAt, ...changes } = merged;
      void _id;
      void _createdAt;
      sendJson(response, 200, database.updateProfile(profileId, changes));
      return;
    }
    if (profileMatch?.[1] && method === 'DELETE') {
      const deleted = requireDatabaseRuntime(runtime).deleteProfile(
        decodeURIComponent(profileMatch[1]),
      );
      sendJson(response, deleted ? 200 : 404, { deleted });
      return;
    }
    const profileActionMatch = url.pathname.match(
      /^\/v1\/database\/profiles\/([^/]+)\/(test|connect|reconnect|disconnect|health|capabilities|discover)$/,
    );
    if (profileActionMatch?.[1] && profileActionMatch[2]) {
      const database = requireDatabaseRuntime(runtime);
      const profileId = decodeURIComponent(profileActionMatch[1]);
      const action = profileActionMatch[2];
      if (method === 'GET' && action === 'health') {
        sendJson(response, 200, await database.health(profileId));
        return;
      }
      if (method === 'GET' && action === 'capabilities') {
        sendJson(response, 200, await database.capabilities(profileId));
        return;
      }
      if (method === 'POST') {
        const body = await readOptionalJson(request);
        const credential = parseOptionalCredential(body.credential);
        if (action === 'test') {
          sendJson(response, 200, await database.testProfile(profileId, credential));
          return;
        }
        if (action === 'connect') {
          sendJson(response, 200, await database.connect(profileId, credential));
          return;
        }
        if (action === 'reconnect') {
          sendJson(response, 200, await database.reconnect(profileId, credential));
          return;
        }
        if (action === 'disconnect') {
          await database.disconnect(profileId);
          sendJson(response, 200, { disconnected: true });
          return;
        }
        if (action === 'discover') {
          const pageSize = optionalInteger(body, 'pageSize');
          const maxPages = optionalInteger(body, 'maxPages');
          const kinds = parseOptionalStringArray(body.kinds, 'kinds', 100);
          const incrementalSince = optionalString(body, 'incrementalSince');
          sendJson(
            response,
            200,
            await database.discoverAll(profileId, {
              ...(pageSize === undefined ? {} : { pageSize }),
              ...(maxPages === undefined ? {} : { maxPages }),
              ...(kinds === undefined ? {} : { kinds }),
              ...(incrementalSince === undefined ? {} : { incrementalSince }),
            }),
          );
          return;
        }
      }
    }
    if (
      method === 'GET' &&
      (url.pathname === '/v1/resources' || url.pathname === '/v1/database/resources')
    ) {
      const resources = requireDatabaseRuntime(runtime).resources;
      const { scope, ...query } = parseResourceQuery(url);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      sendJson(response, 200, resourceView.query(query));
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/resources/traverse') {
      const requestBody = requireRecord(await readJson(request), 'request');
      const resources = requireDatabaseRuntime(runtime).resources;
      const { scope, ...traversal } = parseResourceTraversal(requestBody);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      sendJson(response, 200, resourceView.traverse(traversal));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/resource-events') {
      const eventTypes = parseResourceEventTypes(url);
      const resources = requireDatabaseRuntime(runtime).resources;
      const scope = parseResourceScopeFromUrl(url);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      sendJson(
        response,
        200,
        resourceView.events({
          ...(url.searchParams.get('resourceId')
            ? { resourceId: url.searchParams.get('resourceId') as string }
            : {}),
          ...(eventTypes === undefined ? {} : { types: eventTypes }),
          ...(url.searchParams.get('afterSequence') === null
            ? {}
            : {
                afterSequence: parseUrlInteger(
                  url.searchParams.get('afterSequence') as string,
                  'afterSequence',
                ),
              }),
          ...(url.searchParams.get('limit') === null
            ? {}
            : {
                limit: parsePositiveUrlInteger(url.searchParams.get('limit') as string, 'limit'),
              }),
        }),
      );
      return;
    }
    const resourceRelationsMatch = url.pathname.match(
      /^\/v1\/(?:database\/)?resources\/([^/]+)\/relations$/,
    );
    if (resourceRelationsMatch?.[1] && method === 'GET') {
      const resourceId = decodeURIComponent(resourceRelationsMatch[1]);
      const direction = url.searchParams.get('direction') ?? undefined;
      const relationKinds = parseCommaSeparatedQuery(url, 'kinds');
      const includeDeleted = parseOptionalUrlBoolean(url, 'includeDeleted');
      const scope = parseResourceScopeFromUrl(url);
      const resources = requireDatabaseRuntime(runtime).resources;
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      if (direction !== undefined && !['outgoing', 'incoming', 'both'].includes(direction)) {
        throw new DatabaseAgentError('INVALID_INPUT', 'direction is invalid.');
      }
      if (!resourceView.getResource(resourceId, includeDeleted ?? false)) throwResourceNotFound();
      sendJson(
        response,
        200,
        resourceView.relationsFor(resourceId, {
          ...(direction === undefined
            ? {}
            : {
                direction: direction as 'outgoing' | 'incoming' | 'both',
              }),
          ...(relationKinds === undefined ? {} : { kinds: relationKinds }),
          ...(includeDeleted === undefined ? {} : { includeDeleted }),
        }),
      );
      return;
    }
    const resourceStateMatch = url.pathname.match(/^\/v1\/resources\/([^/]+)\/state$/);
    if (resourceStateMatch?.[1] && method === 'GET') {
      const resources = requireDatabaseRuntime(runtime).resources;
      const scope = parseResourceScopeFromUrl(url);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      const state = resourceView.state(decodeURIComponent(resourceStateMatch[1]), {
        ...(url.searchParams.get('asOf') ? { asOf: url.searchParams.get('asOf') as string } : {}),
      });
      if (!state) throwResourceNotFound();
      sendJson(response, 200, state);
      return;
    }
    const resourceObservationsMatch = url.pathname.match(
      /^\/v1\/resources\/([^/]+)\/observations$/,
    );
    if (resourceObservationsMatch?.[1] && method === 'GET') {
      const resourceId = decodeURIComponent(resourceObservationsMatch[1]);
      const resources = requireDatabaseRuntime(runtime).resources;
      const scope = parseResourceScopeFromUrl(url);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      const includeExpired = parseOptionalUrlBoolean(url, 'includeExpired');
      if (!resourceView.getResource(resourceId, true)) throwResourceNotFound();
      sendJson(
        response,
        200,
        resourceView.observationsFor(resourceId, {
          ...(includeExpired === undefined ? {} : { includeExpired }),
          ...(url.searchParams.get('category')
            ? { category: url.searchParams.get('category') as string }
            : {}),
          ...(url.searchParams.get('at') ? { at: url.searchParams.get('at') as string } : {}),
          ...(url.searchParams.get('limit') === null
            ? {}
            : {
                limit: parsePositiveUrlInteger(url.searchParams.get('limit') as string, 'limit'),
              }),
        }),
      );
      return;
    }
    const resourceMatch = url.pathname.match(/^\/v1\/(?:database\/)?resources\/([^/]+)$/);
    if (resourceMatch?.[1] && method === 'GET') {
      const resources = requireDatabaseRuntime(runtime).resources;
      const scope = parseResourceScopeFromUrl(url);
      const resourceView = scope === undefined ? resources : resources.scoped(scope);
      const resource = resourceView.getResource(
        decodeURIComponent(resourceMatch[1]),
        parseOptionalUrlBoolean(url, 'includeDeleted') ?? false,
      );
      if (!resource) throwResourceNotFound();
      sendJson(response, 200, resource);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/queries') {
      const submission = parseQuerySubmission(requireRecord(await readJson(request), 'request'));
      const job = await requireDatabaseRuntime(runtime).submit(submission);
      sendJson(response, job.state === 'queued' || job.state === 'submitted' ? 202 : 200, job);
      return;
    }
    const databaseJobMatch = url.pathname.match(/^\/v1\/database\/queries\/([^/]+)$/);
    if (databaseJobMatch?.[1] && method === 'GET') {
      sendJson(
        response,
        200,
        await requireDatabaseRuntime(runtime).getJob(decodeURIComponent(databaseJobMatch[1])),
      );
      return;
    }
    if (databaseJobMatch?.[1] && method === 'DELETE') {
      sendJson(
        response,
        200,
        await requireDatabaseRuntime(runtime).cancel(decodeURIComponent(databaseJobMatch[1])),
      );
      return;
    }
    const databaseResultMatch = url.pathname.match(/^\/v1\/database\/results\/([^/]+)$/);
    if (databaseResultMatch?.[1] && method === 'GET') {
      const limitText = url.searchParams.get('limit');
      sendJson(
        response,
        200,
        await requireDatabaseRuntime(runtime).readResult(
          decodeURIComponent(databaseResultMatch[1]),
          {
            ...(url.searchParams.get('cursor')
              ? { cursor: url.searchParams.get('cursor') as string }
              : {}),
            ...(limitText === null ? {} : { limit: parseUrlInteger(limitText, 'limit') }),
          },
        ),
      );
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/transactions') {
      const body = requireRecord(await readJson(request), 'request');
      const profileId = requireString(body, 'profileId');
      const isolationLevel = optionalString(body, 'isolationLevel');
      if (
        isolationLevel &&
        !['read-uncommitted', 'read-committed', 'repeatable-read', 'serializable'].includes(
          isolationLevel,
        )
      ) {
        throw new DatabaseAgentError('INVALID_INPUT', 'isolationLevel is invalid.');
      }
      const readOnly = optionalBoolean(body, 'readOnly');
      sendJson(
        response,
        201,
        await requireDatabaseRuntime(runtime).beginTransaction(profileId, {
          ...(isolationLevel
            ? {
                isolationLevel: isolationLevel as
                  | 'read-uncommitted'
                  | 'read-committed'
                  | 'repeatable-read'
                  | 'serializable',
              }
            : {}),
          ...(readOnly === undefined ? {} : { readOnly }),
        }),
      );
      return;
    }
    const transactionActionMatch = url.pathname.match(
      /^\/v1\/database\/transactions\/([^/]+)\/(savepoints|rollback-to-savepoint|commit|rollback)$/,
    );
    if (transactionActionMatch?.[1] && transactionActionMatch[2] && method === 'POST') {
      const database = requireDatabaseRuntime(runtime);
      const transactionId = decodeURIComponent(transactionActionMatch[1]);
      const action = transactionActionMatch[2];
      if (action === 'commit') {
        sendJson(response, 200, await database.commitTransaction(transactionId));
        return;
      }
      if (action === 'rollback') {
        sendJson(response, 200, await database.rollbackTransaction(transactionId));
        return;
      }
      const body = requireRecord(await readJson(request), 'request');
      const name = requireString(body, 'name');
      sendJson(
        response,
        200,
        action === 'savepoints'
          ? await database.createSavepoint(transactionId, name)
          : await database.rollbackToSavepoint(transactionId, name),
      );
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/observations') {
      const body = requireRecord(await readJson(request), 'request');
      const profileId = requireString(body, 'profileId');
      const resourceId = optionalString(body, 'resourceId');
      const categories = parseOptionalStringArray(body.categories, 'categories', 100);
      sendJson(
        response,
        200,
        await requireDatabaseRuntime(runtime).observe({
          profileId,
          ...(resourceId === undefined ? {} : { resourceId }),
          ...(categories === undefined ? {} : { categories }),
        }),
      );
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/operations') {
      const operation = parseDatabaseOperation(requireRecord(await readJson(request), 'request'));
      sendJson(response, 200, await requireDatabaseRuntime(runtime).operate(operation));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/database/audit') {
      const limitText = url.searchParams.get('limit');
      sendJson(
        response,
        200,
        requireDatabaseRuntime(runtime).listAuditEvents({
          ...(url.searchParams.get('profileId')
            ? { profileId: url.searchParams.get('profileId') as string }
            : {}),
          ...(limitText === null ? {} : { limit: parseUrlInteger(limitText, 'limit') }),
        }),
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/database/metrics') {
      sendJson(response, 200, requireDatabaseRuntime(runtime).metrics());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/setup') {
      const body = requireRecord(await readJson(request), 'request');
      const llm = parseLlmSetup(requireRecord(body.llm, 'llm'));
      const database = parseDatabaseSetup(requireRecord(body.database, 'database'));
      const provider = createProvider(llm);
      runtime.configureProvider(provider, llm.model);
      await runtime.discoverLlmModels?.();
      const connection = await runtime.connect(database);
      sendJson(response, 200, {
        provider: {
          id: provider.id,
          protocol: provider.protocol ?? llm.protocol,
          model: llm.model,
        },
        connection,
        schema: runtime.schemaStatus(),
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/connect') {
      const body = requireRecord(await readJson(request), 'request');
      const database = parseDatabaseSetup(
        body.database === undefined ? body : requireRecord(body.database, 'database'),
      );
      const connection = await runtime.connect(database);
      sendJson(response, 200, { connection, schema: runtime.schemaStatus() });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/schema/index') {
      const body = await readOptionalJson(request);
      const maxTables = optionalInteger(body, 'maxTables');
      const result = await runtime.indexSchema(maxTables === undefined ? {} : { maxTables });
      sendJson(response, 200, result);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/schema/status') {
      sendJson(response, 200, runtime.schemaStatus());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/agent/run/stream') {
      if (!runtime.runAgent) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 AI SQL Agent。', true);
      }
      const body = requireRecord(await readJson(request), 'request');
      const lifetime = bindRequestLifetime(request, response, policy.shutdownSignal);
      try {
        await sendAgentRunStream(response, runtime.runAgent.bind(runtime), {
          ...parseAgentRunBody(body),
          signal: lifetime.signal,
        });
      } finally {
        lifetime.dispose();
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/agent/run') {
      if (!runtime.runAgent) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 AI SQL Agent。', true);
      }
      const body = requireRecord(await readJson(request), 'request');
      const lifetime = bindRequestLifetime(request, response, policy.shutdownSignal);
      try {
        const result = await runtime.runAgent({
          ...parseAgentRunBody(body),
          signal: lifetime.signal,
        });
        if (!lifetime.signal.aborted) sendJson(response, 200, toAiSqlAgentRunView(result));
      } finally {
        lifetime.dispose();
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/agent/runs') {
      if (!runtime.listAgentRuns) {
        throw new DatabaseAgentError(
          'NOT_CONFIGURED',
          '当前 Runtime 未启用 Agent Run 管理。',
          true,
        );
      }
      const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
      const limitText = url.searchParams.get('limit');
      const limit =
        limitText === null ? undefined : parsePositiveUrlInteger(limitText, 'limit');
      if (limit !== undefined && limit > 1_000) {
        throw new DatabaseAgentError('INVALID_INPUT', 'limit 不能超过 1000。', false);
      }
      sendJson(response, 200, await runtime.listAgentRuns(sessionId, limit));
      return;
    }
    const agentRunMatch =
      method === 'GET' ? url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)$/) : null;
    if (agentRunMatch?.[1]) {
      if (!runtime.getAgentRun) {
        throw new DatabaseAgentError(
          'NOT_CONFIGURED',
          '当前 Runtime 未启用 Agent Run 管理。',
          true,
        );
      }
      const run = await runtime.getAgentRun(decodeURIComponent(agentRunMatch[1]));
      if (!run) {
        throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定 Agent Run。', false);
      }
      sendJson(response, 200, run);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/agent/sessions') {
      if (!runtime.listAgentSessions) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 Session 管理。', true);
      }
      const limitText = url.searchParams.get('limit');
      const offsetText = url.searchParams.get('offset');
      const archived = parseOptionalUrlBoolean(url, 'archived');
      const input: AgentSessionListInput = {
        ...(url.searchParams.get('userId')
          ? { userId: url.searchParams.get('userId') as string }
          : {}),
        ...(url.searchParams.get('query')
          ? { query: url.searchParams.get('query') as string }
          : {}),
        ...(archived === undefined ? {} : { archived }),
        ...(limitText === null ? {} : { limit: parsePositiveUrlInteger(limitText, 'limit') }),
        ...(offsetText === null
          ? {}
          : { offset: parseNonNegativeUrlInteger(offsetText, 'offset') }),
      };
      sendJson(response, 200, await runtime.listAgentSessions(input));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/agent/skills') {
      if (!runtime.listAgentSkills) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 Skills。', true);
      }
      sendJson(response, 200, await runtime.listAgentSkills());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/agent/skills/refresh') {
      if (!runtime.refreshSkills) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 Skills。', true);
      }
      const refreshed = await runtime.refreshSkills();
      sendJson(response, 200, {
        changed: refreshed.changed,
        revision: refreshed.revision,
        skills: refreshed.skills,
        issueCount: refreshed.issues.length,
        conflictCount: refreshed.conflicts.length,
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/agent/approvals') {
      if (!runtime.listAgentApprovals) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用许可请求。', true);
      }
      sendJson(response, 200, runtime.listAgentApprovals());
      return;
    }
    const approvalMatch = url.pathname.match(/^\/v1\/agent\/approvals\/([^/]+)\/resolve$/);
    if (method === 'POST' && approvalMatch?.[1]) {
      if (!runtime.resolveAgentApproval) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用许可请求。', true);
      }
      const body = requireRecord(await readJson(request), 'request');
      const approved = requireBoolean(body, 'approved');
      const resolvedBy = optionalString(body, 'resolvedBy');
      const reason = optionalString(body, 'reason');
      const resolved = runtime.resolveAgentApproval(
        decodeURIComponent(approvalMatch[1]),
        approved,
        {
          ...(resolvedBy === undefined ? {} : { resolvedBy }),
          ...(reason === undefined ? {} : { reason }),
        },
      );
      if (!resolved) {
        throw new DatabaseAgentError('INVALID_INPUT', '许可请求不存在或已经处理。', false);
      }
      sendJson(response, 200, { resolved: true, approved });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/agent/mcp') {
      if (!runtime.listMcpServers) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 MCP。', true);
      }
      sendJson(response, 200, await runtime.listMcpServers());
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/agent/mcp') {
      if (!runtime.upsertMcpServer) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 MCP。', true);
      }
      const body = requireRecord(await readJson(request), 'request');
      const input = parseMcpServerInput(body);
      assertProcessMcpManagementAllowed(
        input.transport ?? 'stdio',
        policy.allowProcessMcpManagement,
      );
      sendJson(response, 201, await runtime.upsertMcpServer(input));
      return;
    }
    const mcpActionMatch = url.pathname.match(/^\/v1\/agent\/mcp\/([^/]+)\/(start|stop)$/);
    if (method === 'POST' && mcpActionMatch?.[1] && mcpActionMatch[2]) {
      const serverId = decodeURIComponent(mcpActionMatch[1]);
      if (mcpActionMatch[2] === 'start') {
        if (!runtime.startMcpServer) {
          throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 MCP。', true);
        }
        if (!policy.allowProcessMcpManagement) {
          if (!runtime.listMcpServers) {
            throw processMcpForbidden();
          }
          const registered = (await runtime.listMcpServers()).find(
            (server) => server.id === serverId,
          );
          if (!registered) {
            throw new DatabaseAgentError('RUN_NOT_FOUND', 'MCP server was not found.', false);
          }
          assertProcessMcpManagementAllowed(registered.transport, policy.allowProcessMcpManagement);
        }
        sendJson(response, 200, await runtime.startMcpServer(serverId));
        return;
      }
      if (!runtime.stopMcpServer) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 MCP。', true);
      }
      sendJson(response, 200, await runtime.stopMcpServer(serverId));
      return;
    }
    const mcpServerMatch = url.pathname.match(/^\/v1\/agent\/mcp\/([^/]+)$/);
    if (method === 'DELETE' && mcpServerMatch?.[1]) {
      if (!runtime.removeMcpServer) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 MCP。', true);
      }
      const removed = await runtime.removeMcpServer(decodeURIComponent(mcpServerMatch[1]));
      sendJson(response, removed ? 200 : 404, { removed });
      return;
    }
    const steerSessionMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/steer$/);
    if (method === 'POST' && steerSessionMatch?.[1]) {
      if (!runtime.steerAgentSession) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用任务追加输入。', true);
      }
      const body = requireRecord(await readJson(request), 'request');
      const accepted = runtime.steerAgentSession(
        decodeURIComponent(steerSessionMatch[1]),
        requireString(body, 'message'),
      );
      sendJson(response, accepted ? 202 : 409, {
        accepted,
        ...(accepted ? {} : { reason: 'no-active-run' }),
      });
      return;
    }
    const compactSessionMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/compact$/);
    if (method === 'POST' && compactSessionMatch?.[1]) {
      if (!runtime.compactAgentSession) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用上下文压缩。', true);
      }
      const body = await readOptionalJson(request);
      const focus = optionalString(body, 'focus');
      const result = await runtime.compactAgentSession({
        sessionId: decodeURIComponent(compactSessionMatch[1]),
        ...(focus === undefined ? {} : { focus }),
      });
      sendJson(response, 200, toPublicCompactionResult(result));
      return;
    }
    const checkpointMatch = url.pathname.match(
      /^\/v1\/agent\/sessions\/([^/]+)\/context-checkpoints$/,
    );
    if (method === 'GET' && checkpointMatch?.[1]) {
      if (!runtime.agentContextCheckpoints) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用上下文检查点。', true);
      }
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? undefined : Number.parseInt(limitText, 10);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new DatabaseAgentError('INVALID_INPUT', 'limit 必须是正整数。', false);
      }
      sendJson(
        response,
        200,
        (await runtime.agentContextCheckpoints(decodeURIComponent(checkpointMatch[1]), limit)).map(
          toPublicContextCheckpoint,
        ),
      );
      return;
    }
    const agentSessionMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)$/);
    if (agentSessionMatch?.[1] && (method === 'GET' || method === 'DELETE')) {
      const sessionId = decodeURIComponent(agentSessionMatch[1]);
      if (method === 'GET') {
        if (!runtime.getAgentSession) {
          throw new DatabaseAgentError(
            'NOT_CONFIGURED',
            '当前 Runtime 未启用 Session 管理。',
            true,
          );
        }
        const session = await runtime.getAgentSession(sessionId);
        if (!session) {
          throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定 Session。', false);
        }
        sendJson(response, 200, toPublicAgentSessionView(session));
        return;
      }
      if (!runtime.deleteAgentSession) {
        throw new DatabaseAgentError('NOT_CONFIGURED', '当前 Runtime 未启用 Session 管理。', true);
      }
      const deleted = await runtime.deleteAgentSession(sessionId);
      sendJson(response, deleted ? 200 : 404, { deleted });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query/generate') {
      const body = requireRecord(await readJson(request), 'request');
      const question = requireString(body, 'question');
      const maxContextChars = optionalInteger(body, 'maxContextChars');
      const result = await runtime.generate({
        question,
        ...(maxContextChars === undefined ? {} : { maxContextChars }),
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query/execute') {
      const body = requireRecord(await readJson(request), 'request');
      const runId = requireString(body, 'runId');
      const limit = optionalInteger(body, 'limit');
      const result = await runtime.executeGenerated(runId, limit === undefined ? {} : { limit });
      sendJson(response, 200, result);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query/reexecute') {
      const body = requireRecord(await readJson(request), 'request');
      const runId = requireString(body, 'runId');
      const limit = optionalInteger(body, 'limit');
      const result = await runtime.reexecuteGenerated(
        runId,
        limit === undefined ? {} : { limit },
      );
      sendJson(response, 200, result);
      return;
    }
    const runMatch = method === 'GET' ? url.pathname.match(/^\/v1\/runs\/([^/]+)$/) : null;
    if (runMatch?.[1]) {
      const run = runtime.getRun(decodeURIComponent(runMatch[1]));
      if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。');
      sendJson(response, 200, run);
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: '接口不存在。', retryable: false },
    });
  } catch (error) {
    if (error instanceof ServerRequestError) {
      sendJson(response, error.status, {
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
        },
      });
      return;
    }
    if (error instanceof ContractValidationError) {
      sendJson(response, 400, {
        error: {
          code: 'CONTRACT_VALIDATION_FAILED',
          message: 'The public request contract is invalid.',
          retryable: false,
          issues: redactPublicErrorValue(error.issues),
        },
      });
      return;
    }
    if (error instanceof ResourceConflictError) {
      sendJson(
        response,
        ['RESOURCE_CONFLICT', 'RELATION_CYCLE', 'STALE_CHANGE_SET'].includes(error.code)
          ? 409
          : 400,
        {
          error: {
            code: error.code,
            message: sanitizePublicErrorMessage(error.message),
            retryable: false,
          },
        },
      );
      return;
    }
    if (error instanceof DatabaseAccessRuntimeError) {
      sendJson(response, statusForDatabaseError(error), { error: toPublicDatabaseError(error) });
      return;
    }
    const normalized = asDatabaseAgentError(error);
    sendJson(response, statusForError(normalized), {
      error: {
        code: normalized.code,
        message:
          normalized.code === 'INTERNAL_ERROR'
            ? 'Internal server error.'
            : sanitizePublicErrorMessage(normalized.message),
        retryable: normalized.retryable,
      },
    });
  }
}

function parseAgentRunBody(body: Record<string, unknown>): RunAiSqlAgentInput {
  const mode = optionalString(body, 'mode');
  if (mode && mode !== 'read' && mode !== 'edit' && mode !== 'full') {
    throw new DatabaseAgentError('INVALID_INPUT', 'mode 必须是 read、edit 或 full。', false);
  }
  const sessionId = optionalString(body, 'sessionId');
  const userId = optionalString(body, 'userId');
  const maxIterations = optionalInteger(body, 'maxIterations');
  const maxToolExecutionMs = optionalInteger(body, 'maxToolExecutionMs');
  assertIntegerRange(maxIterations, 'maxIterations', 1, MAX_AGENT_ITERATIONS);
  assertIntegerRange(maxToolExecutionMs, 'maxToolExecutionMs', 1, MAX_TOOL_EXECUTION_MS);
  return {
    message: requireString(body, 'message'),
    ...(mode === undefined ? {} : { mode: mode as 'read' | 'edit' | 'full' }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(userId === undefined ? {} : { userId }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs }),
  };
}

function parseMcpServerInput(body: Record<string, unknown>): McpServerRegistrationInput {
  const source = optionalString(body, 'source');
  if (source !== undefined && source !== 'user' && source !== 'imported') {
    throw new DatabaseAgentError('INVALID_INPUT', 'source 必须是 user 或 imported。', false);
  }
  const transport = optionalString(body, 'transport');
  if (
    transport !== undefined &&
    transport !== 'stdio' &&
    transport !== 'sse' &&
    transport !== 'streamable-http'
  ) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'transport 必须是 stdio、sse 或 streamable-http。',
      false,
    );
  }
  const args = parseOptionalStringArray(body.args, 'args', 256);
  const env = parseMcpValueMap(body.env, 'env');
  const headers = parseMcpValueMap(body.headers, 'headers');
  const id = optionalString(body, 'id');
  const command = optionalString(body, 'command');
  const cwd = optionalString(body, 'cwd');
  const serverUrl = optionalString(body, 'url');
  const description = optionalString(body, 'description');
  const packageName = optionalString(body, 'packageName');
  const autoStart = optionalBoolean(body, 'autoStart');
  const enabled = optionalBoolean(body, 'enabled');
  return {
    ...(id === undefined ? {} : { id }),
    name: requireString(body, 'name'),
    ...(source === undefined ? {} : { source }),
    ...(transport === undefined
      ? {}
      : {
          transport,
        }),
    ...(autoStart === undefined ? {} : { autoStart }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(serverUrl === undefined ? {} : { url: serverUrl }),
    ...(env === undefined ? {} : { env }),
    ...(headers === undefined ? {} : { headers }),
    ...(description === undefined ? {} : { description }),
    ...(packageName === undefined ? {} : { packageName }),
  };
}

function parseMcpValueMap(
  value: unknown,
  name: string,
): Record<string, string | { ref: string }> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, name);
  const entries = Object.entries(record);
  if (entries.length > 256) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} 最多允许 256 项。`, false);
  }
  const parsed: Record<string, string | { ref: string }> = {};
  for (const [key, item] of entries) {
    if (typeof item === 'string') {
      parsed[key] = item;
      continue;
    }
    if (
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).ref === 'string' &&
      ((item as Record<string, unknown>).ref as string).trim()
    ) {
      parsed[key] = {
        ref: ((item as Record<string, unknown>).ref as string).trim(),
      };
      continue;
    }
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name}.${key} 必须是普通字符串或 {"ref":"secret-ref"}。`,
      false,
    );
  }
  return parsed;
}

function defaultProviderFactory(input: LlmSetupInput): LlmProvider {
  if (input.presetId) {
    return createProviderFromPreset(input.presetId, {
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.providerId === undefined ? {} : { id: input.providerId }),
    });
  }
  if (input.protocol === 'anthropic-messages') {
    if (!input.apiKey)
      throw new DatabaseAgentError('INVALID_INPUT', 'Anthropic 原生协议必须配置 apiKey。');
    return new AnthropicProvider({
      id: input.providerId ?? 'default-anthropic',
      name: 'Anthropic',
      apiKey: input.apiKey,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
    });
  }
  if (!input.baseUrl) throw new DatabaseAgentError('INVALID_INPUT', 'baseUrl 不能为空。');
  return new OpenAICompatibleProvider({
    id: input.providerId ?? 'default-openai-compatible',
    name: 'OpenAI-compatible',
    baseUrl: input.baseUrl,
    metadataSource: isOllamaBaseUrl(input.baseUrl) ? 'ollama' : 'openai-compatible',
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.allowUnauthenticated === undefined
      ? {}
      : { allowUnauthenticated: input.allowUnauthenticated }),
  });
}

function isOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.port === '11434';
  } catch {
    return false;
  }
}

function parseLlmSetup(input: Record<string, unknown>): LlmSetupInput {
  const apiKey = optionalString(input, 'apiKey');
  const providerId = optionalString(input, 'providerId');
  const presetId = optionalString(input, 'presetId');
  const protocolValue = optionalString(input, 'protocol') ?? 'openai-compatible';
  if (protocolValue !== 'openai-compatible' && protocolValue !== 'anthropic-messages') {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'protocol 必须是 openai-compatible 或 anthropic-messages。',
    );
  }
  const preset = presetId ? getLlmProviderPreset(presetId) : undefined;
  if (presetId && !preset) {
    throw new DatabaseAgentError('INVALID_INPUT', `未知的 Provider 预设：${presetId}`);
  }
  if (presetId && protocolValue !== 'openai-compatible') {
    throw new DatabaseAgentError('INVALID_INPUT', 'Provider 预设仅适用于 openai-compatible 协议。');
  }
  const baseUrl = optionalString(input, 'baseUrl');
  if (!presetId && protocolValue === 'openai-compatible' && !baseUrl) {
    throw new DatabaseAgentError('INVALID_INPUT', 'baseUrl 不能为空。');
  }
  if (protocolValue === 'anthropic-messages' && !apiKey) {
    throw new DatabaseAgentError('INVALID_INPUT', 'Anthropic 原生协议必须配置 apiKey。');
  }
  if (preset?.requiresApiKey && !apiKey) {
    throw new DatabaseAgentError('INVALID_INPUT', `${preset.name} 预设必须配置 apiKey。`);
  }
  const allowUnauthenticated = optionalBoolean(input, 'allowUnauthenticated');
  const apiVersion = optionalString(input, 'apiVersion');
  return {
    protocol: protocolValue,
    model: requireString(input, 'model'),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(presetId === undefined ? {} : { presetId }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(allowUnauthenticated === undefined ? {} : { allowUnauthenticated }),
  };
}

function parseDatabaseSetup(input: Record<string, unknown>): PostgresConnectionInput {
  const port = optionalInteger(input, 'port');
  const ssl = optionalBoolean(input, 'ssl');
  const password = optionalString(input, 'password');
  const name = optionalString(input, 'name');
  return {
    host: requireString(input, 'host'),
    database: requireString(input, 'database'),
    username: requireString(input, 'username'),
    ...(name === undefined ? {} : { name }),
    ...(port === undefined ? {} : { port }),
    ...(password === undefined ? {} : { password }),
    ...(ssl === undefined ? {} : { ssl }),
  };
}

function requireDatabaseRuntime(runtime: DatabaseAgentRuntimePort): DatabaseAccessRuntime {
  if (!runtime.database) {
    throw new DatabaseAgentError(
      'NOT_CONFIGURED',
      'This runtime does not expose the unified database access API.',
    );
  }
  return runtime.database;
}

function parseConnectionProfile(input: Record<string, unknown>): ConnectionProfile {
  const endpointsValue = input.endpoints;
  if (!Array.isArray(endpointsValue) || endpointsValue.length === 0 || endpointsValue.length > 32) {
    throw new DatabaseAgentError('INVALID_INPUT', 'endpoints must contain between 1 and 32 items.');
  }
  const endpoints: ConnectionProfile['endpoints'] = endpointsValue.map((value, index) => {
    const endpoint = requireRecord(value, `endpoints[${index}]`);
    const transport = requireString(endpoint, 'transport');
    if (transport === 'tcp') {
      const sslValue = endpoint.ssl;
      const validSslMode =
        typeof sslValue === 'string' && ['require', 'verify-ca', 'verify-full'].includes(sslValue);
      if (sslValue !== undefined && typeof sslValue !== 'boolean' && !validSslMode) {
        throw new DatabaseAgentError('INVALID_INPUT', `endpoints[${index}].ssl is invalid.`);
      }
      return {
        transport,
        host: requireString(endpoint, 'host'),
        port: requireInteger(endpoint, 'port'),
        ...(optionalString(endpoint, 'database') === undefined
          ? {}
          : { database: optionalString(endpoint, 'database') as string }),
        ...(sslValue === undefined
          ? {}
          : {
              ssl: sslValue as boolean | 'require' | 'verify-ca' | 'verify-full',
            }),
      };
    }
    if (transport === 'jdbc') {
      return {
        transport,
        url: requireString(endpoint, 'url'),
        ...(optionalString(endpoint, 'driverClass') === undefined
          ? {}
          : { driverClass: optionalString(endpoint, 'driverClass') as string }),
        ...(endpoint.properties === undefined
          ? {}
          : { properties: parseStringRecord(endpoint.properties, 'properties') }),
      };
    }
    if (transport === 'http') {
      return {
        transport,
        baseUrl: requireString(endpoint, 'baseUrl'),
        ...(optionalString(endpoint, 'apiVersion') === undefined
          ? {}
          : { apiVersion: optionalString(endpoint, 'apiVersion') as string }),
        ...(endpoint.headers === undefined
          ? {}
          : { headers: parseStringRecord(endpoint.headers, 'headers') }),
      };
    }
    if (transport === 'sdk') {
      return {
        transport,
        provider: requireString(endpoint, 'provider'),
        ...(optionalString(endpoint, 'account') === undefined
          ? {}
          : { account: optionalString(endpoint, 'account') as string }),
        ...(optionalString(endpoint, 'region') === undefined
          ? {}
          : { region: optionalString(endpoint, 'region') as string }),
        ...(endpoint.options === undefined
          ? {}
          : { options: requireRecord(endpoint.options, 'options') as never }),
      };
    }
    if (transport === 'custom') {
      return {
        transport,
        scheme: requireString(endpoint, 'scheme'),
        options: requireRecord(endpoint.options, 'options') as never,
      };
    }
    throw new DatabaseAgentError('INVALID_INPUT', `endpoints[${index}].transport is invalid.`);
  });
  const purpose = optionalString(input, 'purpose') ?? 'query';
  if (!['query', 'read-only', 'read-write', 'admin', 'monitor'].includes(purpose)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'purpose is invalid.');
  }
  const timestamp = new Date().toISOString();
  const credentialRefValue =
    input.credentialRef === undefined
      ? undefined
      : requireRecord(input.credentialRef, 'credentialRef');
  const networkValue =
    input.network === undefined ? undefined : requireRecord(input.network, 'network');
  const poolValue = input.pool === undefined ? undefined : requireRecord(input.pool, 'pool');
  const scope = parseResourceScopeRecord(input.scope);
  const profile: ConnectionProfile = {
    id: optionalString(input, 'id') ?? randomUUID(),
    name: requireString(input, 'name'),
    connectorId: requireString(input, 'connectorId'),
    engine: requireString(input, 'engine'),
    endpoints,
    ...(credentialRefValue
      ? {
          credentialRef: {
            provider: requireString(credentialRefValue, 'provider'),
            reference: requireString(credentialRefValue, 'reference'),
            ...(optionalString(credentialRefValue, 'version') === undefined
              ? {}
              : { version: optionalString(credentialRefValue, 'version') as string }),
            ...(optionalString(credentialRefValue, 'expiresAt') === undefined
              ? {}
              : { expiresAt: optionalString(credentialRefValue, 'expiresAt') as string }),
          },
        }
      : {}),
    ...(optionalString(input, 'principal') === undefined
      ? {}
      : { principal: optionalString(input, 'principal') as string }),
    purpose: purpose as ConnectionProfile['purpose'],
    readOnly: optionalBoolean(input, 'readOnly') ?? purpose === 'read-only',
    ...(scope === undefined ? {} : { scope }),
    ...(optionalString(input, 'defaultResourceId') === undefined
      ? {}
      : { defaultResourceId: optionalString(input, 'defaultResourceId') as string }),
    ...(optionalString(input, 'defaultNamespace') === undefined
      ? {}
      : { defaultNamespace: optionalString(input, 'defaultNamespace') as string }),
    ...(networkValue
      ? {
          network: {
            ...(optionalString(networkValue, 'proxyUrl') === undefined
              ? {}
              : { proxyUrl: optionalString(networkValue, 'proxyUrl') as string }),
            ...(optionalString(networkValue, 'sshTunnelRef') === undefined
              ? {}
              : { sshTunnelRef: optionalString(networkValue, 'sshTunnelRef') as string }),
            ...(optionalString(networkValue, 'privateLinkId') === undefined
              ? {}
              : { privateLinkId: optionalString(networkValue, 'privateLinkId') as string }),
            ...(optionalInteger(networkValue, 'connectTimeoutMs') === undefined
              ? {}
              : { connectTimeoutMs: optionalInteger(networkValue, 'connectTimeoutMs') as number }),
            ...(optionalInteger(networkValue, 'statementTimeoutMs') === undefined
              ? {}
              : {
                  statementTimeoutMs: optionalInteger(networkValue, 'statementTimeoutMs') as number,
                }),
            ...(optionalBoolean(networkValue, 'keepAlive') === undefined
              ? {}
              : { keepAlive: optionalBoolean(networkValue, 'keepAlive') as boolean }),
          },
        }
      : {}),
    ...(poolValue
      ? {
          pool: {
            ...(optionalInteger(poolValue, 'min') === undefined
              ? {}
              : { min: optionalInteger(poolValue, 'min') as number }),
            ...(optionalInteger(poolValue, 'max') === undefined
              ? {}
              : { max: optionalInteger(poolValue, 'max') as number }),
            ...(optionalInteger(poolValue, 'idleTimeoutMs') === undefined
              ? {}
              : { idleTimeoutMs: optionalInteger(poolValue, 'idleTimeoutMs') as number }),
          },
        }
      : {}),
    ...(input.sessionParameters === undefined
      ? {}
      : {
          sessionParameters: requireRecord(input.sessionParameters, 'sessionParameters') as never,
        }),
    ...(input.labels === undefined ? {} : { labels: parseStringRecord(input.labels, 'labels') }),
    createdAt: optionalString(input, 'createdAt') ?? timestamp,
    updatedAt: timestamp,
  };
  return profile;
}

function parseOptionalCredential(value: unknown): DatabaseCredential | undefined {
  if (value === undefined) return undefined;
  const credential = requireRecord(value, 'credential');
  return {
    ...(optionalString(credential, 'username') === undefined
      ? {}
      : { username: optionalString(credential, 'username') as string }),
    ...(optionalString(credential, 'password') === undefined
      ? {}
      : { password: optionalString(credential, 'password') as string }),
    ...(optionalString(credential, 'token') === undefined
      ? {}
      : { token: optionalString(credential, 'token') as string }),
    ...(optionalString(credential, 'certificate') === undefined
      ? {}
      : { certificate: optionalString(credential, 'certificate') as string }),
    ...(optionalString(credential, 'privateKey') === undefined
      ? {}
      : { privateKey: optionalString(credential, 'privateKey') as string }),
    ...(credential.properties === undefined
      ? {}
      : { properties: parseStringRecord(credential.properties, 'properties') }),
  };
}

function parseQuerySubmission(input: Record<string, unknown>): QuerySubmission {
  const executionMode = optionalString(input, 'executionMode');
  if (executionMode && !['sync', 'async', 'auto'].includes(executionMode)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'executionMode is invalid.');
  }
  const transactionMode = optionalString(input, 'transactionMode');
  if (transactionMode && !['auto', 'rollback'].includes(transactionMode)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'transactionMode is invalid.');
  }
  const params = input.params;
  if (params !== undefined && !Array.isArray(params)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'params must be an array.');
  }
  const authorization =
    input.authorization === undefined
      ? undefined
      : parseAuthorization(requireRecord(input.authorization, 'authorization'));
  const submission: QuerySubmission = {
    profileId: requireString(input, 'profileId'),
    sql: requireString(input, 'sql'),
    ...(optionalString(input, 'sessionId') === undefined
      ? {}
      : { sessionId: optionalString(input, 'sessionId') as string }),
    ...(optionalString(input, 'transactionId') === undefined
      ? {}
      : { transactionId: optionalString(input, 'transactionId') as string }),
    ...(optionalString(input, 'resourceId') === undefined
      ? {}
      : { resourceId: optionalString(input, 'resourceId') as string }),
    ...(params === undefined ? {} : { params: params as NonNullable<QuerySubmission['params']> }),
    ...(executionMode
      ? { executionMode: executionMode as NonNullable<QuerySubmission['executionMode']> }
      : {}),
    ...(transactionMode
      ? { transactionMode: transactionMode as NonNullable<QuerySubmission['transactionMode']> }
      : {}),
    ...optionalNumericFields(input, [
      'timeoutMs',
      'rowLimit',
      'batchSize',
      'priority',
      'maximumBytesScanned',
      'maximumCost',
    ]),
    ...(optionalBoolean(input, 'dryRun') === undefined
      ? {}
      : { dryRun: optionalBoolean(input, 'dryRun') as boolean }),
    ...(optionalBoolean(input, 'confirmed') === undefined
      ? {}
      : { confirmed: optionalBoolean(input, 'confirmed') as boolean }),
    ...(authorization ? { authorization } : {}),
    ...(input.labels === undefined ? {} : { labels: parseStringRecord(input.labels, 'labels') }),
  };
  return submission;
}

function parseDatabaseOperation(input: Record<string, unknown>): DatabaseOperationRequest {
  return {
    profileId: requireString(input, 'profileId'),
    operation: requireString(input, 'operation'),
    ...(optionalString(input, 'resourceId') === undefined
      ? {}
      : { resourceId: optionalString(input, 'resourceId') as string }),
    ...(input.input === undefined ? {} : { input: requireRecord(input.input, 'input') as never }),
    ...(input.authorization === undefined
      ? {}
      : {
          authorization: parseAuthorization(requireRecord(input.authorization, 'authorization')),
        }),
  };
}

function parseAuthorization(
  input: Record<string, unknown>,
): NonNullable<QuerySubmission['authorization']> {
  const permissionMode = optionalString(input, 'permissionMode');
  if (permissionMode && !['read', 'edit', 'full'].includes(permissionMode)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'permissionMode is invalid.');
  }
  return {
    ...(optionalString(input, 'actorId') === undefined
      ? {}
      : { actorId: optionalString(input, 'actorId') as string }),
    ...(optionalString(input, 'policyId') === undefined
      ? {}
      : { policyId: optionalString(input, 'policyId') as string }),
    ...(optionalString(input, 'approvalId') === undefined
      ? {}
      : { approvalId: optionalString(input, 'approvalId') as string }),
    ...(permissionMode
      ? {
          permissionMode: permissionMode as NonNullable<
            NonNullable<QuerySubmission['authorization']>['permissionMode']
          >,
        }
      : {}),
  };
}

function optionalNumericFields<T extends string>(
  input: Record<string, unknown>,
  keys: T[],
): Partial<Record<T, number>> {
  const output: Partial<Record<T, number>> = {};
  for (const key of keys) {
    const value = optionalNumber(input, key);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function parseStringRecord(value: unknown, name: string): Record<string, string> {
  const record = requireRecord(value, name);
  if (Object.values(record).some((item) => typeof item !== 'string')) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} values must be strings.`);
  }
  return record as Record<string, string>;
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = optionalInteger(record, key);
  if (value === undefined) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} is required.`);
  }
  return value;
}

function parseUrlInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} is outside the supported range.`);
  }
  return parsed;
}

function parsePositiveUrlInteger(value: string, name: string): number {
  const parsed = parseUrlInteger(value, name);
  if (parsed < 1) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} must be greater than zero.`);
  }
  return parsed;
}

function parseNonNegativeUrlInteger(value: string, name: string): number {
  const parsed = parseUrlInteger(value, name);
  if (parsed < 0) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} must be zero or greater.`);
  }
  return parsed;
}

function parseOptionalUrlBoolean(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DatabaseAgentError('INVALID_INPUT', `${name} must be true or false.`);
}

function parseCommaSeparatedQuery(url: URL, name: string, maxItems = 100): string[] | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > maxItems) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} must contain between 1 and ${maxItems} values.`,
    );
  }
  return values;
}

function parseResourceScopeFromUrl(url: URL): ResourceScope | undefined {
  return createResourceScope((key) => url.searchParams.get(key) ?? undefined);
}

function parseResourceScopeRecord(value: unknown): ResourceScope | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'scope');
  const allowed = new Set(['tenantId', 'organizationId', 'projectId', 'environment', 'region']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DatabaseAgentError('INVALID_INPUT', `scope.${key} is not supported.`);
    }
  }
  return createResourceScope((key) => optionalString(record, key));
}

function createResourceScope(
  read: (key: keyof ResourceScope) => string | undefined,
): ResourceScope | undefined {
  const scope: ResourceScope = {};
  for (const key of ['tenantId', 'organizationId', 'projectId', 'environment', 'region'] as const) {
    const value = read(key)?.trim();
    if (value) scope[key] = value;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function parseResourceQuery(url: URL): ResourceQuery {
  const kinds = parseCommaSeparatedQuery(url, 'kinds') as ResourceKind[] | undefined;
  const scope = parseResourceScopeFromUrl(url);
  const includeDeleted = parseOptionalUrlBoolean(url, 'includeDeleted');
  return {
    ...(kinds === undefined ? {} : { kinds }),
    ...(url.searchParams.get('engine') ? { engine: url.searchParams.get('engine') as string } : {}),
    ...(url.searchParams.get('text') ? { text: url.searchParams.get('text') as string } : {}),
    ...(url.searchParams.get('parentResourceId')
      ? { parentResourceId: url.searchParams.get('parentResourceId') as string }
      : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') as string } : {}),
    ...(url.searchParams.get('limit') === null
      ? {}
      : {
          limit: parsePositiveUrlInteger(url.searchParams.get('limit') as string, 'limit'),
        }),
    ...(includeDeleted === undefined ? {} : { includeDeleted }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function parseResourceTraversal(input: Record<string, unknown>): ResourceTraversalRequest {
  const startResourceIds = parseOptionalStringArray(
    input.startResourceIds,
    'startResourceIds',
    1_000,
  );
  if (!startResourceIds?.length) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'startResourceIds must contain at least one resource ID.',
    );
  }
  const direction = optionalString(input, 'direction');
  if (direction !== undefined && !['outgoing', 'incoming', 'both'].includes(direction)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'direction is invalid.');
  }
  const relationKinds = parseOptionalStringArray(input.relationKinds, 'relationKinds', 100);
  const scope = parseResourceScopeRecord(input.scope);
  return {
    startResourceIds,
    maxDepth: requireInteger(input, 'maxDepth'),
    maxResources: requireInteger(input, 'maxResources'),
    ...(direction === undefined
      ? {}
      : {
          direction: direction as 'outgoing' | 'incoming' | 'both',
        }),
    ...(relationKinds === undefined ? {} : { relationKinds }),
    ...(scope === undefined ? {} : { scope }),
    ...(optionalBoolean(input, 'includeDeleted') === undefined
      ? {}
      : {
          includeDeleted: optionalBoolean(input, 'includeDeleted') as boolean,
        }),
  };
}

function parseResourceEventTypes(url: URL): ResourceEventType[] | undefined {
  const types = parseCommaSeparatedQuery(url, 'types') as ResourceEventType[] | undefined;
  if (types?.some((type) => !RESOURCE_EVENT_TYPES.has(type))) {
    throw new DatabaseAgentError('INVALID_INPUT', 'types contains an unknown resource event type.');
  }
  return types;
}

function throwResourceNotFound(): never {
  throw new DatabaseAccessRuntimeError({
    code: 'RESOURCE_NOT_FOUND',
    category: 'not-found',
    message: 'Resource was not found.',
    stage: 'discover',
    retryable: false,
    outcome: 'unchanged',
  });
}

function parseLlmChatBody(input: Record<string, unknown>): {
  request: LlmRuntimeChatRequest;
  options: LlmRuntimeCallOptions;
} {
  const rawMessages = input.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 200) {
    throw new DatabaseAgentError('INVALID_INPUT', 'messages must contain between 1 and 200 items.');
  }
  const messages = rawMessages.map((value, index): LlmMessage => {
    const message = requireRecord(value, `messages[${index}]`);
    const role = requireString(message, 'role');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      throw new DatabaseAgentError('INVALID_INPUT', `messages[${index}].role is invalid.`);
    }
    const name = optionalString(message, 'name');
    const toolCallId = optionalString(message, 'toolCallId');
    return {
      role: role as LlmMessage['role'],
      content: requireString(message, 'content'),
      ...(name === undefined ? {} : { name }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
  });
  const temperature = optionalNumber(input, 'temperature');
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new DatabaseAgentError('INVALID_INPUT', 'temperature must be between 0 and 2.');
  }
  const maxTokens = optionalInteger(input, 'maxTokens');
  const seed = optionalInteger(input, 'seed');
  const tools = parseLlmTools(input.tools);
  const responseFormat = parseResponseFormat(input.responseFormat);
  const stop = parseOptionalStringArray(input.stop, 'stop', 16);
  const taskType = optionalString(input, 'taskType');
  const userId = optionalString(input, 'userId');
  const timeoutMs = optionalInteger(input, 'timeoutMs');
  const maxRetries = optionalInteger(input, 'maxRetries');
  const maxFallbacks = optionalInteger(input, 'maxFallbacks');
  const cacheRecord = input.cache === undefined ? undefined : requireRecord(input.cache, 'cache');
  const cache =
    cacheRecord === undefined
      ? undefined
      : {
          enabled: optionalBoolean(cacheRecord, 'enabled') ?? false,
          ...(optionalInteger(cacheRecord, 'ttlMs') === undefined
            ? {}
            : { ttlMs: optionalInteger(cacheRecord, 'ttlMs') as number }),
          ...(optionalString(cacheRecord, 'namespace') === undefined
            ? {}
            : { namespace: optionalString(cacheRecord, 'namespace') as string }),
        };
  return {
    request: {
      messages,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(seed === undefined ? {} : { seed }),
      ...(tools === undefined ? {} : { tools }),
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...(stop === undefined ? {} : { stop }),
    },
    options: {
      ...(taskType === undefined ? {} : { taskType }),
      ...(userId === undefined ? {} : { userId }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxRetries === undefined ? {} : { maxRetries }),
      ...(maxFallbacks === undefined ? {} : { maxFallbacks }),
      ...(cache === undefined ? {} : { cache }),
    },
  };
}

function parseLlmTools(value: unknown): LlmTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128)
    throw new DatabaseAgentError('INVALID_INPUT', 'tools must be an array of at most 128 items.');
  return value.map((item, index) => {
    const tool = requireRecord(item, `tools[${index}]`);
    return {
      name: requireString(tool, 'name'),
      description: requireString(tool, 'description'),
      inputSchema: requireRecord(tool.inputSchema, 'inputSchema'),
    };
  });
}

function parseResponseFormat(value: unknown): LlmResponseFormat | undefined {
  if (value === undefined) return undefined;
  const format = requireRecord(value, 'responseFormat');
  const type = requireString(format, 'type');
  if (type === 'text' || type === 'json_object') return { type };
  if (type === 'json_schema') {
    return {
      type,
      name: requireString(format, 'name'),
      schema: requireRecord(format.schema, 'responseFormat.schema'),
      ...(optionalBoolean(format, 'strict') === undefined
        ? {}
        : { strict: optionalBoolean(format, 'strict') as boolean }),
    };
  }
  throw new DatabaseAgentError('INVALID_INPUT', 'responseFormat.type is invalid.');
}

function parseOptionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} must be a string array with at most ${maxItems} items.`,
    );
  }
  return value.map((item) => (item as string).slice(0, 500));
}

async function readOptionalJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (!text.trim()) return {};
  return requireRecord(parseJson(text), 'request');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const text = await readBody(request);
  if (!text.trim()) throw new DatabaseAgentError('INVALID_INPUT', '请求体不能为空。');
  return parseJson(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DatabaseAgentError('INVALID_INPUT', '请求体超过 1 MB 限制。');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    JSON.parse(text);
  } catch {
    throw new DatabaseAgentError('INVALID_INPUT', '请求体不是有效 JSON。');
  }
  return parsePublicJson(text);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 不能为空。`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是字符串。`);
  }
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是整数。`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是布尔值。`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = optionalBoolean(record, key);
  if (value === undefined) {
    throw new DatabaseAgentError('INVALID_INPUT', `${key} 必须是布尔值。`);
  }
  return value;
}

function statusForError(error: DatabaseAgentError): number {
  switch (error.code) {
    case 'RUN_NOT_FOUND':
      return 404;
    case 'NOT_CONFIGURED':
    case 'SCHEMA_NOT_INDEXED':
    case 'RUN_NOT_EXECUTABLE':
      return 409;
    case 'CONNECTION_FAILED':
    case 'LLM_REQUEST_FAILED':
    case 'QUERY_FAILED':
      return 502;
    case 'ABORTED':
      return 408;
    case 'INVALID_INPUT':
    case 'LLM_RESPONSE_INVALID':
    case 'SQL_BLOCKED':
      return 400;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 500;
  }
}

function statusForDatabaseError(error: DatabaseAccessRuntimeError): number {
  switch (error.error.category) {
    case 'validation':
      return 400;
    case 'authentication':
      return 401;
    case 'authorization':
      return 403;
    case 'not-found':
      return 404;
    case 'conflict':
      return 409;
    case 'rate-limit':
    case 'quota':
      return 429;
    case 'timeout':
      return 504;
    case 'network':
    case 'provider':
      return 502;
    case 'cancelled':
      return 409;
    case 'unsupported':
      return 422;
    case 'syntax':
    case 'transaction':
    case 'lock':
      return 400;
    case 'internal':
      return 500;
  }
}

function validateLocalRequest(request: IncomingMessage): void {
  const hostHeader = request.headers.host;
  if (!hostHeader) {
    throw new ServerRequestError(400, 'INVALID_HOST', 'A loopback Host header is required.');
  }
  let requestOrigin: URL;
  try {
    requestOrigin = new URL(`http://${hostHeader}`);
  } catch {
    throw new ServerRequestError(400, 'INVALID_HOST', 'The Host header is invalid.');
  }
  if (
    requestOrigin.username ||
    requestOrigin.password ||
    requestOrigin.pathname !== '/' ||
    requestOrigin.search ||
    requestOrigin.hash ||
    !isLoopbackHostname(requestOrigin.hostname)
  ) {
    throw new ServerRequestError(
      403,
      'LOCAL_ACCESS_ONLY',
      'SchemaNaut Server accepts loopback requests only.',
    );
  }

  const originHeader = request.headers.origin;
  if (originHeader === undefined) return;
  let browserOrigin: URL;
  try {
    browserOrigin = new URL(originHeader);
  } catch {
    throw new ServerRequestError(403, 'ORIGIN_FORBIDDEN', 'The browser Origin is not allowed.');
  }
  if (
    browserOrigin.username ||
    browserOrigin.password ||
    browserOrigin.pathname !== '/' ||
    browserOrigin.search ||
    browserOrigin.hash ||
    browserOrigin.origin !== requestOrigin.origin
  ) {
    throw new ServerRequestError(403, 'ORIGIN_FORBIDDEN', 'The browser Origin is not allowed.');
  }
}

function validateJsonContentType(request: IncomingMessage, method: string): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !requestHasBody(request)) {
    return;
  }
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ServerRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Requests with a body must use application/json.',
    );
  }
}

function requestHasBody(request: IncomingMessage): boolean {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > 0) return true;
  }
  return request.headers['transfer-encoding'] !== undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function assertProcessMcpManagementAllowed(
  transport: McpServerRegistrationInput['transport'] | McpServerSummary['transport'],
  allowed: boolean,
): void {
  if (transport === 'stdio' && !allowed) {
    throw processMcpForbidden();
  }
}

function processMcpForbidden(): ServerRequestError {
  return new ServerRequestError(
    403,
    'PROCESS_MCP_DISABLED',
    'Process-backed stdio MCP management is disabled for this REST server.',
  );
}

function assertIntegerRange(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (value < minimum || value > maximum) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} must be between ${minimum} and ${maximum}.`,
      false,
    );
  }
}

function toPublicCompactionResult(result: CompactAiSqlAgentSessionResult): Record<string, unknown> {
  return {
    status: result.status,
    session: toPublicAgentSessionView(toAgentSessionView(result.session)),
    report: {
      phase: result.report.phase,
      trigger: result.report.trigger,
      originalTokenEstimate: result.report.originalTokenEstimate,
      finalTokenEstimate: result.report.finalTokenEstimate,
      retainedMessageCount: result.report.retainedMessageCount,
      coveredConversationMessageCount: result.report.coveredConversationMessageCount,
      warnings: result.report.warnings.map(sanitizePublicErrorMessage),
    },
    ...(result.checkpoint === undefined
      ? {}
      : { checkpoint: toPublicContextCheckpoint(result.checkpoint) }),
  };
}

function toPublicContextCheckpoint(checkpoint: AgentContextCheckpoint): Record<string, unknown> {
  return {
    sequence: checkpoint.sequence,
    trigger: checkpoint.trigger,
    summary: checkpoint.summary,
    coveredConversationMessageCount: checkpoint.coveredConversationMessageCount,
    sourceTokenEstimate: checkpoint.sourceTokenEstimate,
    summaryTokenEstimate: checkpoint.summaryTokenEstimate,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.focus === undefined ? {} : { focus: checkpoint.focus }),
  };
}

function toPublicAgentSessionView(session: AgentSessionView): AgentSessionView {
  return {
    id: session.id,
    title: session.title,
    ...(session.userId === undefined ? {} : { userId: session.userId }),
    mode: session.mode,
    messages: session.messages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
    tokenUsage: {
      promptTokens: session.tokenUsage.promptTokens,
      completionTokens: session.tokenUsage.completionTokens,
      totalTokens: session.tokenUsage.totalTokens,
      ...(session.tokenUsage.cachedPromptTokens === undefined
        ? {}
        : { cachedPromptTokens: session.tokenUsage.cachedPromptTokens }),
      ...(session.tokenUsage.estimated === undefined
        ? {}
        : { estimated: session.tokenUsage.estimated }),
    },
    ...(session.project === undefined ? {} : { project: { rootPath: session.project.rootPath } }),
    ...(session.taskPlan === undefined
      ? {}
      : {
          taskPlan: {
            version: session.taskPlan.version,
            goal: session.taskPlan.goal,
            tasks: session.taskPlan.tasks.map((task) => ({
              id: task.id,
              title: task.title,
              ...(task.description === undefined ? {} : { description: task.description }),
              status: task.status,
              acceptanceCriteria: [...task.acceptanceCriteria],
              dependsOn: [...task.dependsOn],
              evidence: task.evidence.map((evidence) => ({
                kind: evidence.kind,
                summary: evidence.summary,
                createdAt: evidence.createdAt,
              })),
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            })),
            createdAt: session.taskPlan.createdAt,
            updatedAt: session.taskPlan.updatedAt,
          },
        }),
    ...(session.artifacts === undefined
      ? {}
      : {
          artifacts: session.artifacts.map((artifact) => ({
            id: artifact.id,
            path: artifact.path,
            ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
            ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
            createdAt: artifact.createdAt,
            source: artifact.source,
          })),
        }),
    ...(session.activeSkills === undefined
      ? {}
      : {
          activeSkills: session.activeSkills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
        }),
    aborted: session.aborted,
  };
}

function toPublicDatabaseError(error: DatabaseAccessRuntimeError): Record<string, unknown> {
  const value = error.error;
  return {
    code: sanitizePublicErrorMessage(value.code),
    category: value.category,
    message:
      value.category === 'internal'
        ? 'Internal database service error.'
        : sanitizePublicErrorMessage(value.message),
    retryable: value.retryable,
    outcome: value.outcome,
    ...(value.stage === undefined ? {} : { stage: value.stage }),
    ...(value.category === 'internal' || value.detail === undefined
      ? {}
      : { detail: sanitizePublicErrorMessage(value.detail) }),
  };
}

function redactPublicErrorValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizePublicErrorMessage(value);
  if (Array.isArray(value)) return value.map((item) => redactPublicErrorValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveErrorKey(key) ? '[REDACTED]' : redactPublicErrorValue(child, seen);
  }
  return output;
}

function isSensitiveErrorKey(key: string): boolean {
  return /^(?:access[_-]?token|api[_-]?key|authorization|bearer|connection[_-]?string|credential|credentials|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|refresh[_-]?token|secret|session[_-]?token|token)$/i.test(
    key,
  );
}

function sanitizePublicErrorMessage(message: string): string {
  const sanitized = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, 'sk-[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi, '$1[REDACTED]@')
    .replace(
      /(["']?(?:api[_-]?key|authorization|connection[_-]?string|credential|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|secret|session[_-]?token|token)["']?\s*[:=]\s*["']?)([^"',}\s&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bfile:\/\/\/?[^\s"'<>]+/gi, '[LOCAL_PATH]')
    .replace(/(["'])\b[A-Za-z]:\\.*?\1/g, '[LOCAL_PATH]')
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, '[LOCAL_PATH]')
    .replace(
      /(^|[\s("'=])\/(?:home|Users|var|tmp|private|opt|srv|workspace)\/[^\s"'<>]*/g,
      '$1[LOCAL_PATH]',
    );
  return sanitized.length <= 1_000 ? sanitized : `${sanitized.slice(0, 997)}...`;
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(html);
}

async function sendAgentRunStream(
  response: ServerResponse,
  runAgent: (input: RunAiSqlAgentInput) => Promise<AiSqlAgentRun>,
  input: RunAiSqlAgentInput,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders();
  try {
    const result = await runAgent({
      ...input,
      onEvent: async (event) => {
        await writeSseEvent(response, event.type, event);
      },
    });
    await writeSseEvent(response, 'result', toAiSqlAgentRunView(result));
  } catch (error) {
    if (!response.writableEnded && !response.destroyed) {
      const normalized = asDatabaseAgentError(error);
      await writeSseEvent(response, 'error', {
        error: {
          code: normalized.code,
          message:
            normalized.code === 'INTERNAL_ERROR'
              ? 'Internal server error.'
              : sanitizePublicErrorMessage(normalized.message),
          retryable: normalized.retryable,
        },
      });
    }
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

async function sendLlmStream(
  response: ServerResponse,
  stream: AsyncIterable<LlmChatStreamEvent>,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('connection', 'keep-alive');
  try {
    for await (const event of stream) {
      if (response.writableEnded || response.destroyed) return;
      if (!(await writeSseEvent(response, event.type, event))) return;
    }
  } catch (error) {
    if (!response.writableEnded && !response.destroyed) {
      const normalized = asDatabaseAgentError(error);
      await writeSseEvent(response, 'error', {
        error: {
          code: normalized.code,
          message:
            normalized.code === 'INTERNAL_ERROR'
              ? 'Internal server error.'
              : sanitizePublicErrorMessage(normalized.message),
          retryable: normalized.retryable,
        },
      });
    }
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

async function writeSseEvent(
  response: ServerResponse,
  event: string,
  value: unknown,
): Promise<boolean> {
  if (response.writableEnded || response.destroyed) return false;
  if (response.write(`event: ${event}\ndata: ${stringifyPublicJson(value)}\n\n`)) return true;
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function emptyLlmMetrics(): LlmMetricsSnapshot {
  return {
    requests: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    cacheHits: 0,
    retries: 0,
    fallbacks: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    latencyMs: { p50: 0, p95: 0, p99: 0, max: 0 },
    byModel: {},
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(stringifyPublicJson(value));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
}

function assertLoopbackHost(host: string): void {
  if (!isLoopbackHostname(host)) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'SchemaNaut Server 只允许监听 127.0.0.1、::1 或 localhost。',
      false,
    );
  }
}
