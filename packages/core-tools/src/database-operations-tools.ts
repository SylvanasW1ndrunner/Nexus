import type { ToolRegistry } from '@dbagent/core-agent';
import { analyzeSqlSafety, type IDatabaseDriver } from '@dbagent/core-db';
import type { SavedConnection } from '@dbagent/shared';
import { optionalPositiveInteger, requireString } from './validation.js';

export type DatabaseOperationToolDependencies = {
  registry: ToolRegistry;
  driver: IDatabaseDriver;
  getConnection: (
    connectionId: string,
  ) => SavedConnection | undefined | Promise<SavedConnection | undefined>;
};

export function registerDatabaseOperationTools(
  dependencies: DatabaseOperationToolDependencies,
): void {
  const { registry } = dependencies;

  registry.register(
    {
      name: 'explain_query',
      description: 'Return a PostgreSQL JSON EXPLAIN plan for a readonly query without running EXPLAIN ANALYZE.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        sql: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'database',
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const sql = requireString(args, 'sql');
      const safety = analyzeSqlSafety(sql, { readOnly: true });
      if (safety.blocked || safety.requiresConfirmation || safety.statementKind === 'EMPTY') {
        throw new Error(`EXPLAIN only accepts one readonly statement. ${safety.reasons.join(' ')}`);
      }
      return executeReadonly(
        dependencies,
        connectionId,
        `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE, SETTINGS TRUE) ${sql}`,
        1,
      );
    },
  );

  registry.register(
    {
      name: 'database_health_snapshot',
      description: 'Collect a readonly PostgreSQL health snapshot for sessions, transactions, cache hit ratio, and uptime.',
      inputSchema: objectSchema({ connectionId: { type: 'string' } }),
      dangerLevel: 'safe',
      readonly: true,
      source: 'database',
    },
    async (args) =>
      executeReadonly(
        dependencies,
        requireString(args, 'connectionId'),
        HEALTH_SNAPSHOT_SQL,
        1,
      ),
  );

  registry.register(
    {
      name: 'diagnose_slow_queries',
      description: 'Read top PostgreSQL statements from pg_stat_statements. The extension must be enabled by the database administrator.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        limit: { type: 'number' },
      }),
      dangerLevel: 'medium',
      readonly: true,
      source: 'database',
    },
    async (args) => {
      const limit = Math.min(optionalPositiveInteger(args, 'limit', 20) ?? 20, 100);
      return executeReadonly(
        dependencies,
        requireString(args, 'connectionId'),
        slowQueriesSql(limit),
        limit,
      );
    },
  );

  registry.register(
    {
      name: 'diagnose_locks',
      description: 'List PostgreSQL sessions currently blocked by other backend processes. This tool never terminates a session.',
      inputSchema: objectSchema({ connectionId: { type: 'string' } }),
      dangerLevel: 'medium',
      readonly: true,
      source: 'database',
    },
    async (args) =>
      executeReadonly(
        dependencies,
        requireString(args, 'connectionId'),
        LOCK_DIAGNOSIS_SQL,
        100,
      ),
  );

  registry.register(
    {
      name: 'diagnose_long_transactions',
      description: 'List PostgreSQL transactions older than a threshold, including idle-in-transaction sessions.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        minDurationSeconds: { type: 'number' },
      }),
      dangerLevel: 'medium',
      readonly: true,
      source: 'database',
    },
    async (args) => {
      const seconds = Math.min(
        optionalPositiveInteger(args, 'minDurationSeconds', 300) ?? 300,
        86_400,
      );
      return executeReadonly(
        dependencies,
        requireString(args, 'connectionId'),
        longTransactionsSql(seconds),
        100,
      );
    },
  );
}

async function executeReadonly(
  dependencies: DatabaseOperationToolDependencies,
  connectionId: string,
  sql: string,
  limit: number,
): Promise<unknown> {
  const connection = await dependencies.getConnection(connectionId);
  if (!connection) throw new Error(`Connection is not active: ${connectionId}`);
  if (connection.engine !== 'postgres') {
    throw new Error('Database operation diagnostics currently support PostgreSQL only.');
  }
  const result = await dependencies.driver.execute(
    { connectionId, sql, limit },
    { ...connection, readOnly: true },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return { type: 'object', properties, required: ['connectionId'] };
}

function slowQueriesSql(limit: number): string {
  return `
SELECT
  queryid::text AS query_id,
  calls,
  round(total_exec_time::numeric, 2) AS total_exec_time_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_time_ms,
  rows,
  left(query, 2000) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT ${limit}`.trim();
}

function longTransactionsSql(seconds: number): string {
  return `
SELECT
  pid,
  usename,
  application_name,
  client_addr::text AS client_addr,
  state,
  wait_event_type,
  wait_event,
  xact_start,
  now() - xact_start AS transaction_age,
  left(query, 2000) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND xact_start IS NOT NULL
  AND now() - xact_start >= make_interval(secs => ${seconds})
  AND pid <> pg_backend_pid()
ORDER BY xact_start ASC
LIMIT 100`.trim();
}

const HEALTH_SNAPSHOT_SQL = `
SELECT
  current_database() AS database_name,
  now() AS captured_at,
  pg_postmaster_start_time() AS server_started_at,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS sessions,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active_sessions,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') AS idle_in_transaction_sessions,
  (
    SELECT round(
      100.0 * sum(blks_hit)::numeric / nullif(sum(blks_hit + blks_read), 0),
      2
    )
    FROM pg_stat_database
    WHERE datname = current_database()
  ) AS cache_hit_ratio_percent
`.trim();

const LOCK_DIAGNOSIS_SQL = `
SELECT
  blocked.pid AS blocked_pid,
  blocked.usename AS blocked_user,
  blocked.application_name AS blocked_application,
  blocked.state AS blocked_state,
  blocked.wait_event_type,
  blocked.wait_event,
  now() - blocked.query_start AS blocked_duration,
  left(blocked.query, 2000) AS blocked_query,
  blocker.pid AS blocker_pid,
  blocker.usename AS blocker_user,
  blocker.application_name AS blocker_application,
  blocker.state AS blocker_state,
  now() - blocker.query_start AS blocker_duration,
  left(blocker.query, 2000) AS blocker_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid
JOIN pg_stat_activity AS blocker ON blocker.pid = blocker_pid
WHERE blocked.datname = current_database()
ORDER BY blocked.query_start ASC
LIMIT 100`.trim();
