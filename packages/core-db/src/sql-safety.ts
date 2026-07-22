import type { QuerySafetyReport } from '@dbagent/shared';
import { analyzeSqlPerformance } from './sql-performance.js';
import { splitSqlStatements } from './sql-statements.js';

const dangerousKinds = new Set(['DROP', 'TRUNCATE', 'ALTER', 'CREATE']);
const writeKinds = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL']);
const safeKinds = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'VALUES']);
const reviewKinds = new Set([
  'ANALYZE',
  'CLUSTER',
  'COMMENT',
  'COPY',
  'DO',
  'GRANT',
  'LOCK',
  'REFRESH',
  'REINDEX',
  'RESET',
  'REVOKE',
  'SET',
  'VACUUM',
]);

const sideEffectFunctions = [
  'nextval',
  'setval',
  'set_config',
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  'pg_try_advisory_xact_lock',
  'pg_try_advisory_xact_lock_shared',
  'pg_cancel_backend',
  'pg_terminate_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_logical_emit_message',
  'pg_create_restore_point',
  'lo_create',
  'lo_from_bytea',
  'lo_import',
  'lo_export',
  'lo_put',
  'lo_unlink',
  'dblink_exec',
] as const;

const sideEffectFunctionPattern = new RegExp(`\\b(${sideEffectFunctions.join('|')})\\s*\\(`, 'i');

export type AnalyzeSqlOptions = {
  readOnly: boolean;
};

export function analyzeSqlSafety(sql: string, options: AnalyzeSqlOptions): QuerySafetyReport {
  const normalized = stripSqlComments(sql).trim();
  const statements = splitSqlStatements(normalized).map((statement) => statement.text);
  const statementKind = firstStatementKind(normalized);
  const reasons: string[] = [];

  if (!normalized) {
    return {
      statementKind: 'EMPTY',
      riskLevel: 'blocked',
      requiresConfirmation: false,
      blocked: true,
      reasons: ['SQL is empty.'],
    };
  }

  if (statements.length > 1) {
    reasons.push('Multiple statements require review before execution.');
  }

  if (dangerousKinds.has(statementKind)) {
    reasons.push(`${statementKind} changes database structure or destroys data.`);
  }

  if (writeKinds.has(statementKind)) {
    reasons.push(`${statementKind} writes data and requires explicit confirmation.`);
  }

  const wrappedWriteKind = findWrappedWriteKind(normalized, statementKind);
  if (wrappedWriteKind) {
    reasons.push(`${statementKind} contains ${wrappedWriteKind}, so it may change data and requires review.`);
  }

  if (reviewKinds.has(statementKind)) {
    reasons.push(`${statementKind} changes database/session state or requires operator review.`);
  }

  if (statementKind === 'UNKNOWN') {
    reasons.push('SQL statement type is unknown and requires review.');
  }

  const unboundedMutation = isUnboundedMutation(normalized, statementKind);
  if (unboundedMutation) {
    reasons.push(`${statementKind} without WHERE may affect every row in the target table.`);
  }

  const readOnlyViolationKind = findReadOnlyViolationKind(statements);
  const readSideEffect = findReadSideEffect(normalized, statementKind);
  if (readSideEffect) {
    reasons.push(
      `${statementKind} contains ${readSideEffect}, so it can change database or session state.`,
    );
  }

  if (options.readOnly && (readOnlyViolationKind || readSideEffect)) {
    reasons.push(
      'Connection is read-only, so write, locking, or side-effecting statements are blocked.',
    );
  }

  const blocked =
    options.readOnly && (readOnlyViolationKind !== undefined || readSideEffect !== undefined);
  const requiresConfirmation =
    !blocked &&
    (writeKinds.has(statementKind) ||
      dangerousKinds.has(statementKind) ||
      reviewKinds.has(statementKind) ||
      statementKind === 'UNKNOWN' ||
      wrappedWriteKind !== undefined ||
      readSideEffect !== undefined ||
      containsMultipleStatements(normalized));

  return {
    statementKind,
    riskLevel: blocked
      ? 'blocked'
      : dangerousKinds.has(statementKind) ||
          unboundedMutation ||
          wrappedWriteKind !== undefined ||
          readSideEffect !== undefined
        ? 'dangerous'
        : requiresConfirmation
          ? 'caution'
          : 'safe',
    requiresConfirmation,
    blocked,
    reasons,
    performanceWarnings: analyzeSqlPerformance(normalized),
  };
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ');
}

export function firstStatementKind(sql: string): string {
  return sql.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase() ?? 'UNKNOWN';
}

export function containsMultipleStatements(sql: string): boolean {
  return splitSqlStatements(sql).length > 1;
}

function isUnboundedMutation(sql: string, statementKind: string): boolean {
  if (statementKind !== 'UPDATE' && statementKind !== 'DELETE') return false;
  return !/\bWHERE\b/i.test(sql);
}

function findWrappedWriteKind(sql: string, statementKind: string): string | undefined {
  if (statementKind === 'WITH') {
    return sql.match(/\b(INSERT|UPDATE|DELETE|MERGE|CALL|CREATE|ALTER|DROP|TRUNCATE)\b/i)?.[1]?.toUpperCase();
  }
  if (statementKind === 'EXPLAIN' && /\bANALYZE\b/i.test(sql)) {
    return sql.match(/\b(INSERT|UPDATE|DELETE|MERGE|CALL|CREATE|ALTER|DROP|TRUNCATE)\b/i)?.[1]?.toUpperCase();
  }
  return undefined;
}

function findReadOnlyViolationKind(statements: string[]): string | undefined {
  for (const statement of statements.length > 0 ? statements : ['']) {
    const kind = firstStatementKind(statement);
    if (!safeKinds.has(kind)) return kind;
    const wrappedWriteKind = findWrappedWriteKind(statement, kind);
    if (wrappedWriteKind) return wrappedWriteKind;
  }
  return undefined;
}

function findReadSideEffect(sql: string, statementKind: string): string | undefined {
  if (statementKind !== 'SELECT' && statementKind !== 'WITH' && statementKind !== 'VALUES') {
    return undefined;
  }

  const masked = maskSqlLiterals(sql);
  if (/\bSELECT\b[\s\S]*?\bINTO\b/i.test(masked)) return 'SELECT INTO';

  const rowLock = masked.match(/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i)?.[0];
  if (rowLock) return `row-locking clause ${rowLock.toUpperCase().replace(/\s+/g, ' ')}`;

  const functionName = masked.match(sideEffectFunctionPattern)?.[1];
  if (functionName) return `side-effect function ${functionName.toLowerCase()}()`;

  return undefined;
}

function maskSqlLiterals(sql: string): string {
  let output = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'" || char === '"') {
      const quote = char;
      output += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            output += '  ';
            index += 2;
            continue;
          }
          output += ' ';
          index += 1;
          break;
        }
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const closingIndex = sql.indexOf(delimiter, index + delimiter.length);
        if (closingIndex >= 0) {
          const end = closingIndex + delimiter.length;
          output += ' '.repeat(end - index);
          index = end;
          continue;
        }
      }
    }

    output += char;
    index += 1;
  }

  return output;
}
