import type { AgentBehaviorEvaluationReportInput } from '@dbagent/core-agent';
import type { AgentEvalSuiteCatalogServiceEntry } from './agent-eval-suite-catalog-service.js';
import type { AgentEvalSuiteRunResult } from './agent-eval-suite-runner.js';

type AgentEvalGateSuiteSourceKind = NonNullable<AgentBehaviorEvaluationReportInput['suiteSource']>['kind'];
type NormalizedAgentEvalGatePolicy = {
  minTotalCases: number;
  minPassRate: number;
  maxFailedCases: number;
  requireEnvironment?: AgentEvalSuiteCatalogServiceEntry['environment'];
  requireSourceKind?: AgentEvalGateSuiteSourceKind;
  requireLive: boolean;
  requirePostgres: boolean;
  requireSavedReport: boolean;
  requireReadonlyOnly: boolean;
  requiredToolNames: string[];
  forbiddenToolNames: string[];
};

export type AgentEvalGatePolicy = {
  minTotalCases?: number;
  minPassRate?: number;
  maxFailedCases?: number;
  requireEnvironment?: AgentEvalSuiteCatalogServiceEntry['environment'];
  requireSourceKind?: AgentEvalGateSuiteSourceKind;
  requireLive?: boolean;
  requirePostgres?: boolean;
  requireSavedReport?: boolean;
  requireReadonlyOnly?: boolean;
  requiredToolNames?: string[];
  forbiddenToolNames?: string[];
};

export type AgentEvalGateDecision = {
  passed: boolean;
  failures: string[];
  warnings: string[];
  metrics: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    passRate: number;
    environment?: AgentEvalSuiteCatalogServiceEntry['environment'];
    sourceKind: AgentEvalGateSuiteSourceKind;
    live: boolean;
    postgres: boolean;
    savedReport: boolean;
    readonlyOnly: boolean;
  };
};

export type AgentEvalGateInput = {
  runResult: AgentEvalSuiteRunResult;
  catalogEntry: AgentEvalSuiteCatalogServiceEntry;
  suiteSource: NonNullable<AgentBehaviorEvaluationReportInput['suiteSource']>;
  policy?: AgentEvalGatePolicy;
  effectiveReadonlyOnly?: boolean;
};

export function evaluateAgentEvalGate(input: AgentEvalGateInput): AgentEvalGateDecision {
  const policy = normalizePolicy(input.policy);
  const failures: string[] = [];
  const warnings: string[] = [];
  const summary = input.runResult.summary;
  const reportRun = input.runResult.report.run;
  const observedToolNames = new Set<string>();

  for (const result of summary.results) {
    for (const toolName of result.observedToolCalls) observedToolNames.add(toolName);
  }

  if (summary.totalCases < policy.minTotalCases) {
    failures.push(`Expected at least ${policy.minTotalCases} case(s), got ${summary.totalCases}.`);
  }
  if (summary.passRate < policy.minPassRate) {
    failures.push(
      `Expected pass rate >= ${formatRatio(policy.minPassRate)}, got ${formatRatio(summary.passRate)}.`,
    );
  }
  if (summary.failedCases > policy.maxFailedCases) {
    failures.push(`Expected failed cases <= ${policy.maxFailedCases}, got ${summary.failedCases}.`);
  }
  if (policy.requireEnvironment !== undefined && input.catalogEntry.environment !== policy.requireEnvironment) {
    failures.push(
      `Expected environment ${policy.requireEnvironment}, got ${input.catalogEntry.environment ?? 'undefined'}.`,
    );
  }
  if (policy.requireSourceKind !== undefined && input.suiteSource.kind !== policy.requireSourceKind) {
    failures.push(`Expected suite source ${policy.requireSourceKind}, got ${input.suiteSource.kind}.`);
  }
  if (policy.requireLive === true && reportRun.live !== true) {
    failures.push('Expected report run to be marked as live.');
  }
  if (policy.requirePostgres === true && reportRun.postgres !== true) {
    failures.push('Expected report run to be marked as PostgreSQL-backed.');
  }
  if (policy.requireSavedReport === true && input.runResult.savedReport === undefined) {
    failures.push('Expected evaluation report to be saved.');
  }
  const readonlyOnly = input.effectiveReadonlyOnly ?? input.catalogEntry.readonlyOnly;
  if (policy.requireReadonlyOnly === true && readonlyOnly !== true) {
    failures.push('Expected all suite cases to run in readonly mode.');
  }

  for (const toolName of policy.requiredToolNames) {
    if (!observedToolNames.has(toolName)) failures.push(`Required observed tool is missing: ${toolName}.`);
  }
  for (const toolName of policy.forbiddenToolNames) {
    if (observedToolNames.has(toolName)) failures.push(`Forbidden observed tool was called: ${toolName}.`);
  }

  for (const result of summary.results) {
    if (!result.passed) warnings.push(`Failed case ${result.id}: ${result.failures.join(' | ')}`);
  }
  if (input.catalogEntry.caseCount !== summary.totalCases) {
    warnings.push(
      `Catalog declares ${input.catalogEntry.caseCount} case(s), but run evaluated ${summary.totalCases}.`,
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: {
      totalCases: summary.totalCases,
      passedCases: summary.passedCases,
      failedCases: summary.failedCases,
      passRate: summary.passRate,
      ...(input.catalogEntry.environment === undefined ? {} : { environment: input.catalogEntry.environment }),
      sourceKind: input.suiteSource.kind,
      live: reportRun.live === true,
      postgres: reportRun.postgres === true,
      savedReport: input.runResult.savedReport !== undefined,
      readonlyOnly,
    },
  };
}

function normalizePolicy(policy: AgentEvalGatePolicy | undefined): NormalizedAgentEvalGatePolicy {
  const normalized: NormalizedAgentEvalGatePolicy = {
    minTotalCases: policy?.minTotalCases ?? 1,
    minPassRate: policy?.minPassRate ?? 1,
    maxFailedCases: policy?.maxFailedCases ?? 0,
    requireLive: policy?.requireLive ?? false,
    requirePostgres: policy?.requirePostgres ?? false,
    requireSavedReport: policy?.requireSavedReport ?? false,
    requireReadonlyOnly: policy?.requireReadonlyOnly ?? false,
    requiredToolNames: policy?.requiredToolNames ?? [],
    forbiddenToolNames: policy?.forbiddenToolNames ?? [],
  };
  if (policy?.requireEnvironment !== undefined) normalized.requireEnvironment = policy.requireEnvironment;
  if (policy?.requireSourceKind !== undefined) normalized.requireSourceKind = policy.requireSourceKind;
  return normalized;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
