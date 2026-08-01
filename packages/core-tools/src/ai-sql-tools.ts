import { randomUUID } from 'node:crypto';
import {
  createAgentToolResultEnvelope,
  type AgentAccessMode,
  type AgentToolContext,
  type ToolRegistry,
} from '@dbagent/core-agent';
import {
  DatabaseAccessRuntimeError,
  parseSql,
  type IDatabaseDriver,
  type SqlParseResult,
} from '@dbagent/core-db';
import type { SchemaRagEngine } from '@dbagent/core-rag';
import type {
  QueryAuthorization,
  QueryExecutionResult,
  QueryRequest,
  QueryResultRow,
  SavedConnection,
} from '@dbagent/shared';
import { stringifyPublicJson } from '@dbagent/shared';
import {
  projectKnowledgeSearchResult,
  projectResourceDetail,
  projectResourceSummary,
  resolveAgentResourceReference,
} from './agent-knowledge-projection.js';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const DEFAULT_PREVIEW_ROWS = 100;
const DEFAULT_EXECUTION_ROWS = 1_000;
const DEFAULT_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_STORED_RESULTS = 100;
const DEFAULT_MAX_STORED_RESULT_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_STORED_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_RESULT_CHARS = 64 * 1024;
const MAX_RESULT_READ_ROWS = 1_000;
const DDL_KINDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'COMMENT', 'RENAME']);

export type ActiveDatabaseConnection = {
  connectionId: string;
  connection: SavedConnection;
};

export type AiSqlQueryExecutionInput = {
  request: QueryRequest;
  connection: SavedConnection;
  authorization: QueryAuthorization;
  signal?: AbortSignal;
};

export type AiSqlQueryExecutor = (input: AiSqlQueryExecutionInput) => Promise<QueryExecutionResult>;

export type AiSqlToolDependencies = {
  registry: ToolRegistry;
  driver: IDatabaseDriver;
  /**
   * Product runtimes use this boundary to execute through their unified
   * database access layer. Driver execution remains the compatibility
   * fallback for isolated tool tests and embedded custom-driver use.
   */
  queryExecutor?: AiSqlQueryExecutor;
  rag: SchemaRagEngine;
  getActiveConnection: () =>
    | ActiveDatabaseConnection
    | undefined
    | Promise<ActiveDatabaseConnection | undefined>;
  resultStore?: AiSqlResultStore;
  ensureSchemaFresh?: (input: {
    connectionId: string;
    force: boolean;
    signal?: AbortSignal;
  }) => Promise<void>;
  onSchemaChanged?: (input: {
    connectionId: string;
    sql: string;
    parsed: SqlParseResult;
    result: QueryExecutionResult;
  }) => void | Promise<void>;
};

export type StoredAiSqlResult = {
  id: string;
  sessionId: string;
  connectionId: string;
  sql?: string;
  result: QueryExecutionResult;
  createdAt: string;
  expiresAt: string;
};

export class AiSqlResultStore {
  readonly #results = new Map<string, StoredAiSqlResult>();
  readonly #storedBytes = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #maxEntries: number;
  readonly #maxResultChars: number;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;

  constructor(
    options: {
      ttlMs?: number;
      now?: () => Date;
      createId?: () => string;
      maxEntries?: number;
      maxResultChars?: number;
      maxTotalBytes?: number;
    } = {},
  ) {
    this.#ttlMs = normalizePositiveInteger(options.ttlMs, DEFAULT_RESULT_TTL_MS);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#maxEntries = normalizePositiveInteger(options.maxEntries, DEFAULT_MAX_STORED_RESULTS);
    this.#maxResultChars = normalizePositiveInteger(
      options.maxResultChars,
      DEFAULT_MAX_STORED_RESULT_CHARS,
    );
    this.#maxTotalBytes = normalizePositiveInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_STORED_RESULT_BYTES,
    );
  }

  put(input: {
    sessionId: string;
    connectionId: string;
    sql?: string;
    result: QueryExecutionResult;
  }): StoredAiSqlResult {
    this.prune();
    const now = this.#now();
    const item: StoredAiSqlResult = {
      id: this.#createId(),
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      ...(input.sql === undefined ? {} : { sql: input.sql }),
      result: capStoredQueryResult(input.result, this.#maxResultChars),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    if (this.#results.has(item.id)) {
      throw new Error(`Result handle ID ${item.id} already exists.`);
    }
    const itemBytes = portableJsonBytes(item);
    if (itemBytes > this.#maxTotalBytes) {
      throw new Error(
        `Stored result requires ${itemBytes} bytes, exceeding the ${this.#maxTotalBytes}-byte total result budget.`,
      );
    }
    while (
      this.#results.size >= this.#maxEntries ||
      this.#totalBytes + itemBytes > this.#maxTotalBytes
    ) {
      const oldestId = this.#results.keys().next().value;
      if (oldestId === undefined) break;
      this.deleteResult(oldestId);
    }
    this.#results.set(item.id, item);
    this.#storedBytes.set(item.id, itemBytes);
    this.#totalBytes += itemBytes;
    return structuredClone(item);
  }

  read(input: { id: string; sessionId: string; cursor?: string; limit?: number }): {
    id: string;
    columns: QueryExecutionResult['columns'];
    rows: QueryResultRow[];
    offset: number;
    returnedRowCount: number;
    totalStoredRows: number;
    nextCursor?: string;
    truncated: boolean;
    valuesTruncated?: boolean;
  } {
    this.prune();
    const item = this.#results.get(input.id);
    if (!item || item.sessionId !== input.sessionId) {
      throw new Error('Result handle is missing, expired, or belongs to another session.');
    }
    const offset = parseCursor(input.cursor);
    const limit = Math.min(normalizePositiveInteger(input.limit, 20), MAX_RESULT_READ_ROWS);
    const rows = structuredClone(item.result.rows.slice(offset, offset + limit));
    const nextOffset = offset + rows.length;
    return {
      id: item.id,
      columns: modelVisibleColumns(item.result.columns),
      rows,
      offset,
      returnedRowCount: rows.length,
      totalStoredRows: item.result.rows.length,
      ...(nextOffset < item.result.rows.length ? { nextCursor: String(nextOffset) } : {}),
      truncated: item.result.truncated === true || item.result.hasMore === true,
    };
  }

  listSession(sessionId: string): StoredAiSqlResult[] {
    this.prune();
    return [...this.#results.values()]
      .filter((item) => item.sessionId === sessionId)
      .map((item) => structuredClone(item));
  }

  remove(id: string): boolean {
    return this.deleteResult(id);
  }

  clearSession(sessionId: string): number {
    let removed = 0;
    for (const [id, item] of this.#results) {
      if (item.sessionId === sessionId && this.deleteResult(id)) removed += 1;
    }
    return removed;
  }

  clear(): number {
    const removed = this.#results.size;
    this.#results.clear();
    this.#storedBytes.clear();
    this.#totalBytes = 0;
    return removed;
  }

  prune(): number {
    const now = this.#now().getTime();
    let removed = 0;
    for (const [id, item] of this.#results) {
      if (Date.parse(item.expiresAt) <= now && this.deleteResult(id)) removed += 1;
    }
    return removed;
  }

  private deleteResult(id: string): boolean {
    if (!this.#results.delete(id)) return false;
    this.#totalBytes = Math.max(0, this.#totalBytes - (this.#storedBytes.get(id) ?? 0));
    this.#storedBytes.delete(id);
    return true;
  }
}

function capStoredQueryResult(
  result: QueryExecutionResult,
  maxBytes: number,
  maxRows = DEFAULT_EXECUTION_ROWS,
): QueryExecutionResult {
  const { rows: allRows, resultSets: sourceResultSets, ...metadata } = result;
  const sourceRows = allRows.slice(0, maxRows);
  const rowLimitReached = allRows.length > sourceRows.length;
  let valueTruncationReached = false;
  const clonedMetadata = structuredClone(metadata);
  const cappedResultSets = (sourceResultSets ?? []).map((resultSet) => {
    const { rows, ...resultSetMetadata } = resultSet;
    return {
      ...structuredClone(resultSetMetadata),
      rows: [],
      returnedRowCount: 0,
      truncated: resultSet.truncated === true || rows.length > 0,
    };
  });

  const buildResult = (rows: QueryResultRow[]): QueryExecutionResult => {
    const nestedResultsTruncated =
      sourceResultSets !== undefined &&
      (cappedResultSets.length < sourceResultSets.length ||
        cappedResultSets.some((resultSet) => resultSet.truncated === true));
    return {
      ...clonedMetadata,
      rows,
      returnedRowCount: rows.length,
      hasMore: result.hasMore === true || rowLimitReached,
      truncated:
        result.truncated === true ||
        rowLimitReached ||
        valueTruncationReached ||
        rows.length < sourceRows.length ||
        nestedResultsTruncated,
      ...(sourceResultSets === undefined
        ? {}
        : { resultSets: structuredClone(cappedResultSets) }),
    };
  };

  let output = buildResult([]);
  while (portableJsonBytes(output) > maxBytes && cappedResultSets.length > 0) {
    cappedResultSets.pop();
    output = buildResult([]);
  }
  const emptyResultBytes = portableJsonBytes(output);
  if (emptyResultBytes > maxBytes) {
    throw new Error(
      `Stored result metadata requires ${emptyResultBytes} bytes, exceeding the ${maxBytes}-byte per-result limit.`,
    );
  }

  const rows: QueryResultRow[] = [];
  const rowBudget = Math.max(0, maxBytes - emptyResultBytes + 2 - 16);
  let usedRowBytes = 0;
  for (const row of sourceRows) {
    const rowBytes = portableJsonBytes(row);
    const separatorBytes = rows.length === 0 ? 0 : 1;
    if (usedRowBytes + separatorBytes + rowBytes > rowBudget) break;
    rows.push(structuredClone(row));
    usedRowBytes += separatorBytes + rowBytes;
  }

  output = buildResult(rows);
  while (rows.length > 0 && portableJsonBytes(output) > maxBytes) {
    rows.pop();
    output = buildResult(rows);
  }

  if (rows.length === 0 && sourceRows.length > 0) {
    const truncatedRow = truncateModelRow(sourceRows[0]!, rowBudget);
    rows.push(truncatedRow);
    valueTruncationReached = true;
    output = buildResult(rows);
    if (portableJsonBytes(output) > maxBytes) {
      rows.pop();
      output = buildResult(rows);
    }
  }
  return output;
}

export function registerAiSqlTools(dependencies: AiSqlToolDependencies): AiSqlResultStore {
  const resultStore = dependencies.resultStore ?? new AiSqlResultStore();
  const { registry, rag } = dependencies;

  registry.register(
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
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'schema-rag',
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      let parentReference = optionalString(args, 'scope');
      let kinds = optionalStringArray(args, 'kinds');
      const limit = optionalPositiveInteger(args, 'limit', 200);
      let catalog = rag.getCatalog(active.connectionId);
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
          if (!dependencies.ensureSchemaFresh) throw error;
          await dependencies.ensureSchemaFresh({
            connectionId: active.connectionId,
            force: true,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          catalog = rag.getCatalog(active.connectionId);
          try {
            parentId =
              parentReference === undefined
                ? undefined
                : resolveAgentResourceReference(catalog, parentReference);
          } catch (refreshedError) {
            if (!useCommonKindShorthand()) throw refreshedError;
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
          : rag.listResources({
              connectionId: active.connectionId,
              ...(parentId === undefined ? {} : { parentId }),
              ...(resolvedKinds === undefined ? {} : { kinds: resolvedKinds }),
              ...(limit === undefined ? {} : { limit }),
            });
      return {
        resources: nodes.map((node) => projectResourceSummary(catalog, node)),
      };
    },
  );

  registry.register(
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
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'schema-rag',
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const reference = requireString(args, 'resource');
      let catalog = rag.getCatalog(active.connectionId);
      let resourceId: string;
      try {
        resourceId = resolveAgentResourceReference(catalog, reference);
      } catch (error) {
        if (!dependencies.ensureSchemaFresh) throw error;
        await dependencies.ensureSchemaFresh({
          connectionId: active.connectionId,
          force: true,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        catalog = rag.getCatalog(active.connectionId);
        resourceId = resolveAgentResourceReference(catalog, reference);
      }
      const resource = rag.getResource({ connectionId: active.connectionId, resourceId });
      return projectResourceDetail(catalog, resource);
    },
  );

  registry.register(
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
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'schema-rag',
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const query = requireString(args, 'query');
      const limit = optionalPositiveInteger(args, 'limit', 8);
      const maxContextTokens = optionalPositiveInteger(args, 'maxContextTokens', 1_500);
      const expandHops = optionalNonNegativeInteger(args, 'expandHops', 1);
      const search = () =>
        rag.searchAsync({
        connectionId: active.connectionId,
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
        ...(expandHops === undefined ? {} : { expandHops }),
        includeRelations: true,
      });
      let items = await search();
      if (items.length === 0 && dependencies.ensureSchemaFresh) {
        await dependencies.ensureSchemaFresh({
          connectionId: active.connectionId,
          force: true,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        items = await search();
      }
      return {
        items: items.map(projectKnowledgeSearchResult),
      };
    },
  );

  registry.register(
    {
      name: 'sql_execute',
      description:
        'Execute SQL on the active database. Permission is calculated from the actual SQL: read for queries, edit for row changes, and full for schema or administrative changes.',
      inputSchema: objectSchema(
        {
          sql: { type: 'string' },
          maxRows: { type: 'integer', minimum: 1, maximum: DEFAULT_EXECUTION_ROWS },
          previewRows: { type: 'integer', minimum: 1, maximum: DEFAULT_PREVIEW_ROWS },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        ['sql'],
      ),
      dangerLevel: 'high',
      readonly: false,
      source: 'database',
      completion: {
        role: 'deliverable',
        group: 'database-execution',
      },
      resolveRequiredPermission: (args) =>
        parseSql(typeof args.sql === 'string' ? args.sql : '', {
          dialect: 'postgresql',
        }).requiredPermission,
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const sql = requireString(args, 'sql');
      const parsed = parseSql(sql, { dialect: 'postgresql' });
      const maxRows = Math.min(
        optionalPositiveInteger(args, 'maxRows', DEFAULT_EXECUTION_ROWS) ??
          DEFAULT_EXECUTION_ROWS,
        DEFAULT_EXECUTION_ROWS,
      );
      const previewRows = Math.min(
        optionalPositiveInteger(args, 'previewRows', DEFAULT_PREVIEW_ROWS) ?? DEFAULT_PREVIEW_ROWS,
        DEFAULT_PREVIEW_ROWS,
      );
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs');
      const authorization = queryAuthorization(context, 'sql_execute', parsed.requiredPermission);
      const result = await executeQuery(
        dependencies,
        {
          connectionId: active.connectionId,
          sql,
          ...(maxRows === undefined ? {} : { limit: maxRows }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(parsed.requiredPermission === 'read' ? {} : { confirmed: true }),
        },
        active.connection,
        authorization,
        context.signal,
      );
      const stored = resultStore.put({
        sessionId: context.session.id,
        connectionId: active.connectionId,
        sql,
        result,
      });
      const changesSchema = parsed.statementKinds.some((kind) => DDL_KINDS.has(kind));
      let schemaRefresh: NonNullable<
        ReturnType<typeof runtimeCompletionEvidence>['schemaRefresh']
      > = changesSchema
        ? result.transaction?.rolledBack === true
          ? 'rolled-back'
          : dependencies.onSchemaChanged
            ? 'refreshed'
            : 'failed'
        : 'not-required';
      let schemaRefreshWarning: string | undefined;
      if (
        dependencies.onSchemaChanged &&
        result.transaction?.rolledBack !== true &&
        changesSchema
      ) {
        try {
          await dependencies.onSchemaChanged({
            connectionId: active.connectionId,
            sql,
            parsed,
            result,
          });
        } catch {
          schemaRefresh = 'failed';
          schemaRefreshWarning =
            'SQL 已成功执行，但 Schema 知识目录刷新失败。不要重新执行该 DDL；请手动刷新 Schema 后再检索新结构。';
        }
      }
      const modelProjection = executionPreview(
        stored.result,
        previewRows,
        schemaRefreshWarning,
      );
      return createAgentToolResultEnvelope({
        modelProjection,
        durableSummary: executionSummary(modelProjection),
        completionEvidence: runtimeCompletionEvidence({
          parsed,
          result: stored.result,
          schemaRefresh,
        }),
      });
    },
  );

  registry.register(
    {
      name: 'sql_explain',
      description:
        'Return a PostgreSQL JSON query plan without running EXPLAIN ANALYZE or executing a write.',
      inputSchema: objectSchema(
        {
          sql: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        ['sql'],
      ),
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'database',
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const sql = requireString(args, 'sql');
      const parsed = parseSql(sql, { dialect: 'postgresql' });
      if (
        parsed.statementCount !== 1 ||
        parsed.requiredPermission !== 'read' ||
        parsed.statementKinds[0] === 'EXPLAIN'
      ) {
        throw new Error('sql_explain accepts exactly one non-EXPLAIN read query.');
      }
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs');
      const authorization = queryAuthorization(context, 'sql_explain', 'read');
      const result = await executeQuery(
        dependencies,
        {
          connectionId: active.connectionId,
          sql: `EXPLAIN (FORMAT JSON) ${sql}`,
          limit: 10,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        active.connection,
        authorization,
        context.signal,
      );
      return {
        plan: result.rows[0] ?? null,
        elapsedMs: result.elapsedMs,
      };
    },
  );

  return resultStore;
}

async function executeQuery(
  dependencies: AiSqlToolDependencies,
  request: QueryRequest,
  connection: SavedConnection,
  authorization: QueryAuthorization,
  signal?: AbortSignal,
): Promise<QueryExecutionResult> {
  const executionConnection =
    authorization.permissionMode === 'read' ? { ...connection, readOnly: true } : connection;
  if (dependencies.queryExecutor) {
    try {
      return await dependencies.queryExecutor({
        request,
        connection: executionConnection,
        authorization,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DatabaseAccessRuntimeError) {
        throw new Error(databaseExecutionErrorMessage(error));
      }
      throw error;
    }
  }
  const execution = await dependencies.driver.execute(
    request,
    executionConnection,
    signal === undefined ? undefined : { signal },
  );
  if (!execution.ok) throw new Error(execution.error.message);
  return execution.data;
}

function databaseExecutionErrorMessage(error: DatabaseAccessRuntimeError): string {
  const detail = error.error.detail?.trim();
  return detail && detail !== error.error.message
    ? `${error.error.message} ${detail}`
    : error.error.message;
}

function queryAuthorization(
  context: AgentToolContext,
  toolName: string,
  requiredPermission: AgentAccessMode,
): QueryAuthorization {
  let effectivePermission = context.session.mode;
  let approvalId: string | undefined;
  if (accessRank(effectivePermission) < accessRank(requiredPermission)) {
    const invocation = context.invocation;
    const approval =
      invocation?.toolName === toolName && invocation.requiredPermission === requiredPermission
        ? context.executionGrant?.claim({
            sessionId: context.session.id,
            toolCallId: invocation.toolCallId,
            toolName: invocation.toolName,
            requiredPermission,
          })
        : undefined;
    if (!approval) {
      throw new Error(
        `${toolName} requires ${requiredPermission} permission or a one-time approval for this Tool Call.`,
      );
    }
    effectivePermission = requiredPermission;
    approvalId = approval.requestId;
  }
  return {
    ...(context.session.userId === undefined ? {} : { actorId: context.session.userId }),
    ...(approvalId === undefined ? {} : { approvalId }),
    permissionMode: permissionMode(effectivePermission),
  };
}

function permissionMode(mode: AgentAccessMode): NonNullable<QueryAuthorization['permissionMode']> {
  return mode;
}

function accessRank(mode: AgentAccessMode): number {
  if (mode === 'read') return 0;
  if (mode === 'edit') return 1;
  return 2;
}

function executionPreview(
  result: QueryExecutionResult,
  previewRows = DEFAULT_PREVIEW_ROWS,
  schemaRefreshWarning?: string,
): Record<string, unknown> {
  const bounded = boundedModelRows(result.rows, previewRows, MAX_MODEL_RESULT_CHARS);
  return {
    columns: modelVisibleColumns(result.columns),
    rows: bounded.rows,
    rowCount: result.rowCount,
    returnedRowCount: result.returnedRowCount ?? result.rows.length,
    storedRowCount: result.rows.length,
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

function executionSummary(preview: Record<string, unknown>): Record<string, unknown> {
  const { rows: _rows, ...summary } = preview;
  void _rows;
  return summary;
}

function runtimeCompletionEvidence(input: {
  parsed: SqlParseResult;
  result: QueryExecutionResult;
  schemaRefresh: 'not-required' | 'refreshed' | 'failed' | 'rolled-back';
}) {
  const transactionOutcome =
    input.result.transaction?.rolledBack === true
      ? ('rolled-back' as const)
      : input.result.transaction?.committed === true
        ? ('committed' as const)
        : ('not-started' as const);
  return {
    kind:
      input.parsed.requiredPermission === 'read'
        ? ('database-result' as const)
        : ('database-write' as const),
    deliveryReady: true,
    source: 'runtime' as const,
    executionId: input.result.queryId,
    statementKinds: [...input.parsed.statementKinds],
    requiredPermission: input.parsed.requiredPermission,
    rowCount: input.result.rowCount,
    returnedRowCount: input.result.returnedRowCount ?? input.result.rows.length,
    schemaRefresh: input.schemaRefresh,
    transactionOutcome,
  };
}

function boundedModelRows(
  input: QueryResultRow[],
  maxRows: number,
  maxBytes: number,
): { rows: QueryResultRow[]; valuesTruncated: boolean } {
  const rows: QueryResultRow[] = [];
  let bytes = 2;
  let valuesTruncated = false;
  for (const row of input.slice(0, maxRows)) {
    const rowBytes = portableJsonBytes(row);
    if (bytes + rowBytes <= maxBytes) {
      rows.push(structuredClone(row));
      bytes += rowBytes + 1;
      continue;
    }
    if (rows.length === 0) {
      rows.push(truncateModelRow(row, Math.max(512, maxBytes - bytes)));
      valuesTruncated = true;
    }
    break;
  }
  return { rows, valuesTruncated };
}

function truncateModelRow(row: QueryResultRow, maxChars: number): QueryResultRow {
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

async function requireActiveConnection(
  getter: AiSqlToolDependencies['getActiveConnection'],
): Promise<ActiveDatabaseConnection> {
  const active = await getter();
  if (!active) throw new Error('No active database connection is selected.');
  if (active.connection.id !== active.connectionId) {
    throw new Error('Active connection identity is inconsistent.');
  }
  return active;
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
    throw new Error(`Tool argument "${key}" must be a string array.`);
  }
  const stringValues: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw new Error(`Tool argument "${key}" must be a string array.`);
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
    throw new Error(`Tool argument "${key}" must be a non-negative integer.`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error('Result cursor is invalid.');
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error('Result cursor is invalid.');
  return value;
}
