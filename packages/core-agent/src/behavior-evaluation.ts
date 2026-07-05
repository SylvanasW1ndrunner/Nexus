import type {
  AgentBehaviorEvaluationCase,
  AgentBehaviorEvaluationReport,
  AgentBehaviorEvaluationReportFile,
  AgentBehaviorEvaluationReportInput,
  AgentBehaviorEvaluationResult,
  AgentBehaviorEvaluationSummary,
  AgentBehaviorToolExpectation,
  AgentRunResult,
} from './types.js';
import { redactPersistedAgentValue } from './redaction.js';

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

function evaluateCase(
  testCase: AgentBehaviorEvaluationCase,
  result: AgentRunResult,
): AgentBehaviorEvaluationResult {
  const failures: string[] = [];
  const observedToolCalls = result.toolExecutions.map((execution) => execution.toolName);
  const observedToolCallSet = new Set(observedToolCalls);
  const observedToolDetails = result.toolExecutions.map((execution) => ({
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    status: execution.status,
    ...(execution.argumentPreview === undefined ? {} : { argumentPreview: execution.argumentPreview }),
    resultPreview: execution.resultPreview,
  }));

  if (testCase.expectedStatus !== undefined && result.status !== testCase.expectedStatus) {
    failures.push(`Expected status ${testCase.expectedStatus}, got ${result.status}.`);
  }

  for (const toolName of testCase.requiredToolCalls ?? []) {
    if (!observedToolCallSet.has(toolName))
      failures.push(`Required tool was not called: ${toolName}.`);
  }

  for (const toolName of testCase.forbiddenToolCalls ?? []) {
    if (observedToolCallSet.has(toolName)) failures.push(`Forbidden tool was called: ${toolName}.`);
  }

  for (const expected of testCase.requiredToolStatuses ?? []) {
    const matched = result.toolExecutions.some(
      (execution) =>
        execution.toolName === expected.toolName && execution.status === expected.status,
    );
    if (!matched)
      failures.push(`Expected tool ${expected.toolName} to have status ${expected.status}.`);
  }

  for (const expectation of testCase.toolExpectations ?? []) {
    failures.push(...evaluateToolExpectation(expectation, result.toolExecutions));
  }

  for (const snippet of testCase.finalTextIncludes ?? []) {
    if (!result.finalText.includes(snippet))
      failures.push(`Final text does not include: ${snippet}.`);
  }

  for (const snippet of testCase.finalTextExcludes ?? []) {
    if (result.finalText.includes(snippet))
      failures.push(`Final text includes forbidden snippet: ${snippet}.`);
  }

  if (testCase.minIterations !== undefined && result.iterations < testCase.minIterations) {
    failures.push(
      `Expected at least ${testCase.minIterations} iterations, got ${result.iterations}.`,
    );
  }

  if (testCase.maxIterations !== undefined && result.iterations > testCase.maxIterations) {
    failures.push(
      `Expected at most ${testCase.maxIterations} iterations, got ${result.iterations}.`,
    );
  }

  return {
    id: testCase.id,
    userTask: testCase.userTask,
    passed: failures.length === 0,
    failures,
    observedStatus: result.status,
    observedToolCalls,
    observedToolDetails,
    observedFinalText: result.finalText,
    observedIterations: result.iterations,
  };
}

function evaluateToolExpectation(
  expectation: AgentBehaviorToolExpectation,
  executions: AgentRunResult['toolExecutions'],
): string[] {
  const failures: string[] = [];
  const matches = executions.filter((execution) => execution.toolName === expectation.toolName);

  if (expectation.minCalls !== undefined && matches.length < expectation.minCalls) {
    failures.push(
      `Expected tool ${expectation.toolName} to be called at least ${expectation.minCalls} times, got ${matches.length}.`,
    );
  }

  if (expectation.maxCalls !== undefined && matches.length > expectation.maxCalls) {
    failures.push(
      `Expected tool ${expectation.toolName} to be called at most ${expectation.maxCalls} times, got ${matches.length}.`,
    );
  }

  if (matches.length === 0) {
    failures.push(`Expected tool ${expectation.toolName} to be called for detailed checks.`);
    return failures;
  }

  if (expectation.status !== undefined && !matches.some((execution) => execution.status === expectation.status)) {
    failures.push(`Expected tool ${expectation.toolName} to have status ${expectation.status}.`);
  }

  const argumentsText = matches.map((execution) => execution.argumentPreview ?? '').join('\n');
  const resultsText = matches.map((execution) => execution.resultPreview).join('\n');
  const matchOptions = { caseSensitive: expectation.caseSensitive ?? true };
  failures.push(
    ...includesFailures(
      `Tool ${expectation.toolName} arguments`,
      argumentsText,
      expectation.argumentIncludes,
      matchOptions,
    ),
  );
  failures.push(
    ...excludesFailures(
      `Tool ${expectation.toolName} arguments`,
      argumentsText,
      expectation.argumentExcludes,
      matchOptions,
    ),
  );
  failures.push(
    ...includesFailures(
      `Tool ${expectation.toolName} result`,
      resultsText,
      expectation.resultIncludes,
      matchOptions,
    ),
  );
  failures.push(
    ...excludesFailures(
      `Tool ${expectation.toolName} result`,
      resultsText,
      expectation.resultExcludes,
      matchOptions,
    ),
  );

  return failures;
}

function includesFailures(
  label: string,
  text: string,
  snippets: string[] | undefined,
  options: { caseSensitive: boolean } = { caseSensitive: true },
): string[] {
  const haystack = searchableText(text, options);
  return (snippets ?? [])
    .filter((snippet) => !haystack.includes(searchableText(snippet, options)))
    .map((snippet) => `${label} does not include: ${snippet}.`);
}

function excludesFailures(
  label: string,
  text: string,
  snippets: string[] | undefined,
  options: { caseSensitive: boolean } = { caseSensitive: true },
): string[] {
  const haystack = searchableText(text, options);
  return (snippets ?? [])
    .filter((snippet) => haystack.includes(searchableText(snippet, options)))
    .map((snippet) => `${label} includes forbidden snippet: ${snippet}.`);
}

function searchableText(text: string, options: { caseSensitive: boolean }): string {
  return options.caseSensitive ? text : text.toLocaleLowerCase();
}

export function buildAgentBehaviorEvaluationReport(
  input: AgentBehaviorEvaluationReportInput,
): AgentBehaviorEvaluationReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const reportId = input.reportId ?? defaultReportId(input.suiteId, generatedAt);
  const redactedInput = redactReportInput({ ...input, reportId, generatedAt });
  const manifest = buildManifest(redactedInput, generatedAt);
  const results = {
    suiteId: redactedInput.suiteId,
    suiteName: redactedInput.suiteName,
    generatedAt,
    environment: redactedInput.environment ?? 'manual',
    ...(redactedInput.suiteSource === undefined ? {} : { suiteSource: redactedInput.suiteSource }),
    run: redactedInput.run ?? {},
    notes: redactedInput.notes ?? [],
    summary: publicSummary(redactedInput.summary),
    results: redactedInput.summary.results,
  };
  const markdown = buildMarkdownReport(redactedInput, generatedAt);

  return {
    reportId: redactedInput.reportId ?? reportId,
    suiteId: redactedInput.suiteId,
    suiteName: redactedInput.suiteName,
    generatedAt,
    environment: redactedInput.environment ?? 'manual',
    ...(redactedInput.suiteSource === undefined ? {} : { suiteSource: redactedInput.suiteSource }),
    run: redactedInput.run ?? {},
    summary: publicSummary(redactedInput.summary),
    files: [
      toReportFile('manifest.json', JSON.stringify(manifest, null, 2)),
      toReportFile('results.json', JSON.stringify(results, null, 2)),
      toReportFile('report.md', markdown),
    ],
  };
}

function redactReportInput(
  input: AgentBehaviorEvaluationReportInput,
): AgentBehaviorEvaluationReportInput {
  return redactPersistedAgentValue(input) as AgentBehaviorEvaluationReportInput;
}

function buildManifest(
  input: AgentBehaviorEvaluationReportInput,
  generatedAt: string,
): Record<string, unknown> {
  return {
    generatedAt,
    suiteId: input.suiteId,
    suiteName: input.suiteName,
    environment: input.environment ?? 'manual',
    ...(input.suiteSource === undefined ? {} : { suiteSource: input.suiteSource }),
    run: input.run ?? {},
    notes: input.notes ?? [],
    summary: publicSummary(input.summary),
    files: ['manifest.json', 'results.json', 'report.md'],
  };
}

function buildMarkdownReport(
  input: AgentBehaviorEvaluationReportInput,
  generatedAt: string,
): string {
  const summary = publicSummary(input.summary);
  const lines = [
    `# ${input.suiteName}`,
    '',
    `- Suite: ${input.suiteId}`,
    `- Generated At: ${generatedAt}`,
    `- Environment: ${input.environment ?? 'manual'}`,
    `- Suite Source: ${formatSuiteSource(input.suiteSource)}`,
    `- Provider: ${input.run?.providerId ?? 'n/a'}`,
    `- Model: ${input.run?.model ?? 'n/a'}`,
    `- Live LLM: ${input.run?.live === true ? 'yes' : 'no'}`,
    `- PostgreSQL: ${input.run?.postgres === true ? 'yes' : 'no'}`,
    '',
    '## Summary',
    '',
    `- Total Cases: ${summary.totalCases}`,
    `- Passed Cases: ${summary.passedCases}`,
    `- Failed Cases: ${summary.failedCases}`,
    `- Pass Rate: ${(summary.passRate * 100).toFixed(2)}%`,
    '',
    '## Cases',
    '',
  ];

  for (const result of input.summary.results) {
    lines.push(`### ${result.id}`);
    lines.push('');
    lines.push(`- Status: ${result.passed ? 'passed' : 'failed'}`);
    lines.push(`- User Task: ${result.userTask}`);
    lines.push(`- Observed Status: ${result.observedStatus}`);
    lines.push(
      `- Observed Tool Calls: ${result.observedToolCalls.length > 0 ? result.observedToolCalls.join(', ') : 'none'}`,
    );
    if (result.observedToolDetails.length > 0) {
      lines.push(
        `- Tool Details: ${result.observedToolDetails.map(formatObservedToolDetail).join(' | ')}`,
      );
    }
    lines.push(`- Iterations: ${result.observedIterations}`);
    if (result.failures.length > 0) {
      lines.push(`- Failures: ${result.failures.join(' | ')}`);
    }
    lines.push(`- Final Text: ${singleLine(result.observedFinalText)}`);
    lines.push('');
  }

  if (input.notes && input.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of input.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function publicSummary(
  summary: AgentBehaviorEvaluationSummary,
): AgentBehaviorEvaluationReport['summary'] {
  return {
    totalCases: summary.totalCases,
    passedCases: summary.passedCases,
    failedCases: summary.failedCases,
    passRate: summary.passRate,
  };
}

function toReportFile(path: string, content: string): AgentBehaviorEvaluationReportFile {
  return {
    path,
    content,
    bytes: new TextEncoder().encode(content).byteLength,
  };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatObservedToolDetail(
  tool: AgentBehaviorEvaluationResult['observedToolDetails'][number],
): string {
  return singleLine(
    `${tool.toolName}:${tool.status}:${tool.argumentPreview ?? ''}:${tool.resultPreview}`,
  );
}

function formatSuiteSource(source: AgentBehaviorEvaluationReportInput['suiteSource']): string {
  if (source === undefined) return 'manual';
  if (source.kind === 'official') return `official:${source.pluginId ?? 'unknown'}`;
  if (source.kind === 'workspace') return `workspace:${source.relativePath ?? 'unknown'}`;
  return source.kind;
}

function defaultReportId(suiteId: string, generatedAt: string): string {
  return `${sanitizeId(suiteId)}-${generatedAt.replace(/[:.]/g, '-')}`;
}

function sanitizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'agent-evaluation'
  );
}
