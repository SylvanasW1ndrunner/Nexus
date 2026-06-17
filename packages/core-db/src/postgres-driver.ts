import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ColumnSummary, QueryExecutionResult, QueryRequest, SavedConnection, TableDetail } from '@dbagent/shared';
import { err, ok, type Result } from '@dbagent/shared';
import type { Pool as PgPool, QueryResult as PgQueryResult, QueryResultRow } from 'pg';
import { classifyPostgresConnectionError, classifyPostgresRuntimeError } from './postgres-errors.js';
import { analyzeSqlSafety } from './sql-safety.js';
import type { DatabaseConnectionConfig, IDatabaseDriver, TableSummary } from './types.js';

type SafePgQueryResult = PgQueryResult<QueryResultRow>;

export class PostgresDriver implements IDatabaseDriver {
  readonly capabilities = {
    engine: 'postgres' as const,
    supportsTransactions: true,
    supportsExplain: true,
    supportsSchemas: true,
  };

  private readonly pools = new Map<string, PgPool>();

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
    this.pools.set(config.id, new Pool(toPgConfig(config)));
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
    const pool = this.pools.get(connectionId);
    if (pool) {
      await pool.end();
      this.pools.delete(connectionId);
    }
    return ok(undefined);
  }

  async execute(request: QueryRequest, connection: SavedConnection): Promise<Result<QueryExecutionResult>> {
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

    const pool = this.pools.get(connection.id);
    if (!pool) {
      return err({ code: 'CONNECTION_FAILED', message: 'Connection is not active.', retryable: true });
    }

    const started = performance.now();
    try {
      const result = safety.requiresConfirmation
        ? await executeInTransaction(pool, request.sql, request.params)
        : normalizePgResult(await pool.query<QueryResultRow>(request.sql, request.params));
      return ok(toQueryExecutionResult(result, safety, started));
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }

  async listTables(connectionId: string): Promise<Result<TableSummary[]>> {
    const pool = this.pools.get(connectionId);
    if (!pool) {
      return err({ code: 'CONNECTION_FAILED', message: 'Connection is not active.', retryable: true });
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

  async describeTable(connectionId: string, schema: string, table: string): Promise<Result<TableDetail>> {
    const pool = this.pools.get(connectionId);
    if (!pool) {
      return err({ code: 'CONNECTION_FAILED', message: 'Connection is not active.', retryable: true });
    }

    try {
      const tableResult = await pool.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        comment: string | null;
      }>(
        `
          select
            n.nspname as schema_name,
            c.relname as table_name,
            case c.relkind when 'v' then 'view' else 'table' end as table_type,
            obj_description(c.oid) as comment
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
            fa.attname as foreign_column
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
        if (row.foreign_schema && row.foreign_table && row.foreign_column) {
          column.foreignKey = {
            schema: row.foreign_schema,
            table: row.foreign_table,
            column: row.foreign_column,
          };
        }
        return column;
      });

      const detail: TableDetail = {
        schema: tableRow.schema_name,
        name: tableRow.table_name,
        type: tableRow.table_type === 'view' ? 'view' : 'table',
        columns,
        primaryKey: columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
      };
      if (tableRow.comment) detail.comment = tableRow.comment;
      return ok(detail);
    } catch (error) {
      return err(classifyPostgresRuntimeError(error));
    }
  }
}

async function executeInTransaction(pool: PgPool, sql: string, params?: unknown[]): Promise<SafePgQueryResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = normalizePgResult(await client.query<QueryResultRow>(sql, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original database error; rollback failure is secondary.
    }
    throw error;
  } finally {
    client.release();
  }
}

function normalizePgResult(result: SafePgQueryResult | SafePgQueryResult[]): SafePgQueryResult {
  if (!Array.isArray(result)) return result;
  const emptyRows: QueryResultRow[] = [];
  return result.at(-1) ?? {
    command: '',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: emptyRows,
  };
}

function toQueryExecutionResult(
  result: SafePgQueryResult,
  safety: QueryExecutionResult['safety'],
  started: number,
): QueryExecutionResult {
  return {
    queryId: randomUUID(),
    columns: result.fields.map((field) => ({ name: field.name, dataType: String(field.dataTypeID) })),
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
    elapsedMs: Math.round(performance.now() - started),
    safety,
  };
}

function toPgConfig(config: DatabaseConnectionConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.maxClients ?? 5,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: config.statementTimeoutMs ?? 60_000,
    statement_timeout: config.statementTimeoutMs ?? 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'DBAgent',
  };
}
