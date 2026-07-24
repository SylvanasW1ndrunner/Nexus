import { randomUUID } from 'node:crypto';
import type { AgentToolContext, ToolRegistry } from '@dbagent/core-agent';
import {
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
import {
  projectKnowledgeSearchResult,
  projectResourceDetail,
  projectResourceSummary,
  resolveAgentResourceReference,
} from './agent-knowledge-projection.js';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const DEFAULT_PREVIEW_ROWS = 20;
const DEFAULT_EXECUTION_ROWS = 2_000;
const DEFAULT_RESULT_TTL_MS = 60 * 60 * 1_000;
const DDL_KINDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COMMENT',
  'RENAME',
]);

export type ActiveDatabaseConnection = {
  connectionId: string;
  connection: SavedConnection;
};

export type AiSqlQueryExecutionInput = {
  request: QueryRequest;
  connection: SavedConnection;
  authorization: QueryAuthorization;
};

export type AiSqlQueryExecutor = (
  input: AiSqlQueryExecutionInput,
) => Promise<QueryExecutionResult>;

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
  result: QueryExecutionResult;
  createdAt: string;
  expiresAt: string;
};

export class AiSqlResultStore {
  readonly #results = new Map<string, StoredAiSqlResult>();
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    ttlMs?: number;
    now?: () => Date;
    createId?: () => string;
  } = {}) {
    this.#ttlMs = normalizePositiveInteger(options.ttlMs, DEFAULT_RESULT_TTL_MS);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  put(input: {
    sessionId: string;
    connectionId: string;
    result: QueryExecutionResult;
  }): StoredAiSqlResult {
    this.prune();
    const now = this.#now();
    const item: StoredAiSqlResult = {
      id: this.#createId(),
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      result: structuredClone(input.result),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    this.#results.set(item.id, item);
    return structuredClone(item);
  }

  read(input: {
    id: string;
    sessionId: string;
    cursor?: string;
    limit?: number;
  }): {
    id: string;
    columns: QueryExecutionResult['columns'];
    rows: QueryResultRow[];
    offset: number;
    returnedRowCount: number;
    totalStoredRows: number;
    nextCursor?: string;
    truncated: boolean;
  } {
    this.prune();
    const item = this.#results.get(input.id);
    if (!item || item.sessionId !== input.sessionId) {
      throw new Error('Result handle is missing, expired, or belongs to another session.');
    }
    const offset = parseCursor(input.cursor);
    const limit = normalizePositiveInteger(input.limit, 100);
    const rows = item.result.rows.slice(offset, offset + limit);
    const nextOffset = offset + rows.length;
    return {
      id: item.id,
      columns: modelVisibleColumns(item.result.columns),
      rows: structuredClone(rows),
      offset,
      returnedRowCount: rows.length,
      totalStoredRows: item.result.rows.length,
      ...(nextOffset < item.result.rows.length
        ? { nextCursor: String(nextOffset) }
        : {}),
      truncated: item.result.truncated === true || item.result.hasMore === true,
    };
  }

  remove(id: string): boolean {
    return this.#results.delete(id);
  }

  clearSession(sessionId: string): number {
    let removed = 0;
    for (const [id, item] of this.#results) {
      if (item.sessionId === sessionId && this.#results.delete(id)) removed += 1;
    }
    return removed;
  }

  prune(): number {
    const now = this.#now().getTime();
    let removed = 0;
    for (const [id, item] of this.#results) {
      if (Date.parse(item.expiresAt) <= now && this.#results.delete(id)) removed += 1;
    }
    return removed;
  }
}

export function registerAiSqlTools(dependencies: AiSqlToolDependencies): AiSqlResultStore {
  const resultStore = dependencies.resultStore ?? new AiSqlResultStore();
  const { registry, rag } = dependencies;

  registry.register(
    {
      name: 'resource_list',
      description:
        'List database resources inside an optional database, schema, or table scope.',
      inputSchema: objectSchema(
        {
          scope: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        [],
      ),
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'schema-rag',
    },
    async (args) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const parentReference = optionalString(args, 'scope');
      const kinds = optionalStringArray(args, 'kinds');
      const limit = optionalPositiveInteger(args, 'limit', 200);
      const catalog = rag.getCatalog(active.connectionId);
      const parentId =
        parentReference === undefined
          ? undefined
          : resolveAgentResourceReference(catalog, parentReference);
      const nodes = rag.listResources({
        connectionId: active.connectionId,
        ...(parentId === undefined ? {} : { parentId }),
        ...(kinds === undefined ? {} : { kinds }),
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
    async (args) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const reference = requireString(args, 'resource');
      const catalog = rag.getCatalog(active.connectionId);
      const resourceId = resolveAgentResourceReference(catalog, reference);
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
    async (args) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const query = requireString(args, 'query');
      const limit = optionalPositiveInteger(args, 'limit', 8);
      const maxContextTokens = optionalPositiveInteger(
        args,
        'maxContextTokens',
        1_500,
      );
      const expandHops = optionalNonNegativeInteger(args, 'expandHops', 1);
      const items = await rag.searchAsync({
        connectionId: active.connectionId,
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(maxContextTokens === undefined
          ? {}
          : { maxContextTokens }),
        ...(expandHops === undefined ? {} : { expandHops }),
        includeRelations: true,
      });
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
          maxRows: { type: 'integer', minimum: 1, maximum: 10000 },
          previewRows: { type: 'integer', minimum: 1, maximum: 100 },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        ['sql'],
      ),
      dangerLevel: 'high',
      readonly: false,
      source: 'database',
      resolveRequiredPermission: (args) =>
        parseSql(typeof args.sql === 'string' ? args.sql : '', {
          dialect: 'postgresql',
        }).requiredPermission,
    },
    async (args, context) => {
      const active = await requireActiveConnection(dependencies.getActiveConnection);
      const sql = requireString(args, 'sql');
      const parsed = parseSql(sql, { dialect: 'postgresql' });
      const maxRows = optionalPositiveInteger(args, 'maxRows', DEFAULT_EXECUTION_ROWS);
      const previewRows = optionalPositiveInteger(args, 'previewRows', DEFAULT_PREVIEW_ROWS);
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs');
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
        queryAuthorization(context),
      );
      const stored = resultStore.put({
        sessionId: context.session.id,
        connectionId: active.connectionId,
        result,
      });
      if (
        dependencies.onSchemaChanged &&
        result.transaction?.rolledBack !== true &&
        parsed.statementKinds.some((kind) => DDL_KINDS.has(kind))
      ) {
        await dependencies.onSchemaChanged({
          connectionId: active.connectionId,
          sql,
          parsed,
          result,
        });
      }
      return executionPreview(result, stored.id, previewRows);
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
      const result = await executeQuery(
        dependencies,
        {
          connectionId: active.connectionId,
          sql: `EXPLAIN (FORMAT JSON) ${sql}`,
          limit: 10,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        active.connection,
        queryAuthorization(context),
      );
      return {
        plan: result.rows[0] ?? null,
        elapsedMs: result.elapsedMs,
      };
    },
  );

  registry.register(
    {
      name: 'result_read',
      description:
        'Read another page from a result handle returned by sql_execute. Handles are isolated to the current Agent session.',
      inputSchema: objectSchema(
        {
          resultHandleId: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        ['resultHandleId'],
      ),
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'builtin',
    },
    (args, context) => {
      const cursor = optionalString(args, 'cursor');
      const limit = optionalPositiveInteger(args, 'limit', 100);
      return resultStore.read({
        id: requireString(args, 'resultHandleId'),
        sessionId: context.session.id,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
    },
  );

  return resultStore;
}

async function executeQuery(
  dependencies: AiSqlToolDependencies,
  request: QueryRequest,
  connection: SavedConnection,
  authorization: QueryAuthorization,
): Promise<QueryExecutionResult> {
  if (dependencies.queryExecutor) {
    return await dependencies.queryExecutor({
      request,
      connection,
      authorization,
    });
  }
  const execution = await dependencies.driver.execute(request, connection);
  if (!execution.ok) throw new Error(execution.error.message);
  return execution.data;
}

function queryAuthorization(
  context: AgentToolContext,
): QueryAuthorization {
  return {
    ...(context.session.userId === undefined
      ? {}
      : { actorId: context.session.userId }),
    ...(context.approval?.requestId === undefined
      ? {}
      : { approvalId: context.approval.requestId }),
    permissionMode: permissionMode(context.session.mode),
  };
}

function permissionMode(
  mode: string,
): NonNullable<QueryAuthorization['permissionMode']> {
  if (mode === 'full' || mode === 'full-auto') return 'fully-approved';
  if (mode === 'edit' || mode === 'auto') return 'non-high-risk';
  return 'all-writes-approved';
}

function executionPreview(
  result: QueryExecutionResult,
  resultHandleId: string,
  previewRows = DEFAULT_PREVIEW_ROWS,
): Record<string, unknown> {
  return {
    resultHandleId,
    columns: modelVisibleColumns(result.columns),
    rows: result.rows.slice(0, previewRows),
    rowCount: result.rowCount,
    returnedRowCount: result.returnedRowCount ?? result.rows.length,
    storedRowCount: result.rows.length,
    hasMoreInDatabase: result.hasMore === true,
    truncatedByDriver: result.truncated === true,
    previewTruncated: result.rows.length > previewRows,
    elapsedMs: result.elapsedMs,
    transaction: result.transaction,
    messages: result.messages ?? [],
  };
}

function modelVisibleColumns(
  columns: QueryExecutionResult['columns'],
): QueryExecutionResult['columns'] {
  return columns.map((column) => ({
    name: column.name,
    ...(column.dataType && !/^\d+$/.test(column.dataType)
      ? { dataType: column.dataType }
      : {}),
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

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
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
    ...new Set(
      stringValues
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
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
