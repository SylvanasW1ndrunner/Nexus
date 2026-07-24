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
  type AiSqlAgentRun,
  type CompactAiSqlAgentSessionInput,
  type CompactAiSqlAgentSessionResult,
  type DatabaseAccessRuntime,
  type DatabaseCredential,
  type DatabaseOperationRequest,
  type QuerySubmission,
  type RunAiSqlAgentInput,
  type ResourceEventType,
  type ResourceKind,
  type ResourceQuery,
  type ResourceScope,
  type ResourceTraversalRequest,
} from '@dbagent/sdk';
import {
  ContractValidationError,
  stringifyPublicJson,
  type SavedConnection,
} from '@dbagent/shared';
import { WEB_UI_HTML } from './web-ui.js';

const MAX_BODY_BYTES = 1_048_576;
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
  configureProvider(provider: LlmProvider, model: string): void;
  connect(input: PostgresConnectionInput): Promise<SavedConnection>;
  disconnect(): Promise<void>;
  indexSchema(options?: IndexSchemaOptions): Promise<SchemaIndexSnapshot>;
  schemaStatus(): SchemaIndexSnapshot;
  status(): RuntimeStatus;
  generate(input: GenerateSqlInput): Promise<GeneratedSqlRun>;
  executeGenerated(runId: string, options?: ExecuteGeneratedOptions): Promise<ExecutedSqlRun>;
  getRun(runId: string): SqlRunSnapshot | undefined;
  runAgent?(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun>;
  compactAgentSession?(
    input: CompactAiSqlAgentSessionInput,
  ): Promise<CompactAiSqlAgentSessionResult>;
  agentContextCheckpoints?(
    sessionId: string,
    limit?: number,
  ): Promise<AgentContextCheckpoint[]>;
  llmModels?(): RegisteredLlmModel[];
  discoverLlmModels?(): Promise<RegisteredLlmModel[]>;
  llmMetrics?(): LlmMetricsSnapshot;
  llmChat?(request: LlmRuntimeChatRequest, options?: LlmRuntimeCallOptions): Promise<LlmChatResponse>;
  llmStream?(request: LlmRuntimeChatRequest, options?: LlmRuntimeCallOptions): AsyncIterable<LlmChatStreamEvent>;
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
};

export function createDatabaseAgentServer(options: DatabaseAgentServerOptions = {}): {
  server: Server;
  runtime: DatabaseAgentRuntimePort;
} {
  const runtime = options.runtime ?? new DatabaseAgentRuntime();
  const createProvider = options.createProvider ?? defaultProviderFactory;
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime, createProvider);
  });
  server.on('close', () => {
    void runtime.disconnect().catch(() => undefined);
    void runtime.database?.close().catch(() => undefined);
  });
  return { server, runtime };
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
  const { server, runtime } = createDatabaseAgentServer(options);
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
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DatabaseAgentRuntimePort,
  createProvider: (input: LlmSetupInput) => LlmProvider,
): Promise<void> {
  setSecurityHeaders(response);
  try {
    const method = request.method ?? 'GET';
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
        llmOperations: ['chat', 'stream', 'async-batch', 'tool-calling', 'structured-output', 'embeddings', 'rerank'],
        agentOperations: [
          'run',
          'automatic-context-compaction',
          'manual-context-compaction',
          'context-checkpoint-history',
        ],
        surfaces: ['typescript-sdk', 'rest', 'cli', 'webui'],
        safety: { readOnly: true, generatedSqlOnly: true, explicitExecution: true },
        limits: { defaultRows: 200, maxRows: 1000, maxRequestBytes: MAX_BODY_BYTES },
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
        : runtime.llmModels?.() ?? [];
      sendJson(response, 200, {
        providerId: provider.id,
        protocol: provider.protocol ?? llm.protocol,
        model: llm.model,
        models,
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/chat') {
      if (!runtime.llmChat) throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM chat is unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const parsed = parseLlmChatBody(body);
      sendJson(response, 200, await runtime.llmChat(parsed.request, parsed.options));
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/chat/stream') {
      if (!runtime.llmStream) throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM streaming is unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const parsed = parseLlmChatBody(body);
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      await sendLlmStream(
        response,
        runtime.llmStream({ ...parsed.request, signal: controller.signal }, parsed.options),
      );
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/llm/jobs') {
      if (!runtime.submitLlmBatch) throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM batch jobs are unavailable.');
      const body = requireRecord(await readJson(request), 'request');
      const values = body.requests;
      if (!Array.isArray(values) || values.length === 0 || values.length > 1_000) {
        throw new DatabaseAgentError('INVALID_INPUT', 'requests must contain between 1 and 1000 items.');
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
      (url.pathname === '/v1/resources' ||
        url.pathname === '/v1/database/resources')
    ) {
      sendJson(
        response,
        200,
        requireDatabaseRuntime(runtime).resources.query(parseResourceQuery(url)),
      );
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/resources/traverse') {
      const requestBody = requireRecord(await readJson(request), 'request');
      sendJson(
        response,
        200,
        requireDatabaseRuntime(runtime).resources.traverse(
          parseResourceTraversal(requestBody),
        ),
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/resource-events') {
      const eventTypes = parseResourceEventTypes(url);
      sendJson(
        response,
        200,
        requireDatabaseRuntime(runtime).resources.events({
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
                limit: parsePositiveUrlInteger(
                  url.searchParams.get('limit') as string,
                  'limit',
                ),
              }),
        }),
      );
      return;
    }
    const resourceRelationsMatch = url.pathname.match(
      /^\/v1\/(?:database\/)?resources\/([^/]+)\/relations$/,
    );
    if (resourceRelationsMatch?.[1] && method === 'GET') {
      const direction = url.searchParams.get('direction') ?? undefined;
      const relationKinds = parseCommaSeparatedQuery(url, 'kinds');
      const includeDeleted = parseOptionalUrlBoolean(url, 'includeDeleted');
      const scope = parseResourceScopeFromUrl(url);
      if (
        direction !== undefined &&
        !['outgoing', 'incoming', 'both'].includes(direction)
      ) {
        throw new DatabaseAgentError('INVALID_INPUT', 'direction is invalid.');
      }
      sendJson(
        response,
        200,
        requireDatabaseRuntime(runtime).resources.relationsFor(
          decodeURIComponent(resourceRelationsMatch[1]),
          {
            ...(direction === undefined
              ? {}
              : {
                  direction: direction as
                    | 'outgoing'
                    | 'incoming'
                    | 'both',
                }),
            ...(relationKinds === undefined ? {} : { kinds: relationKinds }),
            ...(includeDeleted === undefined ? {} : { includeDeleted }),
            ...(scope === undefined ? {} : { scope }),
          },
        ),
      );
      return;
    }
    const resourceStateMatch = url.pathname.match(
      /^\/v1\/resources\/([^/]+)\/state$/,
    );
    if (resourceStateMatch?.[1] && method === 'GET') {
      const state = requireDatabaseRuntime(runtime).resources.state(
        decodeURIComponent(resourceStateMatch[1]),
        {
          ...(url.searchParams.get('asOf')
            ? { asOf: url.searchParams.get('asOf') as string }
            : {}),
        },
      );
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
      const includeExpired = parseOptionalUrlBoolean(url, 'includeExpired');
      if (!resources.getResource(resourceId, true)) throwResourceNotFound();
      sendJson(
        response,
        200,
        resources.observationsFor(resourceId, {
          ...(includeExpired === undefined ? {} : { includeExpired }),
          ...(url.searchParams.get('category')
            ? { category: url.searchParams.get('category') as string }
            : {}),
          ...(url.searchParams.get('at')
            ? { at: url.searchParams.get('at') as string }
            : {}),
          ...(url.searchParams.get('limit') === null
            ? {}
            : {
                limit: parsePositiveUrlInteger(
                  url.searchParams.get('limit') as string,
                  'limit',
                ),
              }),
        }),
      );
      return;
    }
    const resourceMatch = url.pathname.match(
      /^\/v1\/(?:database\/)?resources\/([^/]+)$/,
    );
    if (resourceMatch?.[1] && method === 'GET') {
      const resource = requireDatabaseRuntime(runtime).resources.getResource(
        decodeURIComponent(resourceMatch[1]),
        parseOptionalUrlBoolean(url, 'includeDeleted') ?? false,
      );
      if (!resource) throwResourceNotFound();
      sendJson(response, 200, resource);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/queries') {
      const submission = parseQuerySubmission(
        requireRecord(await readJson(request), 'request'),
      );
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
      const operation = parseDatabaseOperation(
        requireRecord(await readJson(request), 'request'),
      );
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
        provider: { id: provider.id, protocol: provider.protocol ?? llm.protocol, model: llm.model },
        connection,
        schema: runtime.schemaStatus(),
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/database/connect') {
      const body = requireRecord(await readJson(request), 'request');
      const database = parseDatabaseSetup(body.database === undefined ? body : requireRecord(body.database, 'database'));
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
    if (method === 'POST' && url.pathname === '/v1/agent/run') {
      if (!runtime.runAgent) {
        throw new DatabaseAgentError(
          'NOT_CONFIGURED',
          '当前 Runtime 未启用 AI SQL Agent。',
          true,
        );
      }
      const body = requireRecord(await readJson(request), 'request');
      const mode = optionalString(body, 'mode');
      if (mode && mode !== 'read' && mode !== 'edit' && mode !== 'full') {
        throw new DatabaseAgentError(
          'INVALID_INPUT',
          'mode 必须是 read、edit 或 full。',
          false,
        );
      }
      const agentMode =
        mode === undefined
          ? undefined
          : (mode as 'read' | 'edit' | 'full');
      const sessionId = optionalString(body, 'sessionId');
      const userId = optionalString(body, 'userId');
      const maxIterations = optionalInteger(body, 'maxIterations');
      const result = await runtime.runAgent({
        message: requireString(body, 'message'),
        ...(agentMode === undefined ? {} : { mode: agentMode }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(userId === undefined ? {} : { userId }),
        ...(maxIterations === undefined ? {} : { maxIterations }),
      });
      sendJson(response, 200, result);
      return;
    }
    const compactSessionMatch = url.pathname.match(
      /^\/v1\/agent\/sessions\/([^/]+)\/compact$/,
    );
    if (method === 'POST' && compactSessionMatch?.[1]) {
      if (!runtime.compactAgentSession) {
        throw new DatabaseAgentError(
          'NOT_CONFIGURED',
          '当前 Runtime 未启用上下文压缩。',
          true,
        );
      }
      const body = await readOptionalJson(request);
      const focus = optionalString(body, 'focus');
      const result = await runtime.compactAgentSession({
        sessionId: decodeURIComponent(compactSessionMatch[1]),
        ...(focus === undefined ? {} : { focus }),
      });
      sendJson(response, 200, result);
      return;
    }
    const checkpointMatch = url.pathname.match(
      /^\/v1\/agent\/sessions\/([^/]+)\/context-checkpoints$/,
    );
    if (method === 'GET' && checkpointMatch?.[1]) {
      if (!runtime.agentContextCheckpoints) {
        throw new DatabaseAgentError(
          'NOT_CONFIGURED',
          '当前 Runtime 未启用上下文检查点。',
          true,
        );
      }
      const limitText = url.searchParams.get('limit');
      const limit =
        limitText === null ? undefined : Number.parseInt(limitText, 10);
      if (
        limit !== undefined &&
        (!Number.isSafeInteger(limit) || limit <= 0)
      ) {
        throw new DatabaseAgentError(
          'INVALID_INPUT',
          'limit 必须是正整数。',
          false,
        );
      }
      sendJson(
        response,
        200,
        await runtime.agentContextCheckpoints(
          decodeURIComponent(checkpointMatch[1]),
          limit,
        ),
      );
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
    if (error instanceof ContractValidationError) {
      sendJson(response, 400, {
        error: {
          code: 'CONTRACT_VALIDATION_FAILED',
          message: 'The public request contract is invalid.',
          retryable: false,
          issues: error.issues,
        },
      });
      return;
    }
    if (error instanceof ResourceConflictError) {
      sendJson(
        response,
        [
          'RESOURCE_CONFLICT',
          'RELATION_CYCLE',
          'STALE_CHANGE_SET',
        ].includes(error.code)
          ? 409
          : 400,
        {
          error: {
            code: error.code,
            message: error.message,
            retryable: false,
          },
        },
      );
      return;
    }
    if (error instanceof DatabaseAccessRuntimeError) {
      sendJson(response, statusForDatabaseError(error), { error: error.error });
      return;
    }
    const normalized = asDatabaseAgentError(error);
    sendJson(response, statusForError(normalized), {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    });
  }
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
    if (!input.apiKey) throw new DatabaseAgentError('INVALID_INPUT', 'Anthropic 原生协议必须配置 apiKey。');
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
    ...(input.allowUnauthenticated === undefined ? {} : { allowUnauthenticated: input.allowUnauthenticated }),
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
    throw new DatabaseAgentError('INVALID_INPUT', 'protocol 必须是 openai-compatible 或 anthropic-messages。');
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
        typeof sslValue === 'string' &&
        ['prefer', 'require', 'verify-ca', 'verify-full'].includes(sslValue);
      if (
        sslValue !== undefined &&
        typeof sslValue !== 'boolean' &&
        !validSslMode
      ) {
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
              ssl: sslValue as
                | boolean
                | 'prefer'
                | 'require'
                | 'verify-ca'
                | 'verify-full',
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
    input.credentialRef === undefined ? undefined : requireRecord(input.credentialRef, 'credentialRef');
  const networkValue =
    input.network === undefined ? undefined : requireRecord(input.network, 'network');
  const poolValue = input.pool === undefined ? undefined : requireRecord(input.pool, 'pool');
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
              : { statementTimeoutMs: optionalInteger(networkValue, 'statementTimeoutMs') as number }),
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
      : { sessionParameters: requireRecord(input.sessionParameters, 'sessionParameters') as never }),
    ...(input.labels === undefined
      ? {}
      : { labels: parseStringRecord(input.labels, 'labels') }),
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
    ...(params === undefined
      ? {}
      : { params: params as NonNullable<QuerySubmission['params']> }),
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
          authorization: parseAuthorization(
            requireRecord(input.authorization, 'authorization'),
          ),
        }),
  };
}

function parseAuthorization(input: Record<string, unknown>): NonNullable<QuerySubmission['authorization']> {
  const permissionMode = optionalString(input, 'permissionMode');
  if (
    permissionMode &&
    !['all-writes-approved', 'non-high-risk', 'fully-approved'].includes(permissionMode)
  ) {
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
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} must be greater than zero.`,
    );
  }
  return parsed;
}

function parseOptionalUrlBoolean(
  url: URL,
  name: string,
): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DatabaseAgentError(
    'INVALID_INPUT',
    `${name} must be true or false.`,
  );
}

function parseCommaSeparatedQuery(
  url: URL,
  name: string,
  maxItems = 100,
): string[] | undefined {
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

function parseResourceScopeRecord(
  value: unknown,
): ResourceScope | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'scope');
  const allowed = new Set([
    'tenantId',
    'organizationId',
    'projectId',
    'environment',
    'region',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        `scope.${key} is not supported.`,
      );
    }
  }
  return createResourceScope((key) => optionalString(record, key));
}

function createResourceScope(
  read: (key: keyof ResourceScope) => string | undefined,
): ResourceScope | undefined {
  const scope: ResourceScope = {};
  for (const key of [
    'tenantId',
    'organizationId',
    'projectId',
    'environment',
    'region',
  ] as const) {
    const value = read(key)?.trim();
    if (value) scope[key] = value;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function parseResourceQuery(url: URL): ResourceQuery {
  const kinds = parseCommaSeparatedQuery(url, 'kinds') as
    | ResourceKind[]
    | undefined;
  const scope = parseResourceScopeFromUrl(url);
  const includeDeleted = parseOptionalUrlBoolean(url, 'includeDeleted');
  return {
    ...(kinds === undefined ? {} : { kinds }),
    ...(url.searchParams.get('engine')
      ? { engine: url.searchParams.get('engine') as string }
      : {}),
    ...(url.searchParams.get('text')
      ? { text: url.searchParams.get('text') as string }
      : {}),
    ...(url.searchParams.get('parentResourceId')
      ? { parentResourceId: url.searchParams.get('parentResourceId') as string }
      : {}),
    ...(url.searchParams.get('cursor')
      ? { cursor: url.searchParams.get('cursor') as string }
      : {}),
    ...(url.searchParams.get('limit') === null
      ? {}
      : {
          limit: parsePositiveUrlInteger(
            url.searchParams.get('limit') as string,
            'limit',
          ),
        }),
    ...(includeDeleted === undefined ? {} : { includeDeleted }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function parseResourceTraversal(
  input: Record<string, unknown>,
): ResourceTraversalRequest {
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
  if (
    direction !== undefined &&
    !['outgoing', 'incoming', 'both'].includes(direction)
  ) {
    throw new DatabaseAgentError('INVALID_INPUT', 'direction is invalid.');
  }
  const relationKinds = parseOptionalStringArray(
    input.relationKinds,
    'relationKinds',
    100,
  );
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
  const types = parseCommaSeparatedQuery(url, 'types') as
    | ResourceEventType[]
    | undefined;
  if (types?.some((type) => !RESOURCE_EVENT_TYPES.has(type))) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'types contains an unknown resource event type.',
    );
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
  const cache = cacheRecord === undefined
    ? undefined
    : {
        enabled: optionalBoolean(cacheRecord, 'enabled') ?? false,
        ...(optionalInteger(cacheRecord, 'ttlMs') === undefined ? {} : { ttlMs: optionalInteger(cacheRecord, 'ttlMs') as number }),
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
  if (!Array.isArray(value) || value.length > 128) throw new DatabaseAgentError('INVALID_INPUT', 'tools must be an array of at most 128 items.');
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

function parseOptionalStringArray(value: unknown, name: string, maxItems: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} must be a string array with at most ${maxItems} items.`);
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
    return JSON.parse(text);
  } catch {
    throw new DatabaseAgentError('INVALID_INPUT', '请求体不是有效 JSON。');
  }
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

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(html);
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
      response.write(
        `event: ${event.type}\ndata: ${stringifyPublicJson(event)}\n\n`,
      );
    }
  } catch (error) {
    if (!response.writableEnded && !response.destroyed) {
      const normalized = asDatabaseAgentError(error);
      response.write(
        `event: error\ndata: ${stringifyPublicJson({
          error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
        })}\n\n`,
      );
    }
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
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
  if (response.writableEnded) return;
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
  const normalized = host.trim().toLowerCase();
  if (normalized !== '127.0.0.1' && normalized !== '::1' && normalized !== 'localhost') {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      'SchemaNaut Server 只允许监听 127.0.0.1、::1 或 localhost。',
      false,
    );
  }
}
