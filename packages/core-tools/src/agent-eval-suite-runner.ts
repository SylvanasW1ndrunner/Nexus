import {
  AgentBehaviorEvaluationReportStore,
  buildAgentBehaviorEvaluationReport,
  evaluateAgentBehavior,
  type AgentBehaviorEvaluationCase,
  type AgentBehaviorEvaluationReport,
  type AgentBehaviorEvaluationReportSummary,
  type AgentBehaviorEvaluationSummary,
  type AgentRunOptions,
  type AgentRunResult,
} from '@dbagent/core-agent';

export type AgentEvalSuiteAgent = {
  run(options: AgentRunOptions): Promise<AgentRunResult>;
};

export type AgentEvalSuiteCase = {
  case: AgentBehaviorEvaluationCase;
  run?: Partial<Omit<AgentRunOptions, 'userMessage'>>;
};

export type AgentEvalSuite = {
  suiteId: string;
  suiteName: string;
  cases: AgentEvalSuiteCase[];
  environment?: 'unit' | 'integration' | 'postgres' | 'llm-live' | 'manual';
  notes?: string[];
};

export type AgentEvalSuiteRunOptions = {
  agent: AgentEvalSuiteAgent;
  suite: AgentEvalSuite;
  baseRun: Omit<AgentRunOptions, 'userMessage'>;
  reportId?: string;
  generatedAt?: string;
  reportStorePath?: string;
  stopOnFirstFailure?: boolean;
};

export type AgentEvalSuiteRunResult = {
  summary: AgentBehaviorEvaluationSummary;
  report: AgentBehaviorEvaluationReport;
  savedReport?: AgentBehaviorEvaluationReportSummary;
  caseResults: Array<{
    caseId: string;
    userTask: string;
    result: AgentRunResult;
  }>;
};

export async function runAgentBehaviorEvaluationSuite(
  options: AgentEvalSuiteRunOptions,
): Promise<AgentEvalSuiteRunResult> {
  if (options.suite.cases.length === 0) {
    throw new Error('Agent eval suite must contain at least one case.');
  }

  const caseResults: AgentEvalSuiteRunResult['caseResults'] = [];
  const evaluationInputs: Array<{ case: AgentBehaviorEvaluationCase; result: AgentRunResult }> = [];

  for (const suiteCase of options.suite.cases) {
    const runOptions = mergeRunOptions(options.baseRun, suiteCase.run, suiteCase.case.userTask);
    const result = await options.agent.run(runOptions);
    caseResults.push({
      caseId: suiteCase.case.id,
      userTask: suiteCase.case.userTask,
      result,
    });
    evaluationInputs.push({ case: suiteCase.case, result });

    if (options.stopOnFirstFailure) {
      const partial = evaluateAgentBehavior({ cases: [{ case: suiteCase.case, result }] });
      if (partial.failedCases > 0) break;
    }
  }

  const summary = evaluateAgentBehavior({ cases: evaluationInputs });
  const report = buildAgentBehaviorEvaluationReport({
    ...(options.reportId === undefined ? {} : { reportId: options.reportId }),
    suiteId: options.suite.suiteId,
    suiteName: options.suite.suiteName,
    summary,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    environment: options.suite.environment ?? 'manual',
    run: {
      providerId: options.baseRun.providerId,
      model: options.baseRun.model,
      live: options.suite.environment === 'llm-live',
      postgres: options.suite.environment === 'postgres',
    },
    ...(options.suite.notes === undefined ? {} : { notes: options.suite.notes }),
  });
  const savedReport =
    options.reportStorePath === undefined
      ? undefined
      : await new AgentBehaviorEvaluationReportStore(options.reportStorePath).save(report);

  return {
    summary,
    report,
    ...(savedReport === undefined ? {} : { savedReport }),
    caseResults,
  };
}

function mergeRunOptions(
  baseRun: Omit<AgentRunOptions, 'userMessage'>,
  override: Partial<Omit<AgentRunOptions, 'userMessage'>> | undefined,
  userMessage: string,
): AgentRunOptions {
  return {
    ...baseRun,
    ...override,
    userMessage,
  };
}
