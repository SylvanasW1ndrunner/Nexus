import type { QuerySafetyReport } from '@dbagent/shared';
import { analyzeSqlSafety, containsMultipleStatements, firstStatementKind, stripSqlComments } from './sql-safety.js';

export type SqlExecutionPlanOptions = {
  readOnly: boolean;
  supportsTransactions?: boolean;
  supportsExplain?: boolean;
  confirmed?: boolean;
  requireExplainForReads?: boolean;
};

export type SqlExecutionDecision = 'execute' | 'requires-confirmation' | 'blocked';

export type SqlTransactionPolicy = 'none' | 'recommended' | 'required' | 'unavailable';

export type SqlExecutionPlan = {
  statementKind: string;
  decision: SqlExecutionDecision;
  safety: QuerySafetyReport;
  transactionPolicy: SqlTransactionPolicy;
  rollbackAvailable: boolean;
  shouldExplainBeforeRun: boolean;
  confirmationRequired: boolean;
  confirmationReasons: string[];
  executionNotes: string[];
};

const writeKinds = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL']);
const ddlKinds = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE']);
const readKinds = new Set(['SELECT', 'WITH', 'SHOW', 'VALUES']);

export function buildSqlExecutionPlan(sql: string, options: SqlExecutionPlanOptions): SqlExecutionPlan {
  const safety = analyzeSqlSafety(sql, { readOnly: options.readOnly });
  const normalized = stripSqlComments(sql).trim();
  const statementKind = safety.statementKind || firstStatementKind(normalized);
  const supportsTransactions = options.supportsTransactions ?? true;
  const supportsExplain = options.supportsExplain ?? true;
  const confirmationRequired = safety.requiresConfirmation && !options.confirmed;
  const decision: SqlExecutionDecision = safety.blocked
    ? 'blocked'
    : confirmationRequired
      ? 'requires-confirmation'
      : 'execute';
  const transactionPolicy = chooseTransactionPolicy(statementKind, normalized, safety, supportsTransactions);
  const rollbackAvailable = transactionPolicy === 'recommended' || transactionPolicy === 'required';
  const shouldExplainBeforeRun =
    supportsExplain &&
    !safety.blocked &&
    isReadStatement(statementKind) &&
    (options.requireExplainForReads === true ||
      safety.performanceWarnings?.some((warning) => warning.severity === 'warning') === true);

  return {
    statementKind,
    decision,
    safety,
    transactionPolicy,
    rollbackAvailable,
    shouldExplainBeforeRun,
    confirmationRequired,
    confirmationReasons: confirmationRequired ? safety.reasons : [],
    executionNotes: buildExecutionNotes({
      decision,
      transactionPolicy,
      rollbackAvailable,
      shouldExplainBeforeRun,
      safety,
      supportsTransactions,
    }),
  };
}

function chooseTransactionPolicy(
  statementKind: string,
  normalizedSql: string,
  safety: QuerySafetyReport,
  supportsTransactions: boolean,
): SqlTransactionPolicy {
  if (safety.blocked || isReadStatement(statementKind)) return 'none';
  const needsTransaction =
    writeKinds.has(statementKind) ||
    ddlKinds.has(statementKind) ||
    containsMultipleStatements(normalizedSql) ||
    safety.riskLevel === 'dangerous';
  if (!needsTransaction) return 'none';
  if (!supportsTransactions) return 'unavailable';
  if (containsMultipleStatements(normalizedSql) || safety.riskLevel === 'dangerous') return 'required';
  return 'recommended';
}

function isReadStatement(statementKind: string): boolean {
  return readKinds.has(statementKind);
}

function buildExecutionNotes(input: {
  decision: SqlExecutionDecision;
  transactionPolicy: SqlTransactionPolicy;
  rollbackAvailable: boolean;
  shouldExplainBeforeRun: boolean;
  safety: QuerySafetyReport;
  supportsTransactions: boolean;
}): string[] {
  const notes: string[] = [];
  if (input.decision === 'blocked') notes.push('Execution is blocked before reaching the database.');
  if (input.decision === 'requires-confirmation') notes.push('Explicit user confirmation is required before execution.');
  if (input.transactionPolicy === 'required') notes.push('Execute inside a transaction and rollback on any failure.');
  if (input.transactionPolicy === 'recommended') notes.push('Transaction execution is recommended for rollback protection.');
  if (input.transactionPolicy === 'unavailable' && !input.supportsTransactions) {
    notes.push('The database driver does not support rollback protection for this statement.');
  }
  if (input.shouldExplainBeforeRun) notes.push('Run EXPLAIN before execution to inspect query cost and scan risk.');
  for (const warning of input.safety.performanceWarnings ?? []) {
    notes.push(`Performance warning ${warning.code}: ${warning.message}`);
  }
  return notes;
}
