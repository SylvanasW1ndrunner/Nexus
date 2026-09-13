import {
  PREPARED_TOOL_INTENT_REVISION,
  expectedToolError,
  ToolExecutionError,
  type AgentToolPermissionFacts,
  type AgentToolPermissionDeclaration,
  type PreparedToolIntent,
  type ToolInvocationContribution,
  type ToolInvocationDefinition,
  type ToolInvocationExecutionContext,
  type ToolInvocationHandlerRuntime,
  type ToolRetainedResultContent,
  type ToolPrepareContext,
  type ToolRegistry,
} from '@dbagent/core-agent';
import {
  DatabaseAccessRuntimeError,
  parseSql,
  type SqlOperationClass,
  type SqlParseResult,
} from '@dbagent/core-db';
import type { SchemaRagEngine } from '@dbagent/core-rag';
import type {
  QueryAuthorization,
  QueryExecutionResult,
  QueryRequest,
  QueryResultRow,
  ResultHandle,
} from '@dbagent/shared';
import { stringifyPublicJson, toPortableValue, type PortableValue } from '@dbagent/shared';
import {
  projectKnowledgeSearchResult,
  projectResourceDetail,
  projectResourceSummary,
  resolveAgentResourceReference,
} from './agent-knowledge-projection.js';
import { optionalPositiveInteger, optionalString, requireString } from '@dbagent/core-tools';

const DEFAULT_PREVIEW_ROWS = 100;
const DEFAULT_EXECUTION_ROWS = 1_000;
const MAX_MODEL_RESULT_CHARS = 64 * 1024;
const DDL_KINDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'COMMENT', 'RENAME']);
const DATABASE_TOOL_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 256 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxRecords: 10_000,
});
const DATABASE_OUTPUT_SCHEMA = Object.freeze({ type: 'object' });

/**
 * An immutable, connector-neutral database identity captured when a Capability
 * generation is built.  Tool handlers must never reach through this boundary
 * to discover a newer active profile or Schema RAG generation.
 */
export type ActiveDatabaseBinding = Readonly<{
  connectionId: string;
  profileId: string;
  host?: string;
  readOnly: boolean;
  schema: SchemaRagReadView;
}>;

/**
 * The read-only portion of Schema RAG captured by a database Capability
 * generation. `SchemaRagEngine.captureReadView()` implements this contract;
 * keeping the interface here prevents a generic host from leaking a mutable
 * Schema RAG engine into tool handlers.
 */
export type SchemaRagReadView = Readonly<{
  connectionId: string;
  getCatalog(): ReturnType<SchemaRagEngine['getCatalog']>;
  listResources(input: Omit<Parameters<SchemaRagEngine['listResources']>[0], 'connectionId'>):
    ReturnType<SchemaRagEngine['listResources']>;
  getResource(input: Omit<Parameters<SchemaRagEngine['getResource']>[0], 'connectionId'>):
    ReturnType<SchemaRagEngine['getResource']>;
  searchAsync(input: Omit<Parameters<SchemaRagEngine['searchAsync']>[0], 'connectionId'>):
    ReturnType<SchemaRagEngine['searchAsync']>;
}>;

export type AiSqlQueryExecutionInput = {
  request: QueryRequest;
  binding: ActiveDatabaseBinding;
  authorization: QueryAuthorization;
  signal?: AbortSignal;
};

export type AiSqlQueryExecution =
  | QueryExecutionResult
  | { result: QueryExecutionResult; handle: ResultHandle };

export type AiSqlQueryExecutor = (input: AiSqlQueryExecutionInput) => Promise<AiSqlQueryExecution>;

export type AiSqlResultContentInput = Readonly<{
  binding: ActiveDatabaseBinding;
  resultId: string;
  signal?: AbortSignal;
}>;

export type AiSqlResultContentResolver = (
  input: AiSqlResultContentInput,
) => Promise<ToolRetainedResultContent | undefined>;

type AiSqlToolSharedDependencies = {
  binding: ActiveDatabaseBinding;
  /** Distinguishes immutable handler closures captured by separate Tool generations. */
  handlerGeneration?: string;
  resultContent?: AiSqlResultContentResolver;
  ensureSchemaFresh?: (input: {
    binding: ActiveDatabaseBinding;
    force: boolean;
    signal?: AbortSignal;
  }) => Promise<ActiveDatabaseBinding>;
  onSchemaChanged?: (input: {
    binding: ActiveDatabaseBinding;
    sql: string;
    parsed: SqlParseResult;
    result: QueryExecutionResult;
  }) => void | Promise<void>;
};

type AiSqlToolCollectorDependencies = AiSqlToolSharedDependencies &
  Readonly<{ queryExecutor: AiSqlQueryExecutor }> & {
    registry: Pick<ToolRegistry, 'registerInvocation'>;
  };

export type AiSqlToolRuntimeDependencies = AiSqlToolSharedDependencies &
  Readonly<{ queryExecutor: AiSqlQueryExecutor }>;

export type AiSqlToolContributionSet = Readonly<{
  contributions: readonly ToolInvocationContribution[];
}>;

export function createAiSqlToolContributions(
  dependencies: AiSqlToolRuntimeDependencies,
): AiSqlToolContributionSet {
  const contributions: ToolInvocationContribution[] = [];
  const registry: Pick<ToolRegistry, 'registerInvocation'> = {
    registerInvocation(
      definition: ToolInvocationDefinition,
      runtime: ToolInvocationHandlerRuntime,
    ): void {
      contributions.push({ definition, runtime });
    },
  };
  collectAiSqlTools({ ...dependencies, registry });
  return Object.freeze({
    contributions: Object.freeze(contributions.slice()),
  });
}

function collectAiSqlTools(dependencies: AiSqlToolCollectorDependencies): void {
  const { registry } = dependencies;
  const resultContent = dependencies.resultContent;
  const handlerGeneration = dependencies.handlerGeneration === undefined
    ? ''
    : `:${dependencies.handlerGeneration}`;
  const resourceListRevision = databaseToolRevision('resource_list', `resource_list@3${handlerGeneration}`);
  const resourceGetRevision = databaseToolRevision('resource_get', `resource_get@3${handlerGeneration}`);
  const knowledgeSearchRevision = databaseToolRevision('knowledge_search', `knowledge_search@3${handlerGeneration}`);
  const sqlExecuteRevision = databaseToolRevision('sql_execute', `sql_execute@4${handlerGeneration}`);
  const sqlExplainRevision = databaseToolRevision('sql_explain', `sql_explain@3${handlerGeneration}`);

  registry.registerInvocation(
    {
      name: 'resource_list',
      description:
        'Primary fast path for database metadata: list resources inside an optional database, schema, or table scope before querying system catalogs.',
      inputSchema: objectSchema(
        {
          scope: {
            type: 'string',
            description:
              'Exact resource reference such as commerce or commerce.orders. Omit it when filtering globally by kind.',
          },
          kinds: {
            type: 'array',
            description: 'Resource kind filters such as schema, table, view, or column.',
            items: { type: 'string' },
          },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        [],
      ),
      outputSchema: DATABASE_OUTPUT_SCHEMA,
      dangerLevel: 'safe',
      readonly: true,
      source: 'schema-rag',
      exposure: 'direct',
      permission: { actions: ['read'] },
      access: 'read',
      recoveryClass: 'read',
      limits: DATABASE_TOOL_LIMITS,
      toolRevision: resourceListRevision.toolRevision,
      handlerRevision: resourceListRevision.handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: DATABASE_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    {
      revision: resourceListRevision,
      prepare: (args, context) => databaseReadIntent(args, context, dependencies.binding, 'List database resources.'),
      execute: async (args, context) => {
      let binding = dependencies.binding;
      let parentReference = optionalString(args, 'scope');
      let kinds = optionalStringArray(args, 'kinds');
      const limit = optionalPositiveInteger(args, 'limit', 200);
      let catalog = binding.schema.getCatalog();
      let parentId: string | undefined;
      const useCommonKindShorthand = () => {
        if (
          parentReference === undefined ||
          kinds !== undefined ||
          !Object.values(catalog.nodes).some((node) => node.kind === parentReference)
        ) {
          return false;
        }
        kinds = [parentReference];
        parentReference = undefined;
        parentId = undefined;
        return true;
      };
      try {
        parentId =
          parentReference === undefined
            ? undefined
            : resolveAgentResourceReference(catalog, parentReference);
      } catch (error) {
        if (!useCommonKindShorthand()) {
          if (!dependencies.ensureSchemaFresh) {
            throw expectedToolError('invalid_argument', resourceReferenceErrorMessage(error));
          }
          binding = await dependencies.ensureSchemaFresh({
            binding,
            force: true,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          catalog = binding.schema.getCatalog();
          try {
            parentId =
              parentReference === undefined
                ? undefined
                : resolveAgentResourceReference(catalog, parentReference);
          } catch (refreshedError) {
            if (!useCommonKindShorthand()) {
              throw expectedToolError('invalid_argument', resourceReferenceErrorMessage(refreshedError));
            }
          }
        }
      }
      const resolvedKinds = kinds;
      const nodes =
        parentReference === undefined && resolvedKinds !== undefined && resolvedKinds.length > 0
          ? Object.values(catalog.nodes)
              .filter((node) => resolvedKinds.includes(node.kind))
              .sort(
                (left, right) =>
                  left.kind.localeCompare(right.kind) ||
                  left.canonicalName.localeCompare(right.canonicalName) ||
                  left.resourceId.localeCompare(right.resourceId),
              )
              .slice(0, limit)
          : binding.schema.listResources({
              ...(parentId === undefined ? {} : { parentId }),
              ...(resolvedKinds === undefined ? {} : { kinds: resolvedKinds }),
              ...(limit === undefined ? {} : { limit }),
            });
      const projection = {
        resources: nodes.map((node) => projectResourceSummary(catalog, node)),
      };
      return projection;
      },
    },
  );

  registry.registerInvocation(
    {
      name: 'resource_get',
      description:
        'Read facts, named child entries, cross-resource relations, and business knowledge for an exact database reference such as public.orders.',
      inputSchema: objectSchema(
        {
          resource: { type: 'string' },
        },
        ['resource'],
      ),
      outputSchema: DATABASE_OUTPUT_SCHEMA,
      dangerLevel: 'safe',
      readonly: true,
      source: 'schema-rag',
      exposure: 'direct',
      permission: { actions: ['read'] },
      access: 'read',
      recoveryClass: 'read',
      limits: DATABASE_TOOL_LIMITS,
      toolRevision: resourceGetRevision.toolRevision,
      handlerRevision: resourceGetRevision.handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: DATABASE_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    {
      revision: resourceGetRevision,
      prepare: (args, context) => databaseReadIntent(args, context, dependencies.binding, 'Read a database resource.'),
      execute: async (args, context) => {
      let binding = dependencies.binding;
      const reference = requireString(args, 'resource');
      let catalog = binding.schema.getCatalog();
      let resourceId: string;
      try {
        resourceId = resolveAgentResourceReference(catalog, reference);
      } catch (error) {
        if (!dependencies.ensureSchemaFresh) {
          throw expectedToolError('invalid_argument', resourceReferenceErrorMessage(error));
        }
        binding = await dependencies.ensureSchemaFresh({
          binding,
          force: true,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        catalog = binding.schema.getCatalog();
        try {
          resourceId = resolveAgentResourceReference(catalog, reference);
        } catch (refreshedError) {
          throw expectedToolError('invalid_argument', resourceReferenceErrorMessage(refreshedError));
        }
      }
      const resource = binding.schema.getResource({ resourceId });
      const projection = projectResourceDetail(catalog, resource);
      return projection;
      },
    },
  );

  registry.registerInvocation(
    {
      name: 'knowledge_search',
      description:
        'Search schema facts and business knowledge using exact references, BM25, glossary, and relationship expansion within the active connection.',
      inputSchema: objectSchema(
        {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          maxContextTokens: { type: 'integer', minimum: 1 },
          expandHops: { type: 'integer', minimum: 0, maximum: 3 },
        },
        ['query'],
      ),
      outputSchema: DATABASE_OUTPUT_SCHEMA,
      dangerLevel: 'safe',
      readonly: true,
      source: 'schema-rag',
      exposure: 'direct',
      permission: { actions: ['read'] },
      access: 'read',
      recoveryClass: 'read',
      limits: DATABASE_TOOL_LIMITS,
      toolRevision: knowledgeSearchRevision.toolRevision,
      handlerRevision: knowledgeSearchRevision.handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: DATABASE_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    {
      revision: knowledgeSearchRevision,
      prepare: (args, context) => databaseReadIntent(args, context, dependencies.binding, 'Search database knowledge.'),
      execute: async (args, context) => {
      let binding = dependencies.binding;
      const query = requireString(args, 'query');
      const limit = optionalPositiveInteger(args, 'limit', 8);
      const maxContextTokens = optionalPositiveInteger(args, 'maxContextTokens', 1_500);
      const expandHops = optionalNonNegativeInteger(args, 'expandHops', 1);
      const search = () =>
        binding.schema.searchAsync({
          query,
          ...(limit === undefined ? {} : { limit }),
          ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
          ...(expandHops === undefined ? {} : { expandHops }),
          includeRelations: true,
        });
      let items = await search();
      if (items.length === 0 && dependencies.ensureSchemaFresh) {
        binding = await dependencies.ensureSchemaFresh({
          binding,
          force: true,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        items = await search();
      }
      const projection = {
        items: items.map(projectKnowledgeSearchResult),
      };
      return projection;
      },
    },
  );

  registry.registerInvocation(
    {
      name: 'sql_execute',
      title: 'Execute SQL',
      tags: ['database', 'sql', 'execute'],
      description:
        'Execute SQL on the active database. Query SQL is safe; mutations are external writes, and schema or administrative SQL also carries administrator risk.',
      inputSchema: objectSchema(
        {
          sql: { type: 'string' },
          maxRows: { type: 'integer', minimum: 1, maximum: DEFAULT_EXECUTION_ROWS },
          previewRows: { type: 'integer', minimum: 1, maximum: DEFAULT_PREVIEW_ROWS },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        ['sql'],
      ),
      outputSchema: DATABASE_OUTPUT_SCHEMA,
      dangerLevel: 'safe',
      readonly: false,
      source: 'database',
      sourceId: 'schemanaut.database',
      exposure: 'direct',
      access: 'external',
      recoveryClass: 'non_idempotent',
      limits: DATABASE_TOOL_LIMITS,
      toolRevision: sqlExecuteRevision.toolRevision,
      handlerRevision: sqlExecuteRevision.handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: DATABASE_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: {
        category: 'sql',
        preparingMessage: '正在准备或验证 SQL。',
        inputPreview: { argument: 'sql', label: 'SQL', language: 'sql' },
      },
    },
    {
      revision: sqlExecuteRevision,
      prepare: (args, context) => databaseSqlIntent(args, context, dependencies.binding, false),
      execute: async (args, context) => {
      const binding = dependencies.binding;
      const sql = requireString(args, 'sql');
      const parsed = parseSql(sql, { dialect: 'postgresql' });
      const maxRows = Math.min(
        optionalPositiveInteger(args, 'maxRows', DEFAULT_EXECUTION_ROWS) ?? DEFAULT_EXECUTION_ROWS,
        DEFAULT_EXECUTION_ROWS,
      );
      const previewRows = Math.min(
        optionalPositiveInteger(args, 'previewRows', DEFAULT_PREVIEW_ROWS) ?? DEFAULT_PREVIEW_ROWS,
        DEFAULT_PREVIEW_ROWS,
      );
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs');
      const authorization = queryAuthorization(context, parsed.requiredOperationClass);
      const execution = await executeQuery(
        dependencies,
        {
          connectionId: binding.connectionId,
          sql,
          ...(maxRows === undefined ? {} : { limit: maxRows }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(parsed.requiredOperationClass === 'query' ? {} : { confirmed: true }),
        },
        binding,
        authorization,
        context.signal,
      );
      const result = execution.result;
      const changesSchema = parsed.statementKinds.some((kind) => DDL_KINDS.has(kind));
      let schemaRefreshWarning: string | undefined;
      if (
        dependencies.onSchemaChanged &&
        result.transaction?.rolledBack !== true &&
        changesSchema
      ) {
        try {
          await dependencies.onSchemaChanged({
            binding,
            sql,
            parsed,
            result,
        });
        } catch {
          schemaRefreshWarning =
            'SQL 已成功执行，但 Schema 知识目录刷新失败。当前 Schema 可能尚未反映此变更；可刷新 Schema 或检索最新结构。';
        }
      }
      return {
        ...executionPreview(result, previewRows, schemaRefreshWarning),
        ...(execution.handle === undefined
          ? {}
          : { resultHandle: modelVisibleResultHandle(execution.handle) }),
      };
      },
      ...(resultContent === undefined
        ? {}
        : {
            retainResult: async (payload, context) => {
              const resultId = retainedResultId(payload);
              if (resultId === undefined) return undefined;
              return await resultContent({
                binding: dependencies.binding,
                resultId,
                signal: context.signal,
              });
            },
          }),
    },
  );

  registry.registerInvocation(
    {
      name: 'sql_explain',
      title: 'Explain SQL',
      tags: ['database', 'sql', 'explain'],
      description:
        'Return a PostgreSQL JSON query plan without running EXPLAIN ANALYZE or executing a write.',
      inputSchema: objectSchema(
        {
          sql: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        ['sql'],
      ),
      outputSchema: DATABASE_OUTPUT_SCHEMA,
      dangerLevel: 'safe',
      readonly: true,
      source: 'database',
      exposure: 'direct',
      permission: sqlPermissionDeclaration('query', dependencies.binding.host),
      access: 'external',
      recoveryClass: 'read',
      limits: DATABASE_TOOL_LIMITS,
      toolRevision: sqlExplainRevision.toolRevision,
      handlerRevision: sqlExplainRevision.handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: DATABASE_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: {
        category: 'sql',
        preparingMessage: '正在生成 SQL 执行计划。',
        inputPreview: { argument: 'sql', label: 'SQL', language: 'sql' },
      },
    },
    {
      revision: sqlExplainRevision,
      prepare: (args, context) => databaseSqlIntent(args, context, dependencies.binding, true),
      execute: async (args, context) => {
      const binding = dependencies.binding;
      const sql = requireString(args, 'sql');
      const parsed = parseSql(sql, { dialect: 'postgresql' });
      if (
        parsed.statementCount !== 1 ||
        parsed.requiredOperationClass !== 'query' ||
        parsed.statementKinds[0] === 'EXPLAIN'
      ) {
        throw expectedToolError('invalid_argument', 'sql_explain accepts exactly one non-EXPLAIN query.');
      }
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs');
      const authorization = queryAuthorization(context, 'query');
      const execution = await executeQuery(
        dependencies,
        {
          connectionId: binding.connectionId,
          sql: `EXPLAIN (FORMAT JSON) ${sql}`,
          limit: 10,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        binding,
        authorization,
        context.signal,
      );
      const projection = {
        plan: execution.result.rows[0] ?? null,
        elapsedMs: execution.result.elapsedMs,
      };
      return projection;
      },
    },
  );

}

function databaseToolRevision(name: string, handlerRevision: string) {
  return Object.freeze({
    toolName: name,
    toolRevision: `${name}.v1`,
    handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
  });
}

function databaseReadIntent(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
  binding: ActiveDatabaseBinding,
  summary: string,
): PreparedToolIntent {
  const targetIdentity = databaseIdentity(binding);
  const permission = databaseReadPermissionFacts(context, targetIdentity);
  return Object.freeze({
    input: Object.freeze(structuredClone(input)),
    toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision,
    intentRevision: context.intentRevision,
    targetIdentity,
    generation: context.generation,
    action: { summary },
    permission,
    access: 'read',
    recoveryClass: 'read',
    concurrency: 'read',
    resourceKeys: Object.freeze([`database-schema:${binding.connectionId}:${context.invocationId}`]),
    limits: Object.freeze({ ...context.limits }),
  });
}

function databaseSqlIntent(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
  binding: ActiveDatabaseBinding,
  explainOnly: boolean,
): PreparedToolIntent {
  const sql = requireString(input, 'sql');
  const parsed = parseSql(sql, { dialect: 'postgresql' });
  if (
    explainOnly && (
      parsed.statementCount !== 1 ||
      parsed.requiredOperationClass !== 'query' ||
      parsed.statementKinds[0] === 'EXPLAIN'
    )
  ) {
    throw expectedToolError('invalid_argument', 'sql_explain accepts exactly one non-EXPLAIN query.');
  }
  const timeoutMs = optionalPositiveInteger(input, 'timeoutMs');
  const preparedInput: Record<string, PortableValue> = { sql };
  if (input.maxRows !== undefined) preparedInput.maxRows = input.maxRows;
  if (input.previewRows !== undefined) preparedInput.previewRows = input.previewRows;
  if (timeoutMs !== undefined) preparedInput.timeoutMs = timeoutMs;
  const permission = databaseSqlPermissionFacts(context, binding, parsed.requiredOperationClass);
  const targetIdentity = {
    ...databaseIdentity(binding),
    operationClass: parsed.requiredOperationClass,
    statementKinds: [...parsed.statementKinds],
    sql,
  };
  return Object.freeze({
    input: Object.freeze(preparedInput),
    toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision,
    intentRevision: context.intentRevision,
    targetIdentity,
    generation: context.generation,
    action: {
      summary: explainOnly
        ? 'Explain a database query.'
        : `Execute ${parsed.requiredOperationClass} SQL on the active database.`,
    },
    permission,
    access: permission.access,
    recoveryClass: permission.recoveryClass,
    concurrency: 'exclusive',
    resourceKeys: Object.freeze([`database:${binding.connectionId}`]),
    limits: Object.freeze({
      ...context.limits,
      ...(timeoutMs === undefined ? {} : { timeoutMs: Math.min(context.limits.timeoutMs, timeoutMs) }),
    }),
  });
}

function databaseIdentity(binding: ActiveDatabaseBinding): Record<string, PortableValue> {
  return {
    kind: 'database-connection',
    connectionId: binding.connectionId,
    profileId: binding.profileId,
    ...(binding.host?.trim() ? { host: binding.host.trim().toLocaleLowerCase() } : {}),
  };
}

function databaseReadPermissionFacts(
  context: ToolPrepareContext,
  target: Record<string, PortableValue>,
): AgentToolPermissionFacts {
  return Object.freeze({
    toolName: context.descriptor.flatName,
    dangerLevel: 'safe',
    readonly: true,
    access: 'read',
    recoveryClass: 'read',
    actions: Object.freeze(['read'] as const),
    paths: Object.freeze([]),
    hosts: Object.freeze([]),
    network: false,
    externalWrite: false,
    destructive: false,
    credentials: false,
    admin: false,
    unknownRisk: false,
    resolvedAddresses: Object.freeze([]),
    targets: Object.freeze([target]),
  });
}

function databaseSqlPermissionFacts(
  context: ToolPrepareContext,
  binding: ActiveDatabaseBinding,
  operationClass: SqlOperationClass,
): AgentToolPermissionFacts {
  const declaration = sqlPermissionDeclaration(operationClass, binding.host);
  const readonly = operationClass === 'query';
  return Object.freeze({
    toolName: context.descriptor.flatName,
    dangerLevel: 'safe',
    readonly,
    access: 'external',
    recoveryClass: readonly ? 'read' : 'non_idempotent',
    actions: Object.freeze([...(declaration.actions ?? [])]),
    paths: Object.freeze([]),
    hosts: Object.freeze([...(declaration.hosts ?? [])]),
    network: declaration.network === true,
    externalWrite: declaration.externalWrite === true,
    destructive: declaration.destructive === true,
    credentials: declaration.credentials === true,
    admin: declaration.admin === true,
    unknownRisk: false,
    resolvedAddresses: Object.freeze([]),
    targets: Object.freeze([{
      ...databaseIdentity(binding),
      operationClass,
      generation: context.generation,
      handlerRevision: context.handlerRevision,
    }]),
  });
}

async function executeQuery(
  dependencies: AiSqlToolCollectorDependencies,
  request: QueryRequest,
  binding: ActiveDatabaseBinding,
  authorization: QueryAuthorization,
  signal?: AbortSignal,
): Promise<{ result: QueryExecutionResult; handle?: ResultHandle }> {
  try {
    const execution = await dependencies.queryExecutor({
      request,
      binding,
      authorization,
      ...(signal === undefined ? {} : { signal }),
    });
    return isDurableQueryExecution(execution)
      ? { result: execution.result, handle: execution.handle }
      : { result: execution };
  } catch (error) {
    if (error instanceof DatabaseAccessRuntimeError) {
      throw databaseToolExecutionError(error);
    }
    throw error;
  }
}

function isDurableQueryExecution(
  execution: AiSqlQueryExecution,
): execution is { result: QueryExecutionResult; handle: ResultHandle } {
  return 'result' in execution && 'handle' in execution;
}

function databaseExecutionErrorMessage(error: DatabaseAccessRuntimeError): string {
  const detail = error.error.detail?.trim();
  return detail && detail !== error.error.message
    ? `${error.error.message} ${detail}`
    : error.error.message;
}

function databaseToolExecutionError(error: DatabaseAccessRuntimeError): ToolExecutionError {
  const category = error.error.category;
  const code = category === 'authentication' || category === 'authorization'
    ? 'TOOL_PERMISSION_DENIED'
    : category === 'timeout'
      ? 'TOOL_TIMEOUT'
      : category === 'cancelled'
        ? 'TOOL_CANCELLED'
        : category === 'validation' || category === 'syntax'
          ? 'TOOL_INPUT_INVALID'
          : category === 'conflict' || category === 'transaction' || category === 'lock'
            ? 'TOOL_CONFLICT'
            : category === 'not-found' || category === 'unsupported'
              ? 'TOOL_RESOURCE_NOT_FOUND'
              : 'TOOL_EXTERNAL_FAILED';
  const toolCategory = category === 'authentication' || category === 'authorization'
    ? 'authorization'
    : category === 'timeout'
      ? 'timeout'
      : category === 'cancelled'
        ? 'cancelled'
        : category === 'validation' || category === 'syntax'
          ? 'validation'
          : category === 'conflict' || category === 'transaction' || category === 'lock'
            ? 'conflict'
            : 'external';
  return new ToolExecutionError({
    code,
    category: toolCategory,
    retryable: error.error.retryable,
    outcome: error.error.outcome === 'unchanged' ? 'not_applied' : 'unknown',
  }, databaseExecutionErrorMessage(error));
}

function resourceReferenceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queryAuthorization(
  context: ToolInvocationExecutionContext,
  requiredOperationClass: SqlOperationClass,
): QueryAuthorization {
  const authorization = context.authorization;
  const expected = sqlPermissionDeclaration(requiredOperationClass);
  if (!expected.actions?.every((action) => authorization.permission.actions.includes(action))) {
    throw expectedToolError('conflict', 'SQL authorization facts do not match the parsed database operation.');
  }
  if (expected.externalWrite === true && authorization.permission.externalWrite !== true) {
    throw expectedToolError('precondition', 'The current authorization does not permit this database write.');
  }
  if (expected.network === true && authorization.permission.network !== true) {
    throw expectedToolError('precondition', 'The current authorization does not permit database network access.');
  }
  if (expected.admin === true && authorization.permission.admin !== true) {
    throw expectedToolError('precondition', 'The current authorization does not permit this database administrative operation.');
  }
  if (authorization.policyDecision === 'deny') {
    throw expectedToolError('precondition', 'The current authorization denies this database operation.');
  }
  return {
    ...(authorization.approvalId === undefined
      ? {}
      : { approvalId: authorization.approvalId }),
    authorizedClass: requiredOperationClass,
  };
}

function sqlPermissionDeclaration(
  operationClass: SqlOperationClass,
  host?: string,
): AgentToolPermissionDeclaration {
  const target = host?.trim() ? { hosts: [host.trim().toLocaleLowerCase()] } : {};
  if (operationClass === 'query') {
    return { actions: ['database-query'], network: true, ...target };
  }
  if (operationClass === 'mutation') {
    return { actions: ['database-mutation'], network: true, externalWrite: true, ...target };
  }
  return {
    actions: ['database-schema'],
    network: true,
    externalWrite: true,
    admin: true,
    ...target,
  };
}

function executionPreview(
  result: QueryExecutionResult,
  previewRows = DEFAULT_PREVIEW_ROWS,
  schemaRefreshWarning?: string,
): Record<string, unknown> {
  const bounded = boundedModelRows(
    result.rows,
    previewRows,
    MAX_MODEL_RESULT_CHARS,
    result.sessionTimeZone,
  );
  return {
    columns: modelVisibleColumns(result.columns),
    rows: bounded.rows,
    ...(result.sessionTimeZone === undefined
      ? {}
      : {
          dateTimePresentation: {
            format: 'local-iso-8601',
            timeZone: result.sessionTimeZone,
          },
        }),
    rowCount: result.rowCount,
    returnedRowCount: result.returnedRowCount ?? result.rows.length,
    hasMoreInDatabase: result.hasMore === true,
    truncatedByDriver: result.truncated === true,
    previewTruncated: result.rows.length > bounded.rows.length || bounded.valuesTruncated,
    ...(bounded.valuesTruncated ? { valuesTruncated: true } : {}),
    elapsedMs: result.elapsedMs,
    ...(result.transaction === undefined ? {} : { transaction: result.transaction }),
    messages: [
      ...(result.messages ?? []),
      ...(schemaRefreshWarning === undefined
        ? []
        : [{ level: 'warning', message: schemaRefreshWarning }]),
    ],
  };
}

function modelVisibleResultHandle(handle: ResultHandle): Record<string, PortableValue> {
  return {
    id: handle.id,
    format: handle.format,
    columns: modelVisibleColumns(handle.columns),
    ...(handle.rowCount === undefined ? {} : { rowCount: handle.rowCount }),
    ...(handle.byteCount === undefined ? {} : { byteCount: handle.byteCount }),
    ...(handle.hasMore === undefined ? {} : { hasMore: handle.hasMore }),
    ...(handle.truncated === undefined ? {} : { truncated: handle.truncated }),
    ...(handle.expiresAt === undefined ? {} : { expiresAt: handle.expiresAt }),
  };
}

function retainedResultId(payload: PortableValue): string | undefined {
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    !('resultHandle' in payload)
  ) return undefined;
  const handle = payload.resultHandle;
  if (
    handle === null || typeof handle !== 'object' || Array.isArray(handle) ||
    !('id' in handle)
  ) return undefined;
  const id = handle.id;
  return typeof id === 'string' && id.trim() !== '' && id.length <= 512 ? id : undefined;
}

function boundedModelRows(
  input: QueryResultRow[],
  maxRows: number,
  maxBytes: number,
  sessionTimeZone?: string,
): { rows: Array<Record<string, PortableValue>>; valuesTruncated: boolean } {
  const rows: Array<Record<string, PortableValue>> = [];
  let bytes = 2;
  let valuesTruncated = false;
  for (const row of input.slice(0, maxRows)) {
    const projectedRow = projectModelRow(row, sessionTimeZone);
    const rowBytes = portableJsonBytes(projectedRow);
    if (bytes + rowBytes <= maxBytes) {
      rows.push(projectedRow);
      bytes += rowBytes + 1;
      continue;
    }
    if (rows.length === 0) {
      rows.push(truncateModelRow(projectedRow, Math.max(512, maxBytes - bytes)));
      valuesTruncated = true;
    }
    break;
  }
  return { rows, valuesTruncated };
}

function projectModelRow(
  row: QueryResultRow,
  sessionTimeZone?: string,
): Record<string, PortableValue> {
  const formatter = modelDateTimeFormatter(sessionTimeZone);
  return projectModelValue(row, formatter) as Record<string, PortableValue>;
}

function modelDateTimeFormatter(sessionTimeZone?: string): Intl.DateTimeFormat | undefined {
  if (sessionTimeZone === undefined) return undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: sessionTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
    });
  } catch {
    return undefined;
  }
}

function projectModelValue(
  value: unknown,
  formatter: Intl.DateTimeFormat | undefined,
): PortableValue {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return value.toString();
    if (formatter === undefined) return value.toISOString();
    const parts = formatter.formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}`;
  }
  if (Array.isArray(value)) return value.map((item) => projectModelValue(item, formatter));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, projectModelValue(item, formatter)]),
    );
  }
  return toPortableValue(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function truncateModelRow(
  row: Readonly<Record<string, PortableValue>>,
  maxChars: number,
): Record<string, PortableValue> {
  const entries = Object.entries(row);
  if (entries.length === 0 || maxChars < 2) return {};
  let perValue = Math.max(16, Math.floor(maxChars / entries.length));
  while (perValue >= 8) {
    const candidate = Object.fromEntries(
      entries.map(([key, value]) => {
        const serialized = typeof value === 'string' ? value : stringifyPublicJson(value);
        if (Buffer.byteLength(serialized) <= perValue) {
          return [key, structuredClone(value)];
        }
        return [key, truncateStringByBytes(serialized, perValue)];
      }),
    );
    if (portableJsonBytes(candidate) <= maxChars) return candidate;
    perValue = Math.floor(perValue * 0.75);
  }
  return {};
}

function portableJsonBytes(value: unknown): number {
  return Buffer.byteLength(stringifyPublicJson(value));
}

function truncateStringByBytes(value: string, maxBytes: number): string {
  const suffix = '...[truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return utf8Prefix(suffix, maxBytes);
  return `${utf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function modelVisibleColumns(
  columns: QueryExecutionResult['columns'],
): QueryExecutionResult['columns'] {
  return columns.map((column) => ({
    name: column.name,
    ...(column.dataType && !/^\d+$/.test(column.dataType) ? { dataType: column.dataType } : {}),
  }));
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw expectedToolError('invalid_argument', `The ${key} argument is invalid.`);
  }
  const stringValues: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw expectedToolError('invalid_argument', `The ${key} argument is invalid.`);
    }
    stringValues.push(item);
  }
  const values = [
    ...new Set(stringValues.map((item) => item.trim()).filter((item) => item.length > 0)),
  ];
  return values.length > 0 ? values : undefined;
}

function optionalNonNegativeInteger(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const value = args[key] ?? fallback;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw expectedToolError('invalid_argument', `The ${key} argument is invalid.`);
  }
  return value;
}
