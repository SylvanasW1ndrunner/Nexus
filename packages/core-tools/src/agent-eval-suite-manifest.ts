import type {
  AgentBehaviorEvaluationCase,
  AgentBehaviorToolExpectation,
  AgentMode,
  AgentRunOptions,
  AgentRunStatus,
  AgentToolExecutionRecord,
} from '@dbagent/core-agent';
import type { UsageMode } from '@dbagent/shared';
import type { AgentEvalSuite, AgentEvalSuiteCase } from './agent-eval-suite-runner.js';

export type AgentEvalSuiteManifest = {
  version: 1;
  suite: {
    suiteId: string;
    suiteName: string;
    cases: AgentEvalSuiteManifestCase[];
    environment?: AgentEvalSuite['environment'];
    notes?: string[];
  };
};

export type AgentEvalSuiteManifestCase = AgentBehaviorEvaluationCase & {
  run?: SafeManifestRunOverride;
};

type UnknownManifestCase = {
  id?: unknown;
  userTask?: unknown;
  expectedStatus?: unknown;
  requiredToolCalls?: unknown;
  forbiddenToolCalls?: unknown;
  requiredToolStatuses?: unknown;
  toolExpectations?: unknown;
  finalTextIncludes?: unknown;
  finalTextExcludes?: unknown;
  minIterations?: unknown;
  maxIterations?: unknown;
  run?: unknown;
};

type ManifestToolExpectation = {
  toolName?: unknown;
  status?: unknown;
  minCalls?: unknown;
  maxCalls?: unknown;
  caseSensitive?: unknown;
  argumentIncludes?: unknown;
  argumentExcludes?: unknown;
  resultIncludes?: unknown;
  resultExcludes?: unknown;
};

export type SafeManifestRunOverride = Partial<
  Pick<
    AgentRunOptions,
    | 'allowedTools'
    | 'usageMode'
    | 'mode'
    | 'maxIterations'
    | 'keepRecentMessages'
    | 'maxToolResultChars'
    | 'maxConsecutiveToolFailures'
    | 'maxToolExecutionMs'
  >
>;

const EVALUATION_ENVIRONMENTS = new Set([
  'unit',
  'integration',
  'postgres',
  'llm-live',
  'manual',
] satisfies NonNullable<AgentEvalSuite['environment']>[]);

const RUN_STATUSES = new Set([
  'done',
  'aborted',
  'max_iterations_reached',
  'permission_denied',
  'tool_failed',
] satisfies AgentRunStatus[]);

const TOOL_STATUSES = new Set([
  'success',
  'denied',
  'failed',
] satisfies AgentToolExecutionRecord['status'][]);

const AGENT_MODES = new Set([
  'read',
  'edit',
  'full',
  'ask',
  'auto',
  'full-auto',
  'readonly',
] satisfies AgentMode[]);

const USAGE_MODES = new Set(['byok', 'managed'] satisfies UsageMode[]);

const FORBIDDEN_RUN_KEYS = new Set(['providerId', 'model', 'userMessage', 'signal']);

export function parseAgentEvalSuiteManifestJson(json: string): AgentEvalSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Agent eval suite manifest JSON is invalid: ${errorMessage(error)}`);
  }
  return parseAgentEvalSuiteManifest(parsed);
}

export function parseAgentEvalSuiteManifest(input: unknown): AgentEvalSuite {
  const root = objectRecord(input, 'Agent eval suite manifest');
  const version = requiredNumber(root, 'version', 'Agent eval suite manifest');
  if (version !== 1) {
    throw new Error(`Agent eval suite manifest version is not supported: ${version}.`);
  }

  const suiteInput = objectRecord(root.suite, 'Agent eval suite manifest suite');
  const suiteId = requiredNonEmptyString(suiteInput, 'suiteId', 'Agent eval suite manifest suite');
  const suiteName = requiredNonEmptyString(suiteInput, 'suiteName', 'Agent eval suite manifest suite');
  const casesInput = requiredArray(suiteInput, 'cases', 'Agent eval suite manifest suite');
  if (casesInput.length === 0) {
    throw new Error('Agent eval suite manifest suite must contain at least one case.');
  }

  const environment = optionalEnum(
    suiteInput,
    'environment',
    EVALUATION_ENVIRONMENTS,
    'Agent eval suite manifest suite',
  );
  const notes = optionalStringArray(suiteInput, 'notes', 'Agent eval suite manifest suite');

  const cases = casesInput.map((item, index) => parseCase(item, index));
  assertUnique(cases.map((item) => item.case.id), 'Agent eval suite case id');

  return {
    suiteId,
    suiteName,
    cases,
    ...(environment === undefined ? {} : { environment }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function parseCase(input: unknown, index: number): AgentEvalSuiteCase {
  const label = `Agent eval suite case at index ${index}`;
  const record = objectRecord(input, label) as UnknownManifestCase;
  const id = requiredNonEmptyString(record, 'id', label);
  const userTask = requiredNonEmptyString(record, 'userTask', label);
  const expectedStatus = optionalEnum(record, 'expectedStatus', RUN_STATUSES, label);
  const requiredToolCalls = optionalStringArray(record, 'requiredToolCalls', label);
  const forbiddenToolCalls = optionalStringArray(record, 'forbiddenToolCalls', label);
  const requiredToolStatuses = optionalRequiredToolStatuses(record, label);
  const toolExpectations = optionalToolExpectations(record, label);
  const finalTextIncludes = optionalStringArray(record, 'finalTextIncludes', label);
  const finalTextExcludes = optionalStringArray(record, 'finalTextExcludes', label);
  const minIterations = optionalNonNegativeInteger(record, 'minIterations', label);
  const maxIterations = optionalNonNegativeInteger(record, 'maxIterations', label);

  if (minIterations !== undefined && maxIterations !== undefined && minIterations > maxIterations) {
    throw new Error(`${label} minIterations cannot be greater than maxIterations.`);
  }

  const evaluationCase: AgentBehaviorEvaluationCase = {
    id,
    userTask,
    ...(expectedStatus === undefined ? {} : { expectedStatus }),
    ...(requiredToolCalls === undefined ? {} : { requiredToolCalls }),
    ...(forbiddenToolCalls === undefined ? {} : { forbiddenToolCalls }),
    ...(requiredToolStatuses === undefined ? {} : { requiredToolStatuses }),
    ...(toolExpectations === undefined ? {} : { toolExpectations }),
    ...(finalTextIncludes === undefined ? {} : { finalTextIncludes }),
    ...(finalTextExcludes === undefined ? {} : { finalTextExcludes }),
    ...(minIterations === undefined ? {} : { minIterations }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
  };
  const run = optionalRunOverride(record, label);
  return {
    case: evaluationCase,
    ...(run === undefined ? {} : { run }),
  };
}

function optionalRequiredToolStatuses(
  record: Record<string, unknown>,
  label: string,
): AgentBehaviorEvaluationCase['requiredToolStatuses'] | undefined {
  if (record.requiredToolStatuses === undefined) return undefined;
  const items = arrayValue(record.requiredToolStatuses, `${label} requiredToolStatuses`);
  return items.map((item, index) => {
    const statusLabel = `${label} requiredToolStatuses[${index}]`;
    const statusRecord = objectRecord(item, statusLabel);
    return {
      toolName: requiredNonEmptyString(statusRecord, 'toolName', statusLabel),
      status: requiredEnum(statusRecord, 'status', TOOL_STATUSES, statusLabel),
    };
  });
}

function optionalToolExpectations(
  record: Record<string, unknown>,
  label: string,
): AgentBehaviorToolExpectation[] | undefined {
  if (record.toolExpectations === undefined) return undefined;
  const items = arrayValue(record.toolExpectations, `${label} toolExpectations`);
  return items.map((item, index) => {
    const expectationLabel = `${label} toolExpectations[${index}]`;
    const expectation = objectRecord(item, expectationLabel) as ManifestToolExpectation;
    const status = optionalEnum(expectation, 'status', TOOL_STATUSES, expectationLabel);
    const minCalls = optionalNonNegativeInteger(expectation, 'minCalls', expectationLabel);
    const maxCalls = optionalNonNegativeInteger(expectation, 'maxCalls', expectationLabel);
    const argumentIncludes = optionalStringArray(expectation, 'argumentIncludes', expectationLabel);
    const argumentExcludes = optionalStringArray(expectation, 'argumentExcludes', expectationLabel);
    const resultIncludes = optionalStringArray(expectation, 'resultIncludes', expectationLabel);
    const resultExcludes = optionalStringArray(expectation, 'resultExcludes', expectationLabel);
    if (minCalls !== undefined && maxCalls !== undefined && minCalls > maxCalls) {
      throw new Error(`${expectationLabel} minCalls cannot be greater than maxCalls.`);
    }

    return {
      toolName: requiredNonEmptyString(expectation, 'toolName', expectationLabel),
      ...(status === undefined ? {} : { status }),
      ...(minCalls === undefined ? {} : { minCalls }),
      ...(maxCalls === undefined ? {} : { maxCalls }),
      ...(expectation.caseSensitive === undefined
        ? {}
        : { caseSensitive: booleanValue(expectation.caseSensitive, `${expectationLabel} caseSensitive`) }),
      ...(argumentIncludes === undefined ? {} : { argumentIncludes }),
      ...(argumentExcludes === undefined ? {} : { argumentExcludes }),
      ...(resultIncludes === undefined ? {} : { resultIncludes }),
      ...(resultExcludes === undefined ? {} : { resultExcludes }),
    };
  });
}

function optionalRunOverride(
  record: Record<string, unknown>,
  label: string,
): SafeManifestRunOverride | undefined {
  if (record.run === undefined) return undefined;
  const run = objectRecord(record.run, `${label} run`);
  for (const key of Object.keys(run)) {
    if (FORBIDDEN_RUN_KEYS.has(key)) {
      throw new Error(
        `${label} run cannot override ${key}; provider, model and userMessage are controlled by the caller.`,
      );
    }
  }
  const allowedTools = optionalStringArray(run, 'allowedTools', `${label} run`);
  const usageMode = optionalEnum(run, 'usageMode', USAGE_MODES, `${label} run`);
  const mode = optionalEnum(run, 'mode', AGENT_MODES, `${label} run`);
  const maxIterations = optionalPositiveInteger(run, 'maxIterations', `${label} run`);
  const keepRecentMessages = optionalPositiveInteger(run, 'keepRecentMessages', `${label} run`);
  const maxToolResultChars = optionalPositiveInteger(run, 'maxToolResultChars', `${label} run`);
  const maxConsecutiveToolFailures = optionalPositiveInteger(
    run,
    'maxConsecutiveToolFailures',
    `${label} run`,
  );
  const maxToolExecutionMs = optionalPositiveInteger(run, 'maxToolExecutionMs', `${label} run`);

  return {
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(usageMode === undefined ? {} : { usageMode }),
    ...(mode === undefined ? {} : { mode }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(keepRecentMessages === undefined ? {} : { keepRecentMessages }),
    ...(maxToolResultChars === undefined ? {} : { maxToolResultChars }),
    ...(maxConsecutiveToolFailures === undefined ? {} : { maxConsecutiveToolFailures }),
    ...(maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs }),
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  if (record[key] === undefined) throw new Error(`${label} ${key} is required.`);
  return arrayValue(record[key], `${label} ${key}`);
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredNonEmptyString(record: Record<string, unknown>, key: string, label: string): string {
  if (record[key] === undefined) throw new Error(`${label} ${key} is required.`);
  const value = stringValue(record[key], `${label} ${key}`);
  if (!value.trim()) throw new Error(`${label} ${key} cannot be empty.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, label: string): number {
  if (record[key] === undefined) throw new Error(`${label} ${key} is required.`);
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} ${key} must be a finite number.`);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] | undefined {
  if (record[key] === undefined) return undefined;
  return arrayValue(record[key], `${label} ${key}`).map((item, index) =>
    stringValue(item, `${label} ${key}[${index}]`),
  );
}

function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (record[key] === undefined) throw new Error(`${label} ${key} is required.`);
  const value = stringValue(record[key], `${label} ${key}`);
  if (!values.has(value as T)) throw new Error(`${label} ${key} is not supported: ${value}.`);
  return value as T;
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: ReadonlySet<T>,
  label: string,
): T | undefined {
  if (record[key] === undefined) return undefined;
  return requiredEnum(record, key, values, label);
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  return optionalInteger(record, key, label, 0);
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  return optionalInteger(record, key, label, 1);
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
): number | undefined {
  if (record[key] === undefined) return undefined;
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${label} ${key} must be an integer greater than or equal to ${min}.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
