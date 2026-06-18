import type {
  AgentBehaviorEvaluationCase,
  AgentBehaviorEvaluationResult,
  AgentBehaviorEvaluationSummary,
  AgentRunResult,
} from './types.js';

export function evaluateAgentBehavior(input: {
  cases: Array<{
    case: AgentBehaviorEvaluationCase;
    result: AgentRunResult;
  }>;
}): AgentBehaviorEvaluationSummary {
  const results = input.cases.map(({ case: testCase, result }) => evaluateCase(testCase, result));
  const passedCases = results.filter((result) => result.passed).length;
  return {
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    passRate: results.length === 0 ? 1 : passedCases / results.length,
    results,
  };
}

function evaluateCase(testCase: AgentBehaviorEvaluationCase, result: AgentRunResult): AgentBehaviorEvaluationResult {
  const failures: string[] = [];
  const observedToolCalls = result.toolExecutions.map((execution) => execution.toolName);
  const observedToolCallSet = new Set(observedToolCalls);

  if (testCase.expectedStatus !== undefined && result.status !== testCase.expectedStatus) {
    failures.push(`Expected status ${testCase.expectedStatus}, got ${result.status}.`);
  }

  for (const toolName of testCase.requiredToolCalls ?? []) {
    if (!observedToolCallSet.has(toolName)) failures.push(`Required tool was not called: ${toolName}.`);
  }

  for (const toolName of testCase.forbiddenToolCalls ?? []) {
    if (observedToolCallSet.has(toolName)) failures.push(`Forbidden tool was called: ${toolName}.`);
  }

  for (const expected of testCase.requiredToolStatuses ?? []) {
    const matched = result.toolExecutions.some(
      (execution) => execution.toolName === expected.toolName && execution.status === expected.status,
    );
    if (!matched) failures.push(`Expected tool ${expected.toolName} to have status ${expected.status}.`);
  }

  for (const snippet of testCase.finalTextIncludes ?? []) {
    if (!result.finalText.includes(snippet)) failures.push(`Final text does not include: ${snippet}.`);
  }

  if (testCase.minIterations !== undefined && result.iterations < testCase.minIterations) {
    failures.push(`Expected at least ${testCase.minIterations} iterations, got ${result.iterations}.`);
  }

  if (testCase.maxIterations !== undefined && result.iterations > testCase.maxIterations) {
    failures.push(`Expected at most ${testCase.maxIterations} iterations, got ${result.iterations}.`);
  }

  return {
    id: testCase.id,
    userTask: testCase.userTask,
    passed: failures.length === 0,
    failures,
    observedStatus: result.status,
    observedToolCalls,
    observedFinalText: result.finalText,
    observedIterations: result.iterations,
  };
}
