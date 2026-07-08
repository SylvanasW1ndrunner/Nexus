import type { QuerySafetyReport } from '@dbagent/shared';
import { analyzeSqlPerformance } from './sql-performance.js';
import { splitSqlStatements } from './sql-editor-statements.js';

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
  if (options.readOnly && readOnlyViolationKind) {
    reasons.push('Connection is read-only, so write or DDL statements are blocked.');
  }

  const blocked = options.readOnly && readOnlyViolationKind !== undefined;
  const requiresConfirmation =
    !blocked &&
    (writeKinds.has(statementKind) ||
      dangerousKinds.has(statementKind) ||
      reviewKinds.has(statementKind) ||
      statementKind === 'UNKNOWN' ||
      wrappedWriteKind !== undefined ||
      containsMultipleStatements(normalized));

  return {
    statementKind,
    riskLevel: blocked
      ? 'blocked'
      : dangerousKinds.has(statementKind) || unboundedMutation || wrappedWriteKind !== undefined
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
