import type {
  AgentEvalEnvironment,
  AgentEvalRunConfiguration,
  AgentEvalRunResult,
  AgentEvalSuite,
  AgentEvalSuiteCase,
  AgentEvalSuiteExpectation,
  AgentEvalToolExpectation,
  AgentEvalToolStatus,
} from './agent-eval-suite-runner.js';

export type AgentEvalSuiteManifest = Readonly<{
  version: 1;
  suite: Readonly<{
    suiteId: string;
    suiteName: string;
    cases: readonly AgentEvalSuiteManifestCase[];
    environment?: AgentEvalEnvironment;
    notes?: readonly string[];
  }>;
}>;

export type AgentEvalSuiteManifestCase = AgentEvalSuiteExpectation & {
  configuration?: AgentEvalRunConfiguration;
};

type UnknownManifestCase = Record<string, unknown>;
type UnknownToolExpectation = Record<string, unknown>;

const EVALUATION_ENVIRONMENTS = new Set<AgentEvalEnvironment>([
  'unit', 'integration', 'postgres', 'llm-live', 'manual',
]);
const RUN_STATUSES = new Set<AgentEvalRunResult['status']>([
  'completed', 'failed', 'cancelled', 'limit_reached', 'interrupted',
]);
const TOOL_STATUSES = new Set<AgentEvalToolStatus>([
  'success', 'denied', 'failed', 'cancelled', 'outcome_unknown',
]);
const AGENT_MODES = new Set<NonNullable<AgentEvalRunConfiguration['mode']>>([
  'default', 'auto', 'full-access',
]);
const CASE_KEYS = new Set([
  'id', 'userTask', 'expectedStatus', 'requiredToolCalls', 'forbiddenToolCalls',
  'requiredToolStatuses', 'toolExpectations', 'finalTextIncludes', 'finalTextExcludes',
  'minTurns', 'maxTurns', 'configuration',
]);
const CONFIGURATION_KEYS = new Set(['mode', 'allowedTools', 'maxTurns']);

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
  requireOnlyKeys(root, new Set(['version', 'suite']), 'Agent eval suite manifest');
  if (requiredNumber(root, 'version', 'Agent eval suite manifest') !== 1) {
    throw new Error(`Agent eval suite manifest version is not supported: ${String(root.version)}.`);
  }
  const suiteInput = objectRecord(root.suite, 'Agent eval suite manifest suite');
  requireOnlyKeys(
    suiteInput,
    new Set(['suiteId', 'suiteName', 'cases', 'environment', 'notes']),
    'Agent eval suite manifest suite',
  );
  const casesInput = requiredArray(suiteInput, 'cases', 'Agent eval suite manifest suite');
  if (casesInput.length === 0) {
    throw new Error('Agent eval suite manifest suite must contain at least one case.');
  }
  const cases = casesInput.map((item, index) => parseCase(item, index));
  assertUnique(cases.map((item) => item.expectation.id), 'Agent eval suite case id');

  return Object.freeze({
    suiteId: requiredNonEmptyString(suiteInput, 'suiteId', 'Agent eval suite manifest suite'),
    suiteName: requiredNonEmptyString(suiteInput, 'suiteName', 'Agent eval suite manifest suite'),
    cases: Object.freeze(cases),
    ...(suiteInput.environment === undefined ? {} : {
      environment: requiredEnum(
        suiteInput, 'environment', EVALUATION_ENVIRONMENTS, 'Agent eval suite manifest suite',
      ),
    }),
    ...(suiteInput.notes === undefined ? {} : {
      notes: Object.freeze(optionalStringArray(suiteInput, 'notes', 'Agent eval suite manifest suite')!),
    }),
  });
}

function parseCase(input: unknown, index: number): AgentEvalSuiteCase {
  const label = `Agent eval suite case at index ${index}`;
  const record = objectRecord(input, label) as UnknownManifestCase;
  requireOnlyKeys(record, CASE_KEYS, label);
  const minTurns = optionalNonNegativeInteger(record, 'minTurns', label);
  const maxTurns = optionalNonNegativeInteger(record, 'maxTurns', label);
  if (minTurns !== undefined && maxTurns !== undefined && minTurns > maxTurns) {
    throw new Error(`${label} minTurns cannot be greater than maxTurns.`);
  }
  const expectation: AgentEvalSuiteExpectation = Object.freeze({
    id: requiredNonEmptyString(record, 'id', label),
    userTask: requiredNonEmptyString(record, 'userTask', label),
    ...(record.expectedStatus === undefined ? {} : {
      expectedStatus: requiredEnum(record, 'expectedStatus', RUN_STATUSES, label),
    }),
    ...(record.requiredToolCalls === undefined ? {} : {
      requiredToolCalls: Object.freeze(optionalStringArray(record, 'requiredToolCalls', label)!),
    }),
    ...(record.forbiddenToolCalls === undefined ? {} : {
      forbiddenToolCalls: Object.freeze(optionalStringArray(record, 'forbiddenToolCalls', label)!),
    }),
    ...(record.requiredToolStatuses === undefined ? {} : {
      requiredToolStatuses: Object.freeze(parseRequiredToolStatuses(record, label)),
    }),
    ...(record.toolExpectations === undefined ? {} : {
      toolExpectations: Object.freeze(parseToolExpectations(record, label)),
    }),
    ...(record.finalTextIncludes === undefined ? {} : {
      finalTextIncludes: Object.freeze(optionalStringArray(record, 'finalTextIncludes', label)!),
    }),
    ...(record.finalTextExcludes === undefined ? {} : {
      finalTextExcludes: Object.freeze(optionalStringArray(record, 'finalTextExcludes', label)!),
    }),
    ...(minTurns === undefined ? {} : { minTurns }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
  return Object.freeze({
    expectation,
    ...(record.configuration === undefined ? {} : {
      configuration: parseConfiguration(record.configuration, `${label} configuration`),
    }),
  });
}

function parseRequiredToolStatuses(
  record: UnknownManifestCase,
  label: string,
): ReadonlyArray<Readonly<{ toolName: string; status: AgentEvalToolStatus }>> {
  return arrayValue(record.requiredToolStatuses, `${label} requiredToolStatuses`).map((item, index) => {
    const itemLabel = `${label} requiredToolStatuses[${index}]`;
    const value = objectRecord(item, itemLabel);
    requireOnlyKeys(value, new Set(['toolName', 'status']), itemLabel);
    return Object.freeze({
      toolName: requiredNonEmptyString(value, 'toolName', itemLabel),
      status: requiredEnum(value, 'status', TOOL_STATUSES, itemLabel),
    });
  });
}

function parseToolExpectations(
  record: UnknownManifestCase,
  label: string,
): ReadonlyArray<AgentEvalToolExpectation> {
  return arrayValue(record.toolExpectations, `${label} toolExpectations`).map((item, index) => {
    const itemLabel = `${label} toolExpectations[${index}]`;
    const value = objectRecord(item, itemLabel) as UnknownToolExpectation;
    requireOnlyKeys(value, new Set([
      'toolName', 'status', 'minCalls', 'maxCalls', 'caseSensitive', 'argumentIncludes',
      'argumentExcludes', 'resultIncludes', 'resultExcludes',
    ]), itemLabel);
    const minCalls = optionalNonNegativeInteger(value, 'minCalls', itemLabel);
    const maxCalls = optionalNonNegativeInteger(value, 'maxCalls', itemLabel);
    if (minCalls !== undefined && maxCalls !== undefined && minCalls > maxCalls) {
      throw new Error(`${itemLabel} minCalls cannot be greater than maxCalls.`);
    }
    return Object.freeze({
      toolName: requiredNonEmptyString(value, 'toolName', itemLabel),
      ...(value.status === undefined ? {} : {
        status: requiredEnum(value, 'status', TOOL_STATUSES, itemLabel),
      }),
      ...(minCalls === undefined ? {} : { minCalls }),
      ...(maxCalls === undefined ? {} : { maxCalls }),
      ...(value.caseSensitive === undefined ? {} : {
        caseSensitive: booleanValue(value.caseSensitive, `${itemLabel} caseSensitive`),
      }),
      ...(value.argumentIncludes === undefined ? {} : {
        argumentIncludes: Object.freeze(optionalStringArray(value, 'argumentIncludes', itemLabel)!),
      }),
      ...(value.argumentExcludes === undefined ? {} : {
        argumentExcludes: Object.freeze(optionalStringArray(value, 'argumentExcludes', itemLabel)!),
      }),
      ...(value.resultIncludes === undefined ? {} : {
        resultIncludes: Object.freeze(optionalStringArray(value, 'resultIncludes', itemLabel)!),
      }),
      ...(value.resultExcludes === undefined ? {} : {
        resultExcludes: Object.freeze(optionalStringArray(value, 'resultExcludes', itemLabel)!),
      }),
    });
  });
}

function parseConfiguration(value: unknown, label: string): AgentEvalRunConfiguration {
  const record = objectRecord(value, label);
  requireOnlyKeys(record, CONFIGURATION_KEYS, label);
  const maxTurns = optionalPositiveInteger(record, 'maxTurns', label);
  return Object.freeze({
    ...(record.mode === undefined ? {} : { mode: requiredEnum(record, 'mode', AGENT_MODES, label) }),
    ...(record.allowedTools === undefined ? {} : {
      allowedTools: Object.freeze(optionalStringArray(record, 'allowedTools', label)!),
    }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported key: ${key}.`);
  }
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
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new Error(`${label} ${key} must be a finite number.`);
  }
  return record[key];
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] | undefined {
  if (record[key] === undefined) return undefined;
  return arrayValue(record[key], `${label} ${key}`).map((item, index) =>
    stringValue(item, `${label} ${key}[${index}]`));
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

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number | undefined {
  return optionalInteger(record, key, label, 0);
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string, label: string): number | undefined {
  return optionalInteger(record, key, label, 1);
}

function optionalInteger(
  record: Record<string, unknown>, key: string, label: string, min: number,
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

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
