import type { AgentMode, AuditProjectionEvent } from '@dbagent/core-agent';

/**
 * Internal evaluation port. A host adapts its Run Handle and Audit projection
 * to this shape; evaluation never becomes another Agent execution path.
 */
export type AgentEvalRunResult = Readonly<{
  runId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted';
  finalText: string;
  evidenceRefs: readonly string[];
}>;

export type AgentEvalRunConfiguration = Readonly<{
  mode?: AgentMode;
  allowedTools?: readonly string[];
  maxTurns?: number;
}>;

export type AgentEvalCaseExecution = Readonly<{
  result: AgentEvalRunResult;
  audit: readonly AuditProjectionEvent[];
}>;

export type AgentEvalSuiteAgent = Readonly<{
  run(input: Readonly<{
    caseId: string;
    userTask: string;
    configuration: AgentEvalRunConfiguration;
  }>): Promise<AgentEvalCaseExecution>;
}>;

export type AgentEvalToolStatus =
  | 'success'
  | 'denied'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export type AgentEvalToolExpectation = Readonly<{
  toolName: string;
  status?: AgentEvalToolStatus;
  minCalls?: number;
  maxCalls?: number;
  caseSensitive?: boolean;
  argumentIncludes?: readonly string[];
  argumentExcludes?: readonly string[];
  resultIncludes?: readonly string[];
  resultExcludes?: readonly string[];
}>;

export type AgentEvalSuiteExpectation = Readonly<{
  id: string;
  userTask: string;
  expectedStatus?: AgentEvalRunResult['status'];
  requiredToolCalls?: readonly string[];
  forbiddenToolCalls?: readonly string[];
  requiredToolStatuses?: readonly Readonly<{
    toolName: string;
    status: AgentEvalToolStatus;
  }>[];
  toolExpectations?: readonly AgentEvalToolExpectation[];
  finalTextIncludes?: readonly string[];
  finalTextExcludes?: readonly string[];
  minTurns?: number;
  maxTurns?: number;
}>;

export type AgentEvalSuiteCase = Readonly<{
  expectation: AgentEvalSuiteExpectation;
  configuration?: AgentEvalRunConfiguration;
}>;

export type AgentEvalEnvironment = 'unit' | 'integration' | 'postgres' | 'llm-live' | 'manual';

export type AgentEvalSuite = Readonly<{
  suiteId: string;
  suiteName: string;
  cases: readonly AgentEvalSuiteCase[];
  environment?: AgentEvalEnvironment;
  notes?: readonly string[];
}>;

export type AgentEvalObservedTool = Readonly<{
  invocationId: string;
  toolName: string;
  status: AgentEvalToolStatus | 'proposed';
  arguments: string;
  summary: string;
  evidenceRefs: readonly string[];
}>;

export type AgentEvalCaseResult = Readonly<{
  caseId: string;
  userTask: string;
  execution: AgentEvalCaseExecution;
  passed: boolean;
  failures: readonly string[];
  observed: Readonly<{
    turnCount: number;
    tools: readonly AgentEvalObservedTool[];
  }>;
}>;

export type AgentEvalSuiteSummary = Readonly<{
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
}>;

/** A portable, internal acceptance report derived only from result + audit facts. */
export type AgentEvalSuiteReport = Readonly<{
  schemaVersion: 1;
  suiteId: string;
  suiteName: string;
  generatedAt: string;
  environment: AgentEvalEnvironment;
  notes: readonly string[];
  summary: AgentEvalSuiteSummary;
  cases: readonly AgentEvalCaseResult[];
}>;

export type AgentEvalSuiteRunOptions = Readonly<{
  agent: AgentEvalSuiteAgent;
  suite: AgentEvalSuite;
  baseConfiguration?: AgentEvalRunConfiguration;
  generatedAt?: string;
  stopOnFirstFailure?: boolean;
}>;

export type AgentEvalSuiteRunResult = Readonly<{
  summary: AgentEvalSuiteSummary;
  report: AgentEvalSuiteReport;
  caseResults: readonly AgentEvalCaseResult[];
}>;

export async function runAgentEvaluationSuite(
  options: AgentEvalSuiteRunOptions,
): Promise<AgentEvalSuiteRunResult> {
  if (options.suite.cases.length === 0) {
    throw new Error('Agent eval suite must contain at least one case.');
  }

  const caseResults: AgentEvalCaseResult[] = [];
  for (const suiteCase of options.suite.cases) {
    const expectation = suiteCase.expectation;
    const execution = await options.agent.run({
      caseId: expectation.id,
      userTask: expectation.userTask,
      configuration: mergeConfiguration(options.baseConfiguration, suiteCase.configuration),
    });
    const result = evaluateCase(expectation, execution);
    caseResults.push(result);
    if (options.stopOnFirstFailure && !result.passed) break;
  }

  const summary = summarize(caseResults);
  const report: AgentEvalSuiteReport = Object.freeze({
    schemaVersion: 1,
    suiteId: options.suite.suiteId,
    suiteName: options.suite.suiteName,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    environment: options.suite.environment ?? 'manual',
    notes: Object.freeze([...(options.suite.notes ?? [])]),
    summary,
    cases: Object.freeze([...caseResults]),
  });
  return Object.freeze({ summary, report, caseResults: Object.freeze([...caseResults]) });
}

function evaluateCase(
  expectation: AgentEvalSuiteExpectation,
  execution: AgentEvalCaseExecution,
): AgentEvalCaseResult {
  validateExecution(execution);
  const tools = observedTools(execution.audit);
  const turnCount = execution.audit.filter((event) => event.type === 'turn.started').length;
  const failures: string[] = [];
  const result = execution.result;

  if (expectation.expectedStatus !== undefined && result.status !== expectation.expectedStatus) {
    failures.push(`Expected Run status ${expectation.expectedStatus}, received ${result.status}.`);
  }
  requireTextFragments(failures, result.finalText, expectation.finalTextIncludes, true, 'final text');
  requireTextFragments(failures, result.finalText, expectation.finalTextExcludes, false, 'final text');
  requireTurnRange(failures, turnCount, expectation.minTurns, expectation.maxTurns);

  for (const name of expectation.requiredToolCalls ?? []) {
    if (!tools.some((tool) => tool.toolName === name)) {
      failures.push(`Required Tool ${name} was not proposed.`);
    }
  }
  for (const name of expectation.forbiddenToolCalls ?? []) {
    if (tools.some((tool) => tool.toolName === name)) {
      failures.push(`Forbidden Tool ${name} was proposed.`);
    }
  }
  for (const expected of expectation.requiredToolStatuses ?? []) {
    if (!tools.some((tool) => tool.toolName === expected.toolName && tool.status === expected.status)) {
      failures.push(`Tool ${expected.toolName} did not reach status ${expected.status}.`);
    }
  }
  for (const expected of expectation.toolExpectations ?? []) {
    evaluateToolExpectation(failures, tools, expected);
  }

  return Object.freeze({
    caseId: expectation.id,
    userTask: expectation.userTask,
    execution: deepFreeze(structuredClone(execution)),
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    observed: Object.freeze({ turnCount, tools: Object.freeze(tools) }),
  });
}

function validateExecution(execution: AgentEvalCaseExecution): void {
  if (!execution.result.runId.trim() || !execution.result.sessionId.trim()) {
    throw new Error('Agent eval execution result must identify its Run and Session.');
  }
  let previousSequence = 0;
  let sawTerminal = false;
  let completedEvidenceRefs: string[] | undefined;
  for (const event of execution.audit) {
    if (event.runId !== execution.result.runId || event.sessionId !== execution.result.sessionId) {
      throw new Error('Agent eval audit crossed the evaluated Run or Session boundary.');
    }
    if (!Number.isSafeInteger(event.sourceSequence) || event.sourceSequence <= previousSequence) {
      throw new Error('Agent eval audit source sequences must be strictly increasing.');
    }
    previousSequence = event.sourceSequence;
    sawTerminal ||= terminalEventMatchesResult(event.type, execution.result.status);
    if (event.type === 'run.completed') {
      completedEvidenceRefs = stringArray(record(event.payload).evidenceRefs);
    }
  }
  if (!sawTerminal) {
    throw new Error('Agent eval audit does not contain the exact terminal Run fact.');
  }
  if (
    completedEvidenceRefs !== undefined &&
    !sameStringSequence(completedEvidenceRefs, execution.result.evidenceRefs)
  ) {
    throw new Error('Agent eval result evidence does not match the committed Run completion fact.');
  }
}

function terminalEventMatchesResult(
  type: AuditProjectionEvent['type'],
  status: AgentEvalRunResult['status'],
): boolean {
  switch (status) {
    case 'completed': return type === 'run.completed';
    case 'failed': return type === 'run.failed';
    case 'cancelled': return type === 'run.cancelled';
    case 'limit_reached': return type === 'run.limit_reached';
    case 'interrupted': return type === 'run.interrupted';
  }
}

function observedTools(events: readonly AuditProjectionEvent[]): AgentEvalObservedTool[] {
  const tools = new Map<string, AgentEvalObservedTool>();
  for (const event of events) {
    if (event.type === 'tool.proposed') {
      const payload = record(event.payload);
      const invocationId = stringValue(payload.invocationId) ?? event.invocationId;
      const toolName = stringValue(payload.name);
      if (invocationId === undefined || toolName === undefined) continue;
      tools.set(invocationId, {
        invocationId,
        toolName,
        status: 'proposed',
        arguments: portableText(payload.arguments),
        summary: '',
        evidenceRefs: Object.freeze([]),
      });
      continue;
    }
    const status = terminalToolStatus(event.type, event.payload);
    if (status === undefined) continue;
    const invocationId = event.invocationId ?? stringValue(record(event.payload).invocationId);
    if (invocationId === undefined) continue;
    const prior = tools.get(invocationId);
    if (prior === undefined) continue;
    const payload = record(event.payload);
    tools.set(invocationId, {
      ...prior,
      status,
      summary: stringValue(payload.summary) ?? '',
      evidenceRefs: Object.freeze(stringArray(payload.resultRefs)),
    });
  }
  return [...tools.values()];
}

function terminalToolStatus(
  type: AuditProjectionEvent['type'],
  payload: unknown,
): AgentEvalToolStatus | undefined {
  switch (type) {
    case 'tool.succeeded': return 'success';
    case 'tool.denied': return 'denied';
    case 'tool.failed': return 'failed';
    case 'tool.cancelled': return 'cancelled';
    case 'tool.unknown': return 'outcome_unknown';
    case 'tool.outcome_resolved': return record(payload).outcome === 'succeeded' ? 'success' : 'failed';
    default: return undefined;
  }
}

function evaluateToolExpectation(
  failures: string[],
  tools: readonly AgentEvalObservedTool[],
  expected: AgentEvalToolExpectation,
): void {
  const matched = tools.filter((tool) => tool.toolName === expected.toolName);
  if (expected.minCalls !== undefined && matched.length < expected.minCalls) {
    failures.push(`Tool ${expected.toolName} was called ${matched.length} times; expected at least ${expected.minCalls}.`);
  }
  if (expected.maxCalls !== undefined && matched.length > expected.maxCalls) {
    failures.push(`Tool ${expected.toolName} was called ${matched.length} times; expected at most ${expected.maxCalls}.`);
  }
  const candidates = expected.status === undefined
    ? matched
    : matched.filter((tool) => tool.status === expected.status);
  if (expected.status !== undefined && candidates.length === 0) {
    failures.push(`Tool ${expected.toolName} did not reach status ${expected.status}.`);
    return;
  }
  const argumentsText = candidates.map((tool) => tool.arguments).join('\n');
  const resultsText = candidates.map((tool) => tool.summary).join('\n');
  requireTextFragments(
    failures, argumentsText, expected.argumentIncludes, true, `Tool ${expected.toolName} arguments`,
    expected.caseSensitive,
  );
  requireTextFragments(
    failures, resultsText, expected.resultIncludes, true, `Tool ${expected.toolName} result`,
    expected.caseSensitive,
  );
  requireTextFragments(
    failures, argumentsText, expected.argumentExcludes, false, `Tool ${expected.toolName} arguments`,
    expected.caseSensitive,
  );
  requireTextFragments(
    failures, resultsText, expected.resultExcludes, false, `Tool ${expected.toolName} result`,
    expected.caseSensitive,
  );
}

function requireTextFragments(
  failures: string[],
  source: string,
  fragments: readonly string[] | undefined,
  required: boolean,
  label: string,
  caseSensitive = true,
): void {
  for (const fragment of fragments ?? []) {
    const present = (caseSensitive ? source : source.toLocaleLowerCase())
      .includes(caseSensitive ? fragment : fragment.toLocaleLowerCase());
    if (required && !present) failures.push(`Expected ${label} to include ${JSON.stringify(fragment)}.`);
    if (!required && present) failures.push(`Expected ${label} not to include ${JSON.stringify(fragment)}.`);
  }
}

function requireTurnRange(
  failures: string[],
  turns: number,
  min: number | undefined,
  max: number | undefined,
): void {
  if (min !== undefined && turns < min) failures.push(`Observed ${turns} Turns; expected at least ${min}.`);
  if (max !== undefined && turns > max) failures.push(`Observed ${turns} Turns; expected at most ${max}.`);
}

function mergeConfiguration(
  base: AgentEvalRunConfiguration | undefined,
  override: AgentEvalRunConfiguration | undefined,
): AgentEvalRunConfiguration {
  return deepFreeze({ ...base, ...override });
}

function summarize(cases: readonly AgentEvalCaseResult[]): AgentEvalSuiteSummary {
  const passedCases = cases.filter((item) => item.passed).length;
  return Object.freeze({
    totalCases: cases.length,
    passedCases,
    failedCases: cases.length - passedCases,
    passRate: cases.length === 0 ? 0 : passedCases / cases.length,
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function portableText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
