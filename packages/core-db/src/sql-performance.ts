import type { SqlPerformanceWarning } from '@dbagent/shared';

export function analyzeSqlPerformance(sql: string): SqlPerformanceWarning[] {
  const normalized = stripSqlComments(sql).trim();
  const upper = normalized.toUpperCase();
  const warnings: SqlPerformanceWarning[] = [];

  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) return warnings;

  if (/\bSELECT\s+\*/i.test(normalized)) {
    warnings.push({
      code: 'SELECT_STAR',
      severity: 'info',
      message: 'SELECT * can transfer unnecessary columns; select only the columns needed for analysis.',
    });
  }

  if (!/\bLIMIT\s+\d+/i.test(normalized) && !/\bCOUNT\s*\(/i.test(normalized)) {
    warnings.push({
      code: 'MISSING_LIMIT',
      severity: 'warning',
      message: 'Query has no LIMIT; exploratory reads should cap rows before loading results into the desktop app.',
    });
  }

  if (/\bLIKE\s+(['"]?)%/i.test(normalized)) {
    warnings.push({
      code: 'LEADING_WILDCARD_LIKE',
      severity: 'warning',
      message: 'Leading-wildcard LIKE patterns usually cannot use a normal btree index.',
    });
  }

  if (/\bOFFSET\s+([1-9]\d{4,})\b/i.test(normalized)) {
    warnings.push({
      code: 'LARGE_OFFSET',
      severity: 'warning',
      message: 'Large OFFSET pagination can scan and discard many rows; keyset pagination is usually safer.',
    });
  }

  if (/\bFROM\s+[\w".]+(?:\s+(?:AS\s+)?[\w"]+)?\s*,\s*[\w".]+(?:\s+(?:AS\s+)?[\w"]+)?/i.test(normalized)) {
    warnings.push({
      code: 'CARTESIAN_JOIN',
      severity: 'warning',
      message: 'Comma joins can accidentally create Cartesian products; prefer explicit JOIN ... ON clauses.',
    });
  }

  if (/\bWHERE\b[\s\S]*(?:LOWER|UPPER|DATE_TRUNC|COALESCE|SUBSTRING)\s*\(/i.test(normalized)) {
    warnings.push({
      code: 'FUNCTION_ON_FILTER_COLUMN',
      severity: 'info',
      message: 'Functions in WHERE clauses can prevent index usage unless a matching expression index exists.',
    });
  }

  return warnings;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ');
}
