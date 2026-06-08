import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { QueryExecutionResult, QueryRequest, SavedConnection } from '@dbagent/shared';
import { err, ok, type Result } from '@dbagent/shared';
import type { Pool as PgPool } from 'pg';
import { analyzeSqlSafety } from './sql-safety.js';
import type { DatabaseConnectionConfig, IDatabaseDriver, TableSummary } from './types.js';

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
      return err({
        code: 'CONNECTION_FAILED',
        message: 'Unable to connect to PostgreSQL.',
        detail: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
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
      const result = await pool.query(request.sql);
      return ok({
        queryId: randomUUID(),
        columns: result.fields.map((field) => ({ name: field.name, dataType: String(field.dataTypeID) })),
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        elapsedMs: Math.round(performance.now() - started),
        safety,
      });
    } catch (error) {
      return err({
        code: 'QUERY_FAILED',
        message: 'Query execution failed.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listTables(connectionId: string): Promise<Result<TableSummary[]>> {
    const pool = this.pools.get(connectionId);
    if (!pool) {
      return err({ code: 'CONNECTION_FAILED', message: 'Connection is not active.', retryable: true });
    }
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
  }
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
    application_name: 'DBAgent',
  };
}
