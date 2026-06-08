import type { QuerySafetyReport } from '@dbagent/shared';
import { analyzeSqlPerformance } from './sql-performance.js';

const dangerousKinds = new Set(['DROP', 'TRUNCATE', 'ALTER', 'CREATE']);
const writeKinds = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL']);
const safeKinds = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'VALUES']);

export type AnalyzeSqlOptions = {
  readOnly: boolean;
};

export function analyzeSqlSafety(sql: string, options: AnalyzeSqlOptions): QuerySafetyReport {
  const normalized = stripSqlComments(sql).trim();
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

  if (containsMultipleStatements(normalized)) {
    reasons.push('Multiple statements require review before execution.');
  }

  if (dangerousKinds.has(statementKind)) {
    reasons.push(`${statementKind} changes database structure or destroys data.`);
  }

  if (writeKinds.has(statementKind)) {
    reasons.push(`${statementKind} writes data and requires explicit confirmation.`);
  }

  if (options.readOnly && !safeKinds.has(statementKind)) {
    reasons.push('Connection is read-only, so write or DDL statements are blocked.');
  }

  const blocked = options.readOnly && !safeKinds.has(statementKind);
  const requiresConfirmation =
    !blocked &&
    (writeKinds.has(statementKind) ||
      dangerousKinds.has(statementKind) ||
      containsMultipleStatements(normalized));

  return {
    statementKind,
    riskLevel: blocked
      ? 'blocked'
      : dangerousKinds.has(statementKind)
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
  const withoutTrailing = sql.trim().replace(/;+\s*$/g, '');
  return withoutTrailing.includes(';');
}
