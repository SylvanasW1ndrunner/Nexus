import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  AppError,
  ColumnSummary,
  DatabaseTransaction,
  QueryCancelResponse,
  QueryExecutionMessage,
  QueryExecutionResult,
  QueryRequest,
  QueryResultSet,
  QueryTransactionReport,
  PortableValue,
  SavedConnection,
  TableConstraintSummary,
  TableDetail,
  TableIndexSummary,
  TransactionIsolationLevel,
} from '@dbagent/shared';
import { err, ok, type Result } from '@dbagent/shared';
import type {
  Pool as PgPool,
  PoolClient as PgPoolClient,
  QueryResult as PgQueryResult,
  QueryResultRow,
} from 'pg';
import {
  classifyPostgresConnectionError,
  classifyPostgresRuntimeError,
} from './postgres-errors.js';
import { splitSqlStatements } from './sql-statements.js';
import { analyzeSqlSafety, stripSqlComments } from './sql-safety.js';
import type {
  DatabaseConnectionConfig,
  IDatabaseDriver,
  QueryExecutionObserver,
  TableSummary,
} from './types.js';

type SafePgQueryResult = PgQueryResult<QueryResultRow>;
const DEFAULT_QUERY_ROW_LIMIT = 10_000;
const MAX_QUERY_ROW_LIMIT = 100_000;

export type PostgresServerInfo = {
  database: string;
  currentUser: string;
  engineVersion: string;
  engineVersionNumber: number;
  serverAddress?: string;
  serverPort?: number;
  inRecovery: boolean;
};

export type PostgresCatalogEntry = {
  kind: string;
  nativeId: string;
  canonicalName: string;
  displayName: string;
  parentNativeId: string;
  attributes: Record<string, PortableValue>;
};

export type PostgresCatalogPage = {
  entries: PostgresCatalogEntry[];
  hasMore: boolean;
};

export type PostgresRuntimeSnapshot = {
  totalSessions: number;
  activeQueries: number;
  idleInTransaction: number;
  waitingQueries: number;
  blockedLocks: number;
  longestQuerySeconds: number;
  databaseBytes: number;
  inRecovery: boolean;
  replicationClients: number;
  maximumReplayLagSeconds?: number;
};

type ActivePostgresTransaction = {
  client: PgPoolClient;
  transaction: DatabaseTransaction;
  connection: SavedConnection;
};

export class PostgresDriver implements IDatabaseDriver {
  readonly capabilities = {
    engine: 'postgres' as const,
    supportsTransactions: true,
    supportsExplain: true,
    supportsSchemas: true,
  };

  private readonly pools = new Map<string, PgPool>();
  private readonly cancelPools = new Map<string, PgPool>();
  private readonly configs = new Map<string, DatabaseConnectionConfig>();
  private readonly transactions = new Map<string, ActivePostgresTransaction>();
  private readonly poolErrors = new Map<string, AppError>();
  private readonly observedClients = new WeakSet<PgPoolClient>();

  async test(config: DatabaseConnectionConfig): Promise<Result<{ latencyMs: number }>> {
    const started = performance.now();
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(toPgConfig(config));
      const client = await pool.connect();
      try {
        await client.query('select 1 as ok');
      } finally {
        client.release();
        await pool.end();
      }
      return ok({ latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      return err(classifyPostgresConnectionError(error));
    }
  }

  async connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>> {
    if (!config.id) {
      return err({ code: 'VALIDATION_ERROR', message: 'Connection id is required.' });
    }

    const test = await this.test(config);
    if (!test.ok) return test;

    const { Pool } = await import('pg');
    const pool = new Pool(toPgConfig(config));
    const cancelPool = new Pool({ ...toPgConfig(config), max: 1 });
    pool.on('error', (error) => {
      this.poolErrors.set(config.id!, classifyPostgresConnectionError(error));
    });
    cancelPool.on('error', (error) => {
      this.poolErrors.set(config.id!, classifyPostgresConnectionError(error));
    });
    this.pools.set(config.id, pool);
    this.cancelPools.set(config.id, cancelPool);
    this.configs.set(config.id, { ...config });
    return ok({
      id: config.id,
      name: config.name,
      engine: config.engine,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      readOnly: config.readOnly,
      status: 'connected',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async disconnect(connectionId: string): Promise<Result<void>> {
    for (const [transactionId, active] of this.transactions) {
      if (active.connection.id !== connectionId) continue;
      try {
        await active.client.query('ROLLBACK');
      } catch {
        // Pool shutdown below is still required even when rollback fails.
      } finally {
        active.client.release();
        this.transactions.delete(transactionId);
      }
    }
    const pool = this.pools.get(connectionId);
    if (pool) {
      await pool.end();
      this.pools.delete(connectionId);
    }
    const cancelPool = this.cancelPools.get(connectionId);
    if (cancelPool) {
      await cancelPool.end();
      this.cancelPools.delete(connectionId);
    }
    this.configs.delete(connectionId);
    this.poolErrors.delete(connectionId);
    return ok(undefined);
  }

  async execute(
    request: QueryRequest,
    connection: SavedConnection,
    observer?: QueryExecutionObserver,
  ): Promise<Result<QueryExecutionResult>> {
    if (observer?.signal?.aborted) {
      return err({
        code: 'QUERY_CANCELLED',
        message: 'PostgreSQL query was cancelled before execution.',
        retryable: false,
      });
    }
    const safety = analyzeSqlSafety(request.sql, { readOnly: connection.readOnly });
    if (safety.statementKind === 'EMPTY') {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'SQL is empty.',
        detail: safety.reasons.join(' '),
      });
    }

    if (safety.blocked) {
      return err({
        code: 'READ_ONLY_VIOLATION',
        message: 'This query is blocked by read-only mode.',
        detail: safety.reasons.join(' '),
      });
    }

    if (safety.requiresConfirmation && request.confirmed !== true) {
      return err({
        code: 'CONFIRMATION_REQUIRED',
        message: 'This query requires explicit confirmation before execution.',
        detail: safety.reasons.join(' '),
      });
    }

    const transactionMode = resolveTransactionMode(request);
    if (!transactionMode.ok) return transactionMode;
    const queryTimeout = resolveQueryTimeout(request.timeoutMs, connection.statementTimeoutMs);
    if (!queryTimeout.ok) return queryTimeout;

    const parameterizedBatchError = validateParameterizedBatch(request.sql, request.params);
    if (parameterizedBatchError) return err(parameterizedBatchError);

    if (transactionMode.data === 'rollback') {
      const unsupportedRollback = findUnsupportedRollbackStatement(request.sql);
      if (unsupportedRollback) {
        return err({
          code: 'UNSUPPORTED_OPERATION',
          message: 'This PostgreSQL statement cannot run inside a rollback preview transaction.',
          detail: unsupportedRollback,
        });
      }
    }

    const pool = this.pools.get(connection.id);
    if (!pool) {
      return err({
        code: 'CONNECTION_FAILED',
        message: 'Connection is not active.',
        retryable: true,
      });
    }

    const started = performance.now();
    const queryId = request.queryId ?? randomUUID();
    let client: PgPoolClient | undefined;
    let stopAbortCancellation: (() => void) | undefined;
    try {
      client = await pool.connect();
      this.observeClient(connection.id, client);
      const backendPid = await resolveBackendPid(client);
      if (backendPid) {
        observer?.onBackendPid?.({
          queryId,
          connectionId: connection.id,
          backendPid,
        });
        stopAbortCancellation = registerAbortCancellation(observer?.signal, () =>
          this.cancel(
            {
              queryId,
              connectionId: connection.id,
              decision: 'cancel-backend',
              backendPid,
              message: 'The caller aborted the PostgreSQL query.',
            },
            connection,
          ),
        );
      }
      const rowLimit = normalizeQueryRowLimit(request.limit);
      const pagedSql = resolvePageableReadSql(request.sql, safety, transactionMode.data);
      const execution: { results: SafePgQueryResult[]; transaction?: QueryTransactionReport } =
        pagedSql !== undefined
          ? {
              results: await executePagedRead(
                client,
                pagedSql,
                request.params,
                rowLimit,
                queryTimeout.data,
                connection.readOnly,
              ),
            }
          : safety.requiresConfirmation || transactionMode.data === 'rollback'
            ? await executeInTransaction(
                client,
                request.sql,
                request.params,
                transactionMode.data === 'rollback',
                queryTimeout.data,
              )
            : connection.readOnly
              ? {
                  results: await executeReadOnlyStatement(
                    client,
                    request.sql,
                    request.params,
                    queryTimeout.data,
                  ),
                }
              : {
                  results: normalizePgResults(
                    await executeWithSessionTimeout(
                      client,
                      request.sql,
                      request.params,
                      queryTimeout.data,
                    ),
                  ),
                };
      return ok(
        toQueryExecutionResult(
          execution.results,
          safety,
          started,
          queryId,
          rowLimit,
          execution.transaction,
        ),
      );
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    } finally {
      stopAbortCancellation?.();
      client?.release();
    }
  }

  async cancel(
    request: QueryCancelResponse,
    connection: SavedConnection,
  ): Promise<Result<QueryCancelResponse>> {
    if (request.decision === 'disconnect-connection') {
      const disconnected = await this.disconnect(connection.id);
      if (!disconnected.ok) return disconnected;
      return ok({ ...request, message: `${request.message} 已断开当前连接。` });
    }

    if (request.decision !== 'cancel-backend') return ok(request);
    if (!request.backendPid) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Backend pid is required to cancel PostgreSQL query.',
      });
    }

    const pool = this.pools.get(connection.id);
    const cancelPool = this.cancelPools.get(connection.id);
    const config = this.configs.get(connection.id);
    if (!pool && !cancelPool && !config) {
      return err({
        code: 'CONNECTION_FAILED',
        message: 'Connection is not active.',
        retryable: true,
      });
    }

    try {
      const result = config
        ? cancelPool
          ? await cancelPool.query<{ cancelled: boolean }>(
              'select pg_cancel_backend($1) as cancelled',
              [request.backendPid],
            )
          : await cancelBackendWithDedicatedClient(config, request.backendPid)
        : await pool!.query<{ cancelled: boolean }>('select pg_cancel_backend($1) as cancelled', [
            request.backendPid,
          ]);
      if (!result.rows[0]?.cancelled) {
        return err({
          code: 'QUERY_FAILED',
          message: `PostgreSQL backend ${request.backendPid} was not cancelled.`,
          retryable: true,
        });
      }
      return ok({ ...request, message: 'PostgreSQL 已接受查询取消请求。' });
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async listTables(connectionId: string): Promise<Result<TableSummary[]>> {
    const pool = this.pools.get(connectionId);
    if (!pool) {
      return err({
        code: 'CONNECTION_FAILED',
        message: 'Connection is not active.',
        retryable: true,
      });
    }
    try {
      const result = await pool.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        comment: string | null;
      }>(`
        select
          n.nspname as schema_name,
          c.relname as table_name,
          case c.relkind when 'v' then 'view' else 'table' end as table_type,
          obj_description(c.oid) as comment
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v')
          and n.nspname not in ('pg_catalog', 'information_schema')
        order by n.nspname, c.relname
      `);
      return ok(
        result.rows.map((row) => {
          const summary: TableSummary = {
            schema: row.schema_name,
            name: row.table_name,
            type: row.table_type === 'view' ? 'view' : 'table',
          };
          if (row.comment) summary.comment = row.comment;
          return summary;
        }),
      );
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async describeTable(
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<Result<TableDetail>> {
    const pool = this.pools.get(connectionId);
    if (!pool) {
      return err({
        code: 'CONNECTION_FAILED',
        message: 'Connection is not active.',
        retryable: true,
      });
    }

    try {
      const tableResult = await pool.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        comment: string | null;
        row_estimate: string | number | null;
        view_definition: string | null;
      }>(
        `
          select
            n.nspname as schema_name,
            c.relname as table_name,
            case c.relkind when 'v' then 'view' else 'table' end as table_type,
            obj_description(c.oid) as comment,
            greatest(c.reltuples, 0)::bigint as row_estimate,
            case when c.relkind = 'v' then pg_get_viewdef(c.oid, true) else null end as view_definition
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v')
            and n.nspname = $1
            and c.relname = $2
        `,
        [schema, table],
      );

      const tableRow = tableResult.rows[0];
      if (!tableRow) {
        return err({ code: 'NOT_FOUND', message: `Table ${schema}.${table} was not found.` });
      }

      const columnResult = await pool.query<{
        column_name: string;
        ordinal_position: number;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
        comment: string | null;
        is_primary_key: boolean;
        foreign_schema: string | null;
        foreign_table: string | null;
        foreign_column: string | null;
        is_indexed: boolean;
        is_unique: boolean;
      }>(
        `
          select
            a.attname as column_name,
            a.attnum as ordinal_position,
            format_type(a.atttypid, a.atttypmod) as data_type,
            case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
            pg_get_expr(ad.adbin, ad.adrelid) as column_default,
            col_description(a.attrelid, a.attnum) as comment,
            exists (
              select 1
              from pg_index i
              where i.indrelid = a.attrelid
                and i.indisprimary
                and a.attnum = any(i.indkey)
            ) as is_primary_key,
            fn.nspname as foreign_schema,
            fc.relname as foreign_table,
            fa.attname as foreign_column,
            exists (
              select 1
              from pg_index indexed
              where indexed.indrelid = a.attrelid
                and a.attnum = any(indexed.indkey)
            ) as is_indexed,
            exists (
              select 1
              from pg_index unique_idx
              where unique_idx.indrelid = a.attrelid
                and unique_idx.indisunique
                and unique_idx.indnkeyatts = 1
                and a.attnum = any(unique_idx.indkey)
            ) as is_unique
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          left join pg_constraint fk
            on fk.conrelid = a.attrelid
            and fk.contype = 'f'
            and a.attnum = any(fk.conkey)
          left join pg_class fc on fc.oid = fk.confrelid
          left join pg_namespace fn on fn.oid = fc.relnamespace
          left join pg_attribute fa
            on fa.attrelid = fk.confrelid
            and fa.attnum = fk.confkey[array_position(fk.conkey, a.attnum)]
          where n.nspname = $1
            and c.relname = $2
            and a.attnum > 0
            and not a.attisdropped
          order by a.attnum
        `,
        [schema, table],
      );

      const indexResult = await pool.query<{
        index_name: string;
        method: string;
        columns: string[] | string | null;
        is_unique: boolean;
        is_primary: boolean;
        is_valid: boolean;
        definition: string;
      }>(
        `
          select
            index_class.relname as index_name,
            access_method.amname as method,
            array(
              select pg_get_indexdef(indexes.indexrelid, key_ordinal, true)
              from generate_series(1, indexes.indnkeyatts) as key_ordinal
            ) as columns,
            indexes.indisunique as is_unique,
            indexes.indisprimary as is_primary,
            indexes.indisvalid as is_valid,
            pg_get_indexdef(indexes.indexrelid) as definition
          from pg_index indexes
          join pg_class table_class on table_class.oid = indexes.indrelid
          join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
          join pg_class index_class on index_class.oid = indexes.indexrelid
          join pg_am access_method on access_method.oid = index_class.relam
          where table_namespace.nspname = $1
            and table_class.relname = $2
          order by indexes.indisprimary desc, indexes.indisunique desc, index_class.relname
        `,
        [schema, table],
      );

      const constraintResult = await pool.query<{
        constraint_name: string;
        constraint_type: string;
        columns: string[] | string | null;
        definition: string;
      }>(
        `
          select
            constraint_info.conname as constraint_name,
            constraint_info.contype as constraint_type,
            coalesce(
              array_agg(attribute.attname order by key_position.ordinality)
                filter (where attribute.attname is not null),
              array[]::text[]
            ) as columns,
            pg_get_constraintdef(constraint_info.oid, true) as definition
          from pg_constraint constraint_info
          join pg_class table_class on table_class.oid = constraint_info.conrelid
          join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
          left join unnest(constraint_info.conkey) with ordinality as key_position(attnum, ordinality) on true
          left join pg_attribute attribute
            on attribute.attrelid = table_class.oid
            and attribute.attnum = key_position.attnum
          where table_namespace.nspname = $1
            and table_class.relname = $2
          group by constraint_info.oid, constraint_info.conname, constraint_info.contype
          order by constraint_info.contype, constraint_info.conname
        `,
        [schema, table],
      );

      const columns = columnResult.rows.map((row): ColumnSummary => {
        const column: ColumnSummary = {
          name: row.column_name,
          ordinal: row.ordinal_position,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          isPrimaryKey: row.is_primary_key,
        };
        if (row.column_default) column.defaultValue = row.column_default;
        if (row.comment) column.comment = row.comment;
        if (row.is_indexed) column.isIndexed = true;
        if (row.is_unique) column.isUnique = true;
        if (row.foreign_schema && row.foreign_table && row.foreign_column) {
          column.foreignKey = {
            schema: row.foreign_schema,
            table: row.foreign_table,
            column: row.foreign_column,
          };
        }
        return column;
      });
      const indexes = indexResult.rows.map(
        (row): TableIndexSummary => ({
          name: row.index_name,
          method: row.method,
          columns: normalizePgTextArray(row.columns),
          unique: row.is_unique,
          primary: row.is_primary,
          valid: row.is_valid,
          definition: row.definition,
        }),
      );
      const constraints = constraintResult.rows.map(
        (row): TableConstraintSummary => ({
          name: row.constraint_name,
          type: toConstraintType(row.constraint_type),
          columns: normalizePgTextArray(row.columns),
          definition: row.definition,
        }),
      );

      const detail: TableDetail = {
        schema: tableRow.schema_name,
        name: tableRow.table_name,
        type: tableRow.table_type === 'view' ? 'view' : 'table',
        columns,
        primaryKey: columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
      };
      if (tableRow.comment) detail.comment = tableRow.comment;
      const rowEstimate = toOptionalNumber(tableRow.row_estimate);
      if (rowEstimate !== undefined) detail.rowEstimate = rowEstimate;
      if (tableRow.view_definition) detail.viewDefinition = tableRow.view_definition;
      if (indexes.length > 0) detail.indexes = indexes;
      if (constraints.length > 0) detail.constraints = constraints;
      return ok(detail);
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async serverInfo(connectionId: string): Promise<Result<PostgresServerInfo>> {
    const pool = this.pools.get(connectionId);
    if (!pool) return inactiveConnection();
    try {
      const result = await pool.query<{
        database_name: string;
        current_user_name: string;
        engine_version: string;
        engine_version_number: string | number;
        server_address: string | null;
        server_port: number | null;
        in_recovery: boolean;
      }>(`
        select
          current_database() as database_name,
          current_user as current_user_name,
          current_setting('server_version') as engine_version,
          current_setting('server_version_num')::int as engine_version_number,
          inet_server_addr()::text as server_address,
          inet_server_port()::int as server_port,
          pg_is_in_recovery() as in_recovery
      `);
      const row = result.rows[0];
      if (!row)
        return err({ code: 'QUERY_FAILED', message: 'PostgreSQL returned no server identity.' });
      return ok({
        database: row.database_name,
        currentUser: row.current_user_name,
        engineVersion: row.engine_version,
        engineVersionNumber: Number(row.engine_version_number),
        inRecovery: row.in_recovery,
        ...(row.server_address ? { serverAddress: row.server_address } : {}),
        ...(row.server_port ? { serverPort: row.server_port } : {}),
      });
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async discoverCatalog(
    connectionId: string,
    input: { offset: number; limit: number },
  ): Promise<Result<PostgresCatalogPage>> {
    const pool = this.pools.get(connectionId);
    if (!pool) return inactiveConnection();
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 10_000);
    const offset = Math.max(Math.floor(input.offset), 0);
    try {
      const result = await pool.query<{
        kind: string;
        native_id: string;
        canonical_name: string;
        display_name: string;
        parent_native_id: string;
        attributes: Record<string, PortableValue>;
      }>(
        `
          with database_context as (
            select current_database()::text as database_name
          ),
          entries as (
            select
              10 as sort_rank,
              'schema'::text as kind,
              context.database_name || '.' || namespace.nspname as native_id,
              namespace.nspname::text as canonical_name,
              namespace.nspname::text as display_name,
              context.database_name::text as parent_native_id,
              jsonb_build_object(
                'owner', pg_get_userbyid(namespace.nspowner),
                'comment', obj_description(namespace.oid, 'pg_namespace')
              ) as attributes
            from pg_namespace namespace
            cross join database_context context
            where namespace.nspname not like 'pg_toast%'
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              20 as sort_rank,
              case relation.relkind
                when 'v' then 'view'
                when 'm' then 'materialized-view'
                when 'f' then 'external-table'
                when 'S' then 'sequence'
                else 'table'
              end::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname as native_id,
              namespace.nspname || '.' || relation.relname as canonical_name,
              relation.relname::text as display_name,
              context.database_name || '.' || namespace.nspname as parent_native_id,
              jsonb_strip_nulls(jsonb_build_object(
                'schema', namespace.nspname,
                'owner', pg_get_userbyid(relation.relowner),
                'comment', obj_description(relation.oid, 'pg_class'),
                'estimatedRows', greatest(relation.reltuples, 0)::bigint,
                'partitioned', relation.relkind = 'p',
                'persistence', relation.relpersistence,
                'definition', case
                  when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true)
                  else null
                end
              )) as attributes
            from pg_class relation
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            cross join database_context context
            where relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname not like 'pg_toast%'
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              30 as sort_rank,
              'column'::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname || '.' || attribute.attname as native_id,
              namespace.nspname || '.' || relation.relname || '.' || attribute.attname as canonical_name,
              attribute.attname::text as display_name,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname as parent_native_id,
              jsonb_strip_nulls(jsonb_build_object(
                'ordinal', attribute.attnum,
                'dataType', format_type(attribute.atttypid, attribute.atttypmod),
                'nullable', not attribute.attnotnull,
                'default', pg_get_expr(default_value.adbin, default_value.adrelid),
                'comment', col_description(attribute.attrelid, attribute.attnum),
                'identity', nullif(attribute.attidentity, ''),
                'generated', nullif(attribute.attgenerated, '')
              )) as attributes
            from pg_attribute attribute
            join pg_class relation on relation.oid = attribute.attrelid
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            left join pg_attrdef default_value
              on default_value.adrelid = attribute.attrelid
              and default_value.adnum = attribute.attnum
            cross join database_context context
            where relation.relkind in ('r', 'p', 'v', 'm', 'f')
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and attribute.attnum > 0
              and not attribute.attisdropped
              and namespace.nspname not like 'pg_toast%'
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              40 as sort_rank,
              'index'::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || index_relation.relname as native_id,
              namespace.nspname || '.' || index_relation.relname as canonical_name,
              index_relation.relname::text as display_name,
              context.database_name || '.' || namespace.nspname || '.' || table_relation.relname as parent_native_id,
              jsonb_build_object(
                'definition', pg_get_indexdef(index_info.indexrelid),
                'unique', index_info.indisunique,
                'primary', index_info.indisprimary,
                'valid', index_info.indisvalid,
                'ready', index_info.indisready
              ) as attributes
            from pg_index index_info
            join pg_class index_relation on index_relation.oid = index_info.indexrelid
            join pg_class table_relation on table_relation.oid = index_info.indrelid
            join pg_namespace namespace on namespace.oid = table_relation.relnamespace
            cross join database_context context
            where namespace.nspname not like 'pg_toast%'
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              50 as sort_rank,
              'constraint'::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname || '.' || constraint_info.conname as native_id,
              namespace.nspname || '.' || relation.relname || '.' || constraint_info.conname as canonical_name,
              constraint_info.conname::text as display_name,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname as parent_native_id,
              jsonb_build_object(
                'constraintType', constraint_info.contype,
                'definition', pg_get_constraintdef(constraint_info.oid, true),
                'validated', constraint_info.convalidated,
                'deferrable', constraint_info.condeferrable,
                'referencedTableNativeId', case
                  when constraint_info.contype = 'f' then
                    context.database_name || '.' || referenced_namespace.nspname || '.' ||
                    referenced_relation.relname
                  else null
                end,
                'sourceColumns', case
                  when constraint_info.contype = 'f' then (
                    select jsonb_agg(source_attribute.attname order by source_key.ordinality)
                    from unnest(constraint_info.conkey) with ordinality as source_key(attnum, ordinality)
                    join pg_attribute source_attribute
                      on source_attribute.attrelid = constraint_info.conrelid
                      and source_attribute.attnum = source_key.attnum
                  )
                  else null
                end,
                'targetColumns', case
                  when constraint_info.contype = 'f' then (
                    select jsonb_agg(target_attribute.attname order by target_key.ordinality)
                    from unnest(constraint_info.confkey) with ordinality as target_key(attnum, ordinality)
                    join pg_attribute target_attribute
                      on target_attribute.attrelid = constraint_info.confrelid
                      and target_attribute.attnum = target_key.attnum
                  )
                  else null
                end
              ) as attributes
            from pg_constraint constraint_info
            join pg_class relation on relation.oid = constraint_info.conrelid
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            left join pg_class referenced_relation
              on referenced_relation.oid = constraint_info.confrelid
              and constraint_info.contype = 'f'
            left join pg_namespace referenced_namespace
              on referenced_namespace.oid = referenced_relation.relnamespace
            cross join database_context context
            where namespace.nspname not like 'pg_toast%'
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              60 as sort_rank,
              case when routine.prokind = 'p' then 'procedure' else 'function' end::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || routine.oid::text as native_id,
              namespace.nspname || '.' || routine.proname || '(' || pg_get_function_identity_arguments(routine.oid) || ')' as canonical_name,
              routine.proname::text as display_name,
              context.database_name || '.' || namespace.nspname as parent_native_id,
              jsonb_build_object(
                'arguments', pg_get_function_arguments(routine.oid),
                'resultType', pg_get_function_result(routine.oid),
                'language', language.lanname,
                'volatility', routine.provolatile,
                'securityDefiner', routine.prosecdef,
                'definition', pg_get_functiondef(routine.oid)
              ) as attributes
            from pg_proc routine
            join pg_namespace namespace on namespace.oid = routine.pronamespace
            join pg_language language on language.oid = routine.prolang
            cross join database_context context
            where namespace.nspname not like 'pg_toast%'
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname not like 'pg_temp_%'
              and routine.prokind in ('f', 'p')

            union all

            select
              70 as sort_rank,
              'trigger'::text as kind,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname || '.' || trigger_info.tgname as native_id,
              namespace.nspname || '.' || relation.relname || '.' || trigger_info.tgname as canonical_name,
              trigger_info.tgname::text as display_name,
              context.database_name || '.' || namespace.nspname || '.' || relation.relname as parent_native_id,
              jsonb_build_object(
                'definition', pg_get_triggerdef(trigger_info.oid, true),
                'enabled', trigger_info.tgenabled
              ) as attributes
            from pg_trigger trigger_info
            join pg_class relation on relation.oid = trigger_info.tgrelid
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            cross join database_context context
            where not trigger_info.tgisinternal
              and namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname not like 'pg_toast%'
              and namespace.nspname not like 'pg_temp_%'

            union all

            select
              80 as sort_rank,
              'role'::text as kind,
              context.database_name || '.role.' || role_info.rolname as native_id,
              role_info.rolname::text as canonical_name,
              role_info.rolname::text as display_name,
              context.database_name::text as parent_native_id,
              jsonb_build_object(
                'superuser', role_info.rolsuper,
                'inherit', role_info.rolinherit,
                'createRole', role_info.rolcreaterole,
                'createDatabase', role_info.rolcreatedb,
                'canLogin', role_info.rolcanlogin,
                'replication', role_info.rolreplication
              ) as attributes
            from pg_roles role_info
            cross join database_context context

            union all

            select
              90 as sort_rank,
              'grant'::text as kind,
              context.database_name || '.grant.' ||
                md5(table_grant.grantor || ':' || table_grant.grantee || ':' ||
                  table_grant.table_schema || ':' || table_grant.table_name || ':' ||
                  table_grant.privilege_type) as native_id,
              table_grant.grantee || ':' || table_grant.table_schema || '.' ||
                table_grant.table_name || ':' || table_grant.privilege_type as canonical_name,
              table_grant.privilege_type || ' to ' || table_grant.grantee as display_name,
              context.database_name || '.' || table_grant.table_schema || '.' || table_grant.table_name as parent_native_id,
              jsonb_build_object(
                'grantor', table_grant.grantor,
                'grantee', table_grant.grantee,
                'privilege', table_grant.privilege_type,
                'grantable', table_grant.is_grantable = 'YES'
              ) as attributes
            from information_schema.table_privileges table_grant
            cross join database_context context
            where table_grant.table_schema not in ('pg_catalog', 'information_schema')
          )
          select kind, native_id, canonical_name, display_name, parent_native_id, attributes
          from entries
          order by sort_rank, native_id
          offset $1
          limit $2
        `,
        [offset, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      return ok({
        entries: rows.map((row) => ({
          kind: row.kind,
          nativeId: row.native_id,
          canonicalName: row.canonical_name,
          displayName: row.display_name,
          parentNativeId: row.parent_native_id,
          attributes: row.attributes,
        })),
        hasMore: result.rows.length > limit,
      });
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async runtimeSnapshot(connectionId: string): Promise<Result<PostgresRuntimeSnapshot>> {
    const pool = this.pools.get(connectionId);
    if (!pool) return inactiveConnection();
    try {
      const result = await pool.query<{
        total_sessions: string | number;
        active_queries: string | number;
        idle_in_transaction: string | number;
        waiting_queries: string | number;
        blocked_locks: string | number;
        longest_query_seconds: string | number | null;
        database_bytes: string | number;
        in_recovery: boolean;
        replication_clients: string | number;
        maximum_replay_lag_seconds: string | number | null;
      }>(`
        select
          (select count(*) from pg_stat_activity where datname = current_database()) as total_sessions,
          (select count(*) from pg_stat_activity
            where datname = current_database() and state = 'active' and pid <> pg_backend_pid()) as active_queries,
          (select count(*) from pg_stat_activity
            where datname = current_database() and state = 'idle in transaction') as idle_in_transaction,
          (select count(*) from pg_stat_activity
            where datname = current_database() and wait_event is not null and pid <> pg_backend_pid()) as waiting_queries,
          (select count(*) from pg_locks where not granted) as blocked_locks,
          (select coalesce(max(extract(epoch from (clock_timestamp() - query_start))), 0)
            from pg_stat_activity
            where datname = current_database() and state = 'active' and pid <> pg_backend_pid()) as longest_query_seconds,
          pg_database_size(current_database()) as database_bytes,
          pg_is_in_recovery() as in_recovery,
          (select count(*) from pg_stat_replication) as replication_clients,
          (select max(extract(epoch from replay_lag)) from pg_stat_replication) as maximum_replay_lag_seconds
      `);
      const row = result.rows[0];
      if (!row)
        return err({ code: 'QUERY_FAILED', message: 'PostgreSQL returned no runtime state.' });
      const replayLag = toOptionalNumber(row.maximum_replay_lag_seconds);
      return ok({
        totalSessions: Number(row.total_sessions),
        activeQueries: Number(row.active_queries),
        idleInTransaction: Number(row.idle_in_transaction),
        waitingQueries: Number(row.waiting_queries),
        blockedLocks: Number(row.blocked_locks),
        longestQuerySeconds: Number(row.longest_query_seconds ?? 0),
        databaseBytes: Number(row.database_bytes),
        inRecovery: row.in_recovery,
        replicationClients: Number(row.replication_clients),
        ...(replayLag !== undefined ? { maximumReplayLagSeconds: replayLag } : {}),
      });
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  lastPoolError(connectionId: string): AppError | undefined {
    const error = this.poolErrors.get(connectionId);
    return error ? { ...error } : undefined;
  }

  async terminateBackend(connectionId: string, backendPid: number): Promise<Result<boolean>> {
    const pool = this.pools.get(connectionId);
    if (!pool) return inactiveConnection();
    if (!Number.isInteger(backendPid) || backendPid <= 0) {
      return err({ code: 'VALIDATION_ERROR', message: 'A positive backend pid is required.' });
    }
    try {
      const result = await pool.query<{ terminated: boolean }>(
        'select pg_terminate_backend($1) as terminated',
        [backendPid],
      );
      return ok(result.rows[0]?.terminated === true);
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async maintainTable(
    connectionId: string,
    input: { operation: 'analyze' | 'vacuum'; schema: string; table: string },
  ): Promise<Result<{ elapsedMs: number }>> {
    const pool = this.pools.get(connectionId);
    if (!pool) return inactiveConnection();
    if (!isSafeIdentifier(input.schema) || !isSafeIdentifier(input.table)) {
      return err({ code: 'VALIDATION_ERROR', message: 'Schema and table names are invalid.' });
    }
    const started = performance.now();
    try {
      const operation = input.operation === 'analyze' ? 'ANALYZE' : 'VACUUM';
      await pool.query(
        `${operation} ${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`,
      );
      return ok({ elapsedMs: Math.round(performance.now() - started) });
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async beginTransaction(
    connection: SavedConnection,
    input: {
      profileId: string;
      sessionId: string;
      isolationLevel?: TransactionIsolationLevel;
      readOnly?: boolean;
    },
  ): Promise<Result<DatabaseTransaction>> {
    const pool = this.pools.get(connection.id);
    if (!pool) return inactiveConnection();
    let client: PgPoolClient | undefined;
    try {
      client = await pool.connect();
      this.observeClient(connection.id, client);
      const readOnly = input.readOnly ?? connection.readOnly;
      const transactionId = randomUUID();
      const isolation = toPostgresIsolation(input.isolationLevel);
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolation} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`,
      );
      const transaction: DatabaseTransaction = {
        id: transactionId,
        profileId: input.profileId,
        sessionId: input.sessionId,
        state: 'active',
        readOnly,
        startedAt: new Date().toISOString(),
        savepoints: [],
        ...(input.isolationLevel ? { isolationLevel: input.isolationLevel } : {}),
      };
      this.transactions.set(transactionId, { client, transaction, connection });
      return ok(structuredClone(transaction));
    } catch (error) {
      client?.release();
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async executeInTransaction(
    transactionId: string,
    request: QueryRequest,
    observer?: QueryExecutionObserver,
    options: { enforceReadOnly?: boolean } = {},
  ): Promise<Result<QueryExecutionResult>> {
    if (observer?.signal?.aborted) {
      return err({
        code: 'QUERY_CANCELLED',
        message: 'PostgreSQL query was cancelled before execution.',
        retryable: false,
      });
    }
    const active = this.transactions.get(transactionId);
    if (!active) return err({ code: 'NOT_FOUND', message: 'Transaction was not found.' });
    if (active.transaction.state !== 'active' && active.transaction.state !== 'failed') {
      return err({ code: 'QUERY_FAILED', message: `Transaction is ${active.transaction.state}.` });
    }
    if (options.enforceReadOnly && !active.transaction.readOnly) {
      return err({
        code: 'READ_ONLY_VIOLATION',
        message:
          'A read-authorized query can only use a database transaction created as read-only.',
        retryable: false,
      });
    }
    const safety = analyzeSqlSafety(request.sql, { readOnly: active.transaction.readOnly });
    if (safety.statementKind === 'EMPTY') {
      return err({ code: 'VALIDATION_ERROR', message: 'SQL is empty.' });
    }
    if (safety.blocked) {
      return err({
        code: 'READ_ONLY_VIOLATION',
        message: 'This query is blocked by read-only mode.',
        detail: safety.reasons.join(' '),
      });
    }
    if (safety.requiresConfirmation && request.confirmed !== true) {
      return err({
        code: 'CONFIRMATION_REQUIRED',
        message: 'This query requires explicit confirmation before execution.',
        detail: safety.reasons.join(' '),
      });
    }
    if (request.transactionMode === 'rollback') {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Rollback preview cannot be nested inside an explicit transaction.',
      });
    }
    const parameterizedBatchError = validateParameterizedBatch(request.sql, request.params);
    if (parameterizedBatchError) return err(parameterizedBatchError);
    const queryTimeout = resolveQueryTimeout(
      request.timeoutMs,
      active.connection.statementTimeoutMs,
    );
    if (!queryTimeout.ok) return queryTimeout;
    const started = performance.now();
    const queryId = request.queryId ?? randomUUID();
    let stopAbortCancellation: (() => void) | undefined;
    try {
      const backendPid = await resolveBackendPid(active.client);
      if (backendPid) {
        observer?.onBackendPid?.({
          queryId,
          connectionId: active.connection.id,
          backendPid,
        });
        stopAbortCancellation = registerAbortCancellation(observer?.signal, () =>
          this.cancel(
            {
              queryId,
              connectionId: active.connection.id,
              decision: 'cancel-backend',
              backendPid,
              message: 'The caller aborted the PostgreSQL query.',
            },
            active.connection,
          ),
        );
      }
      const rowLimit = normalizeQueryRowLimit(request.limit);
      const pagedSql = resolvePageableReadSql(request.sql, safety, 'auto');
      const results =
        pagedSql !== undefined
          ? await executePagedReadInActiveTransaction(
              active.client,
              pagedSql,
              request.params,
              rowLimit,
              queryTimeout.data,
            )
          : normalizePgResults(
              await executeWithLocalTimeout(
                active.client,
                request.sql,
                request.params,
                queryTimeout.data,
              ),
            );
      active.transaction = { ...active.transaction, state: 'active' };
      return ok(toQueryExecutionResult(results, safety, started, queryId, rowLimit));
    } catch (error) {
      active.transaction = { ...active.transaction, state: 'failed' };
      return err(classifyPostgresRuntimeError(error));
    } finally {
      stopAbortCancellation?.();
    }
  }

  async createSavepoint(transactionId: string, name: string): Promise<Result<DatabaseTransaction>> {
    const active = this.transactions.get(transactionId);
    if (!active) return err({ code: 'NOT_FOUND', message: 'Transaction was not found.' });
    if (!isSafeIdentifier(name)) {
      return err({ code: 'VALIDATION_ERROR', message: 'Savepoint name is invalid.' });
    }
    try {
      await active.client.query(`SAVEPOINT ${quoteIdentifier(name)}`);
      active.transaction = {
        ...active.transaction,
        state: 'active',
        savepoints: [...active.transaction.savepoints.filter((item) => item !== name), name],
      };
      return ok(structuredClone(active.transaction));
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async rollbackToSavepoint(
    transactionId: string,
    name: string,
  ): Promise<Result<DatabaseTransaction>> {
    const active = this.transactions.get(transactionId);
    if (!active) return err({ code: 'NOT_FOUND', message: 'Transaction was not found.' });
    if (!active.transaction.savepoints.includes(name) || !isSafeIdentifier(name)) {
      return err({ code: 'NOT_FOUND', message: 'Savepoint was not found.' });
    }
    try {
      await active.client.query(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(name)}`);
      const index = active.transaction.savepoints.indexOf(name);
      active.transaction = {
        ...active.transaction,
        state: 'active',
        savepoints: active.transaction.savepoints.slice(0, index + 1),
      };
      return ok(structuredClone(active.transaction));
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async commitTransaction(transactionId: string): Promise<Result<DatabaseTransaction>> {
    return this.finishTransaction(transactionId, 'commit');
  }

  async rollbackTransaction(transactionId: string): Promise<Result<DatabaseTransaction>> {
    return this.finishTransaction(transactionId, 'rollback');
  }

  private async finishTransaction(
    transactionId: string,
    action: 'commit' | 'rollback',
  ): Promise<Result<DatabaseTransaction>> {
    const active = this.transactions.get(transactionId);
    if (!active) return err({ code: 'NOT_FOUND', message: 'Transaction was not found.' });
    try {
      await active.client.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      active.transaction = {
        ...active.transaction,
        state: action === 'commit' ? 'committed' : 'rolled-back',
        completedAt: new Date().toISOString(),
      };
      return ok(structuredClone(active.transaction));
    } catch (error) {
      active.transaction = { ...active.transaction, state: 'failed' };
      return err(classifyPostgresRuntimeError(error));
    } finally {
      active.client.release();
      this.transactions.delete(transactionId);
    }
  }

  private observeClient(connectionId: string, client: PgPoolClient): void {
    if (typeof client.on !== 'function') return;
    if (this.observedClients.has(client)) return;
    this.observedClients.add(client);
    client.on('error', (error) => {
      this.poolErrors.set(connectionId, classifyPostgresConnectionError(error));
    });
  }
}

function toConstraintType(type: string): TableConstraintSummary['type'] {
  switch (type) {
    case 'p':
      return 'primary_key';
    case 'f':
      return 'foreign_key';
    case 'u':
      return 'unique';
    case 'c':
      return 'check';
    case 'x':
      return 'exclusion';
    default:
      return 'unknown';
  }
}

function toOptionalNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePgTextArray(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === '{}') return [];
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function resolveTransactionMode(request: QueryRequest): Result<'auto' | 'rollback'> {
  const transactionMode =
    request.transactionMode ?? (request.dryRun === true ? 'rollback' : 'auto');
  if (
    request.dryRun === true &&
    request.transactionMode !== undefined &&
    request.transactionMode !== 'rollback'
  ) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'dryRun=true conflicts with transactionMode=auto.',
      detail: 'Use transactionMode=rollback for rollback previews, or remove dryRun.',
    });
  }
  if (transactionMode !== 'auto' && transactionMode !== 'rollback') {
    return err({
      code: 'VALIDATION_ERROR',
      message: `Unsupported transaction mode: ${String(transactionMode)}.`,
    });
  }
  return ok(transactionMode);
}

function resolveQueryTimeout(
  requestedTimeoutMs: number | undefined,
  connectionTimeoutMs: number | undefined,
): Result<number | undefined> {
  if (requestedTimeoutMs === undefined) return ok(undefined);
  if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Query timeout must be a positive integer in milliseconds.',
      retryable: false,
    });
  }
  const configuredLimit =
    connectionTimeoutMs !== undefined &&
    Number.isSafeInteger(connectionTimeoutMs) &&
    connectionTimeoutMs > 0
      ? connectionTimeoutMs
      : undefined;
  return ok(
    configuredLimit === undefined
      ? requestedTimeoutMs
      : Math.min(requestedTimeoutMs, configuredLimit),
  );
}

function validateParameterizedBatch(sql: string, params?: unknown[]) {
  if (!params || params.length === 0) return undefined;
  if (splitSqlStatements(sql).length <= 1) return undefined;
  return {
    code: 'UNSUPPORTED_OPERATION' as const,
    message: 'Parameterized multi-statement SQL is not supported.',
    detail:
      'Run one parameterized statement at a time, or inline-reviewed literal SQL for confirmed scripts.',
  };
}

function findUnsupportedRollbackStatement(sql: string): string | undefined {
  for (const statement of splitSqlStatements(stripSqlComments(sql)).map(
    (segment) => segment.text,
  )) {
    const normalized = statement.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!normalized) continue;
    if (normalized === 'VACUUM' || normalized.startsWith('VACUUM ')) return statement.trim();
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/.test(normalized)) return statement.trim();
    if (/^DROP\s+INDEX\s+CONCURRENTLY\b/.test(normalized)) return statement.trim();
    if (/^CREATE\s+DATABASE\b/.test(normalized)) return statement.trim();
    if (/^DROP\s+DATABASE\b/.test(normalized)) return statement.trim();
    if (/^ALTER\s+SYSTEM\b/.test(normalized)) return statement.trim();
    if (/^CREATE\s+TABLESPACE\b/.test(normalized)) return statement.trim();
    if (/^DROP\s+TABLESPACE\b/.test(normalized)) return statement.trim();
  }
  return undefined;
}

function resolvePageableReadSql(
  sql: string,
  safety: QueryExecutionResult['safety'],
  transactionMode: 'auto' | 'rollback',
): string | undefined {
  if (transactionMode !== 'auto') return undefined;
  if (safety.requiresConfirmation || safety.blocked) return undefined;
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) return undefined;
  const statement = statements[0]!;
  if (!['SELECT', 'WITH', 'VALUES'].includes(statement.statementKind)) return undefined;
  return statement.text;
}

async function executePagedRead(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  rowLimit: number,
  timeoutMs: number | undefined,
  readOnly: boolean,
): Promise<SafePgQueryResult[]> {
  const cursorName = `schemanaut_cursor_${randomUUID().replace(/-/g, '')}`;
  const fetchCount = rowLimit + 1;
  if (!params || params.length === 0) {
    return executeBatchedPagedRead(
      client,
      sql,
      cursorName,
      fetchCount,
      timeoutMs,
      readOnly,
    );
  }
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await setLocalStatementTimeout(client, timeoutMs);
    await executeTimedQuery(
      client,
      `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`,
      params,
      timeoutMs,
    );
    const result = await executeTimedQuery(
      client,
      `FETCH FORWARD ${fetchCount} FROM ${cursorName}`,
      undefined,
      timeoutMs,
    );
    await client.query(`CLOSE ${cursorName}`);
    await client.query('COMMIT');
    return normalizePgResults(result);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original query error; rollback failure is secondary.
    }
    throw error;
  }
}

async function executeBatchedPagedRead(
  client: PgPoolClient,
  sql: string,
  cursorName: string,
  fetchCount: number,
  timeoutMs: number | undefined,
  readOnly: boolean,
): Promise<SafePgQueryResult[]> {
  const statements = [
    readOnly ? 'BEGIN READ ONLY' : 'BEGIN',
    ...(timeoutMs === undefined
      ? []
      : [`SET LOCAL statement_timeout = '${Math.floor(timeoutMs)}ms'`]),
    `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`,
    `FETCH FORWARD ${fetchCount} FROM ${cursorName}`,
    `CLOSE ${cursorName}`,
    'COMMIT',
  ];
  try {
    const results = normalizePgResults(
      await executeTimedQuery(client, statements.join(';\n'), undefined, timeoutMs),
    );
    const fetched = results.find((result) => result.command === 'FETCH');
    if (!fetched) {
      throw new Error('PostgreSQL cursor batch did not return a FETCH result.');
    }
    return [fetched];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original batch error; PostgreSQL may already have rolled it back.
    }
    throw error;
  }
}

async function executeReadOnlyStatement(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  timeoutMs: number | undefined,
): Promise<SafePgQueryResult[]> {
  try {
    await client.query('BEGIN READ ONLY');
    await setLocalStatementTimeout(client, timeoutMs);
    const results = normalizePgResults(await executeTimedQuery(client, sql, params, timeoutMs));
    await client.query('COMMIT');
    return results;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original database error; rollback failure is secondary.
    }
    throw error;
  }
}

async function executePagedReadInActiveTransaction(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  rowLimit: number,
  timeoutMs: number | undefined,
): Promise<SafePgQueryResult[]> {
  const cursorName = `schemanaut_cursor_${randomUUID().replace(/-/g, '')}`;
  const fetchCount = rowLimit + 1;
  try {
    await setLocalStatementTimeout(client, timeoutMs);
    await executeTimedQuery(
      client,
      `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`,
      params,
      timeoutMs,
    );
    const result = await executeTimedQuery(
      client,
      `FETCH FORWARD ${fetchCount} FROM ${cursorName}`,
      undefined,
      timeoutMs,
    );
    await client.query(`CLOSE ${cursorName}`);
    return normalizePgResults(result);
  } catch (error) {
    try {
      await client.query(`CLOSE ${cursorName}`);
    } catch {
      // The transaction may already be aborted; the caller handles recovery.
    }
    throw error;
  }
}

async function executeInTransaction(
  client: PgPoolClient,
  sql: string,
  params?: unknown[],
  rollbackOnly = false,
  timeoutMs?: number,
): Promise<{ results: SafePgQueryResult[]; transaction: QueryTransactionReport }> {
  const transaction: QueryTransactionReport = {
    mode: rollbackOnly ? 'rollback' : 'auto',
    started: false,
    committed: false,
    rolledBack: false,
    rollbackOnly,
  };
  try {
    await client.query('BEGIN');
    transaction.started = true;
    await setLocalStatementTimeout(client, timeoutMs);
    const results = normalizePgResults(await executeTimedQuery(client, sql, params, timeoutMs));
    if (rollbackOnly) {
      await client.query('ROLLBACK');
      transaction.rolledBack = true;
      return { results, transaction };
    }
    await client.query('COMMIT');
    transaction.committed = true;
    return { results, transaction };
  } catch (error) {
    if (transaction.started && !transaction.committed && !transaction.rolledBack) {
      try {
        await client.query('ROLLBACK');
        transaction.rolledBack = true;
      } catch {
        // Preserve the original database error; rollback failure is secondary.
      }
    }
    throw error;
  }
}

async function executeWithSessionTimeout(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  timeoutMs: number | undefined,
): Promise<PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[]> {
  if (timeoutMs === undefined) return client.query<QueryResultRow>(sql, params);
  const current = await client.query<{ statement_timeout: string }>('show statement_timeout');
  const previous = current.rows[0]?.statement_timeout ?? '0';
  await client.query("select set_config('statement_timeout', $1, false)", [`${timeoutMs}ms`]);
  try {
    return await executeTimedQuery(client, sql, params, timeoutMs);
  } finally {
    try {
      await client.query("select set_config('statement_timeout', $1, false)", [previous]);
    } catch {
      // The original execution outcome is authoritative; pool-level defaults still bound future clients.
    }
  }
}

async function executeWithLocalTimeout(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  timeoutMs: number | undefined,
): Promise<PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[]> {
  if (timeoutMs === undefined) return client.query<QueryResultRow>(sql, params);
  const current = await client.query<{ statement_timeout: string }>('show statement_timeout');
  const previous = current.rows[0]?.statement_timeout ?? '0';
  await setLocalStatementTimeout(client, timeoutMs);
  try {
    return await executeTimedQuery(client, sql, params, timeoutMs);
  } finally {
    try {
      await client.query("select set_config('statement_timeout', $1, true)", [previous]);
    } catch {
      // A timed-out statement aborts the transaction; rollback/savepoint recovery restores local state.
    }
  }
}

async function setLocalStatementTimeout(
  client: PgPoolClient,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) return;
  await client.query("select set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
}

async function executeTimedQuery(
  client: PgPoolClient,
  sql: string,
  params: unknown[] | undefined,
  timeoutMs: number | undefined,
): Promise<PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[]> {
  const started = performance.now();
  try {
    return await client.query<QueryResultRow>(sql, params);
  } catch (error) {
    if (
      timeoutMs !== undefined &&
      postgresErrorCode(error) === '57014' &&
      performance.now() - started >= Math.max(0, timeoutMs - 10)
    ) {
      throw Object.assign(
        new Error(`PostgreSQL query exceeded the ${timeoutMs} ms execution timeout.`),
        {
          code: 'DBAGENT_QUERY_TIMEOUT',
          detail: error instanceof Error ? error.message : String(error),
        },
      );
    }
    throw error;
  }
}

function registerAbortCancellation(
  signal: AbortSignal | undefined,
  cancel: () => Promise<unknown>,
): (() => void) | undefined {
  if (!signal) return undefined;
  const abort = () => {
    void cancel().catch(() => {
      // The running query remains authoritative. If backend cancellation fails,
      // its normal timeout or database result still settles the execution.
    });
  };
  if (signal.aborted) {
    abort();
    return undefined;
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function resolveBackendPid(client: PgPoolClient): Promise<number | undefined> {
  const processId = (client as PgPoolClient & { processID?: number }).processID;
  if (typeof processId === 'number' && Number.isInteger(processId) && processId > 0) {
    return processId;
  }
  try {
    const result = await client.query<{ pid: number }>('select pg_backend_pid()::int as pid');
    const pid = result.rows[0]?.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function cancelBackendWithDedicatedClient(
  config: DatabaseConnectionConfig,
  backendPid: number,
): Promise<PgQueryResult<{ cancelled: boolean }>> {
  const { Client } = await import('pg');
  const client = new Client(toPgConfig(config));
  try {
    await client.connect();
    return await client.query<{ cancelled: boolean }>('select pg_cancel_backend($1) as cancelled', [
      backendPid,
    ]);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function normalizePgResults(result: SafePgQueryResult | SafePgQueryResult[]): SafePgQueryResult[] {
  if (Array.isArray(result)) return result;
  return [result];
}

function emptyPgResult(): SafePgQueryResult {
  const emptyRows: QueryResultRow[] = [];
  return {
    command: '',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: emptyRows,
  };
}

function toQueryExecutionResult(
  results: SafePgQueryResult[],
  safety: QueryExecutionResult['safety'],
  started: number,
  queryId: string,
  rowLimit: number,
  transaction?: QueryTransactionReport,
): QueryExecutionResult {
  const resultSets = results.map((result, index) => toQueryResultSet(result, index, rowLimit));
  const primary =
    resultSets.find((set) => set.columns.length > 0) ??
    resultSets.at(-1) ??
    toQueryResultSet(emptyPgResult(), 0, rowLimit);
  const messages = buildQueryMessages(resultSets);
  const returnedRowCount = primary.returnedRowCount ?? primary.rows.length;
  const primaryRowLimit = primary.rowLimit ?? rowLimit;
  const hasMore = primary.hasMore ?? false;
  const truncated = primary.truncated ?? false;
  const result: QueryExecutionResult = {
    queryId,
    columns: primary.columns,
    rows: primary.rows,
    rowCount: primary.rowCount,
    returnedRowCount,
    rowLimit: primaryRowLimit,
    hasMore,
    truncated,
    elapsedMs: Math.round(performance.now() - started),
    safety,
    ...(transaction === undefined ? {} : { transaction }),
  };
  if (resultSets.length > 1) result.resultSets = resultSets;
  if (messages.length > 0) result.messages = messages;
  return result;
}

function toQueryResultSet(
  result: SafePgQueryResult,
  index: number,
  rowLimit: number,
): QueryResultSet {
  const sourceRowCount = result.rowCount ?? result.rows.length;
  const truncated = result.rows.length > rowLimit;
  const hasMore = truncated;
  const rows = truncated ? result.rows.slice(0, rowLimit) : result.rows;
  return {
    index,
    command: result.command,
    columns: result.fields.map((field) => ({
      name: field.name,
      dataType: String(field.dataTypeID),
    })),
    rows,
    rowCount: sourceRowCount,
    returnedRowCount: rows.length,
    rowLimit,
    hasMore,
    truncated,
  };
}

function buildQueryMessages(resultSets: QueryResultSet[]): QueryExecutionMessage[] {
  const messages: QueryExecutionMessage[] = [];
  for (const set of resultSets) {
    if (set.truncated) {
      messages.push({
        level: 'warning' as const,
        statementIndex: set.index,
        message: `Statement ${set.index + 1} returned ${set.rowCount} row(s); only ${set.returnedRowCount ?? set.rows.length} row(s) are included because of the row limit.`,
      });
    }
  }
  if (resultSets.length <= 1) return messages;
  messages.push(
    ...resultSets.map((set) => ({
      level: 'info' as const,
      statementIndex: set.index,
      message:
        set.columns.length > 0
          ? `Statement ${set.index + 1} returned ${set.rowCount} row(s).`
          : `Statement ${set.index + 1} completed with command ${set.command || 'UNKNOWN'} and affected ${set.rowCount} row(s).`,
    })),
  );
  return messages;
}

function normalizeQueryRowLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_ROW_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_QUERY_ROW_LIMIT) return MAX_QUERY_ROW_LIMIT;
  return floored;
}

function inactiveConnection<T>(): Result<T> {
  return err({
    code: 'CONNECTION_FAILED',
    message: 'Connection is not active.',
    retryable: true,
  });
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toPostgresIsolation(level: TransactionIsolationLevel | undefined): string {
  switch (level) {
    case 'read-uncommitted':
      return 'READ UNCOMMITTED';
    case 'repeatable-read':
      return 'REPEATABLE READ';
    case 'serializable':
      return 'SERIALIZABLE';
    case 'read-committed':
    case undefined:
      return 'READ COMMITTED';
  }
}

function toPgConfig(config: DatabaseConnectionConfig) {
  const ssl =
    config.ssl === undefined || config.ssl === false
      ? undefined
      : config.ssl === 'verify-full'
        ? { rejectUnauthorized: true }
        : config.ssl === 'verify-ca'
          ? {
              rejectUnauthorized: true,
              // PostgreSQL verify-ca validates the certificate chain but,
              // unlike verify-full, deliberately skips hostname matching.
              checkServerIdentity: () => undefined,
            }
          : { rejectUnauthorized: false };
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl,
    max: config.maxClients ?? 5,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: config.statementTimeoutMs ?? 60_000,
    statement_timeout: config.statementTimeoutMs ?? 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'SchemaNaut',
    options: config.readOnly ? '-c default_transaction_read_only=on' : undefined,
  };
}
