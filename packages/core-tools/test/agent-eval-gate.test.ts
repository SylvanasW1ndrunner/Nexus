import { describe, expect, it } from 'vitest';
import type { AgentBehaviorEvaluationSummary } from '@dbagent/core-agent';
import {
  evaluateAgentEvalGate,
  type AgentEvalSuiteCatalogServiceEntry,
  type AgentEvalSuiteRunResult,
} from '../src/index.js';

describe('evaluateAgentEvalGate', () => {
  it('passes a strict release gate when the evaluation run proves the required behavior', () => {
    const decision = evaluateAgentEvalGate({
      catalogEntry: catalogEntry(),
      suiteSource: { kind: 'official', pluginId: 'official.agent-rag-eval' },
      runResult: runResult(summary({ failedCases: 0 })),
      policy: {
        minTotalCases: 2,
        minPassRate: 1,
        maxFailedCases: 0,
        requireEnvironment: 'postgres',
        requireSourceKind: 'official',
        requirePostgres: true,
        requireSavedReport: true,
        requireReadonlyOnly: true,
        requiredToolNames: ['search_schema', 'query_database'],
        forbiddenToolNames: ['execute_sql'],
      },
    });

    expect(decision).toMatchObject({
      passed: true,
      failures: [],
      metrics: {
        totalCases: 2,
        passedCases: 2,
        failedCases: 0,
        passRate: 1,
        environment: 'postgres',
        sourceKind: 'official',
        postgres: true,
        savedReport: true,
        readonlyOnly: true,
      },
    });
  });

  it('fails with concrete reasons when release evidence is incomplete or unsafe', () => {
    const decision = evaluateAgentEvalGate({
      catalogEntry: catalogEntry({ environment: 'integration', readonlyOnly: false }),
      suiteSource: { kind: 'workspace', relativePath: '.dbagent/evals/local.json' },
      runResult: runResult(summary({ failedCases: 1 }), { savedReport: false, postgres: false }),
      policy: {
        minTotalCases: 3,
        minPassRate: 1,
        maxFailedCases: 0,
        requireEnvironment: 'postgres',
        requireSourceKind: 'official',
        requirePostgres: true,
        requireSavedReport: true,
        requireReadonlyOnly: true,
        requiredToolNames: ['search_schema', 'query_database', 'explain_query'],
        forbiddenToolNames: ['execute_sql'],
      },
    });

    expect(decision.passed).toBe(false);
    expect(decision.failures).toEqual([
      'Expected at least 3 case(s), got 2.',
      'Expected pass rate >= 100.00%, got 50.00%.',
      'Expected failed cases <= 0, got 1.',
      'Expected environment postgres, got integration.',
      'Expected suite source official, got workspace.',
      'Expected report run to be marked as PostgreSQL-backed.',
      'Expected evaluation report to be saved.',
      'Expected all suite cases to run in readonly mode.',
      'Required observed tool is missing: explain_query.',
      'Forbidden observed tool was called: execute_sql.',
    ]);
    expect(decision.warnings).toEqual([
      'Failed case EVAL-002: Final text does not include: refund_rate.',
    ]);
  });
});

function summary(input: { failedCases: 0 | 1 }): AgentBehaviorEvaluationSummary {
  const secondPassed = input.failedCases === 0;
  return {
    totalCases: 2,
    passedCases: secondPassed ? 2 : 1,
    failedCases: secondPassed ? 0 : 1,
    passRate: secondPassed ? 1 : 0.5,
    results: [
      {
        id: 'EVAL-001',
        userTask: '分析 GMV',
        passed: true,
        failures: [],
        observedStatus: 'done',
        observedToolCalls: ['search_schema', 'query_database'],
        observedToolDetails: [],
        observedFinalText: 'paid_search GMV',
        observedIterations: 2,
      },
      {
        id: 'EVAL-002',
        userTask: '分析退款率',
        passed: secondPassed,
        failures: secondPassed ? [] : ['Final text does not include: refund_rate.'],
        observedStatus: 'done',
        observedToolCalls: secondPassed ? ['search_schema', 'query_database'] : ['execute_sql'],
        observedToolDetails: [],
        observedFinalText: secondPassed ? 'refund_rate' : 'done',
        observedIterations: 2,
      },
    ],
  };
}

function runResult(
  summaryInput: AgentBehaviorEvaluationSummary,
  options: { savedReport?: boolean; postgres?: boolean } = {},
): AgentEvalSuiteRunResult {
  return {
    summary: summaryInput,
    report: {
      reportId: 'report-1',
      suiteId: 'official.agent-rag-eval.postgres',
      suiteName: 'Agent RAG PostgreSQL Eval',
      generatedAt: '2026-07-08T00:00:00.000Z',
      environment: 'postgres',
      run: {
        providerId: 'fake',
        model: 'fake-model',
        postgres: options.postgres ?? true,
      },
      summary: {
        totalCases: summaryInput.totalCases,
        passedCases: summaryInput.passedCases,
        failedCases: summaryInput.failedCases,
        passRate: summaryInput.passRate,
      },
      files: [],
    },
    ...(options.savedReport === false
      ? {}
      : {
          savedReport: {
            reportId: 'report-1',
            suiteId: 'official.agent-rag-eval.postgres',
            suiteName: 'Agent RAG PostgreSQL Eval',
            generatedAt: '2026-07-08T00:00:00.000Z',
            environment: 'postgres',
            totalCases: summaryInput.totalCases,
            passedCases: summaryInput.passedCases,
            failedCases: summaryInput.failedCases,
            passRate: summaryInput.passRate,
            createdAt: '2026-07-08T00:00:00.000Z',
          },
        }),
    caseResults: [],
  };
}

function catalogEntry(
  overrides: Partial<AgentEvalSuiteCatalogServiceEntry> = {},
): AgentEvalSuiteCatalogServiceEntry {
  return {
    suiteId: 'official.agent-rag-eval.postgres',
    suiteName: 'Agent RAG PostgreSQL Eval',
    environment: 'postgres',
    source: { kind: 'official', pluginId: 'official.agent-rag-eval' },
    sourceLabel: 'official:official.agent-rag-eval',
    caseCount: 2,
    caseIds: ['EVAL-001', 'EVAL-002'],
    notes: [],
    declaredToolNames: ['search_schema', 'query_database'],
    requiredToolNames: ['search_schema', 'query_database'],
    allowedToolNames: ['search_schema', 'query_database'],
    runModes: ['readonly'],
    readonlyOnly: true,
    ...overrides,
  };
}
