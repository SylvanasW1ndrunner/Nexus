import type { ConnectionId, QueryRequest, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import {
  findSqlStatementAtPosition,
  getSqlLineColumnFromOffset,
  getSqlOffsetFromLineColumn,
  type SqlStatementSegment,
  splitSqlStatements,
} from './sql-editor-statements.js';
import {
  buildSqlExecutionPlan,
  type SqlExecutionPlan,
  type SqlExecutionPlanOptions,
} from './sql-execution-plan.js';

export type SqlEditorExecutionMode =
  | 'selection'
  | 'current-statement'
  | 'full-file'
  | 'explain-current-statement';

export type SqlEditorTextSelection = {
  startOffset: number;
  endOffset: number;
};

export type SqlEditorCursor =
  | {
      offset: number;
      line?: never;
      column?: never;
    }
  | {
      offset?: never;
      line: number;
      column: number;
    };

export type ResolveSqlEditorExecutionTargetInput = {
  connectionId: ConnectionId;
  documentText: string;
  mode: SqlEditorExecutionMode;
  selection?: SqlEditorTextSelection;
  cursor?: SqlEditorCursor;
  readOnly: boolean;
  supportsTransactions?: boolean;
  supportsExplain?: boolean;
  confirmed?: boolean;
  limit?: number;
  explainAnalyze?: boolean;
};

export type SqlEditorExecutionRange = {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type SqlEditorExecutionTarget = {
  mode: SqlEditorExecutionMode;
  sourceSql: string;
  executableSql: string;
  statementKind: string;
  range: SqlEditorExecutionRange;
  queryRequest: QueryRequest;
  executionPlan: SqlExecutionPlan;
  warnings: string[];
};

const readKinds = new Set(['SELECT', 'WITH', 'SHOW', 'VALUES']);

export function resolveSqlEditorExecutionTarget(
  input: ResolveSqlEditorExecutionTargetInput,
): Result<SqlEditorExecutionTarget> {
  const source = resolveSourceSql(input);
  if (!source.ok) return source;

  const executionPlan = buildSqlExecutionPlan(source.data.sql, toExecutionPlanOptions(input));
  const explainMode = input.mode === 'explain-current-statement';
  const warnings: string[] = [];

  if (explainMode) {
    if (input.supportsExplain === false) {
      return err({
        code: 'UNSUPPORTED_OPERATION',
        message: 'Current connection does not support EXPLAIN.',
      });
    }
    if (!readKinds.has(executionPlan.statementKind)) {
      return err({
        code: 'UNSUPPORTED_OPERATION',
        message:
          'EXPLAIN ANALYZE is only allowed for read-only statements from the editor command.',
      });
    }
    if (executionPlan.decision !== 'execute') {
      return err({
        code:
          executionPlan.decision === 'blocked' ? 'READ_ONLY_VIOLATION' : 'CONFIRMATION_REQUIRED',
        message: 'Source SQL must pass execution preflight before EXPLAIN can run.',
        detail: executionPlan.confirmationReasons.join(' '),
      });
    }
  }

  const executableSql = explainMode
    ? buildExplainSql(source.data.sql, input.explainAnalyze ?? true)
    : source.data.sql;
  if (explainMode && input.explainAnalyze !== false) {
    warnings.push('EXPLAIN ANALYZE executes the read query to collect runtime metrics.');
  }

  const queryRequest: QueryRequest = {
    connectionId: input.connectionId,
    sql: executableSql,
  };
  if (input.confirmed !== undefined) queryRequest.confirmed = input.confirmed;
  if (input.limit !== undefined) queryRequest.limit = input.limit;

  return ok({
    mode: input.mode,
    sourceSql: source.data.sql,
    executableSql,
    statementKind: executionPlan.statementKind,
    range: source.data.range,
    queryRequest,
    executionPlan,
    warnings,
  });
}

function resolveSourceSql(
  input: ResolveSqlEditorExecutionTargetInput,
): Result<{ sql: string; range: SqlEditorExecutionRange }> {
  if (input.mode === 'selection') return resolveSelection(input.documentText, input.selection);
  if (input.mode === 'current-statement' || input.mode === 'explain-current-statement') {
    return resolveCurrentStatement(input.documentText, input.cursor);
  }
  return resolveFullFile(input.documentText);
}

function resolveSelection(
  documentText: string,
  selection: SqlEditorTextSelection | undefined,
): Result<{ sql: string; range: SqlEditorExecutionRange }> {
  if (!selection) return err({ code: 'VALIDATION_ERROR', message: 'SQL selection is required.' });

  const start = clampOffset(documentText, Math.min(selection.startOffset, selection.endOffset));
  const end = clampOffset(documentText, Math.max(selection.startOffset, selection.endOffset));
  const trimmed = trimRange(documentText, start, end);
  if (
    trimmed.start >= trimmed.end ||
    splitSqlStatements(documentText.slice(trimmed.start, trimmed.end)).length === 0
  ) {
    return err({ code: 'VALIDATION_ERROR', message: 'Selected SQL is empty.' });
  }

  return ok({
    sql: documentText.slice(trimmed.start, trimmed.end),
    range: toRange(documentText, trimmed.start, trimmed.end),
  });
}

function resolveCurrentStatement(
  documentText: string,
  cursor: SqlEditorCursor | undefined,
): Result<{ sql: string; range: SqlEditorExecutionRange }> {
  if (!cursor)
    return err({ code: 'VALIDATION_ERROR', message: 'SQL cursor position is required.' });
  const offset =
    cursor.offset !== undefined
      ? clampOffset(documentText, cursor.offset)
      : getSqlOffsetFromLineColumn(documentText, cursor.line, cursor.column);
  const statement = findSqlStatementAtPosition(documentText, offset);
  if (!statement) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'No executable SQL statement was found at the cursor.',
    });
  }

  return ok({
    sql: statement.text,
    range: segmentToRange(statement),
  });
}

function resolveFullFile(
  documentText: string,
): Result<{ sql: string; range: SqlEditorExecutionRange }> {
  const trimmed = trimRange(documentText, 0, documentText.length);
  if (trimmed.start >= trimmed.end || splitSqlStatements(documentText).length === 0) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'SQL file does not contain an executable statement.',
    });
  }
  return ok({
    sql: documentText.slice(trimmed.start, trimmed.end),
    range: toRange(documentText, trimmed.start, trimmed.end),
  });
}

function toExecutionPlanOptions(
  input: ResolveSqlEditorExecutionTargetInput,
): SqlExecutionPlanOptions {
  const options: SqlExecutionPlanOptions = {
    readOnly: input.readOnly,
    requireExplainForReads: input.mode === 'explain-current-statement',
  };
  if (input.supportsTransactions !== undefined)
    options.supportsTransactions = input.supportsTransactions;
  if (input.supportsExplain !== undefined) options.supportsExplain = input.supportsExplain;
  if (input.confirmed !== undefined) options.confirmed = input.confirmed;
  return options;
}

function buildExplainSql(sql: string, analyze: boolean): string {
  const statement = sql.trim().replace(/;+\s*$/g, '');
  const options = analyze ? 'analyze, buffers, format json' : 'format json';
  return `explain (${options})\n${statement};`;
}

function clampOffset(documentText: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.floor(offset), documentText.length));
}

function trimRange(
  documentText: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(documentText[start] ?? '')) start += 1;
  while (end > start && /\s/.test(documentText[end - 1] ?? '')) end -= 1;
  return { start, end };
}

function toRange(
  documentText: string,
  startOffset: number,
  endOffset: number,
): SqlEditorExecutionRange {
  const start = getSqlLineColumnFromOffset(documentText, startOffset);
  const end = getSqlLineColumnFromOffset(documentText, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function segmentToRange(statement: SqlStatementSegment): SqlEditorExecutionRange {
  return {
    startOffset: statement.startOffset,
    endOffset: statement.endOffset,
    startLine: statement.startLine,
    startColumn: statement.startColumn,
    endLine: statement.endLine,
    endColumn: statement.endColumn,
  };
}
