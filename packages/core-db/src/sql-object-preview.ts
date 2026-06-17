import type { QueryRiskLevel, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';
import { containsMultipleStatements, firstStatementKind, stripSqlComments } from './sql-safety.js';

export type SqlRoutineKind = 'function' | 'procedure';

export type RoutineParameterMode = 'in' | 'out' | 'inout' | 'variadic';

export type RoutineParameterDefinition = {
  name?: string;
  dataType: string;
  mode?: RoutineParameterMode;
};

export type BuildCreateOrReplaceViewPreviewRequest = {
  schema: string;
  view: string;
  selectSql: string;
  checkOption?: 'cascaded' | 'local';
};

export type BuildCreateOrReplaceFunctionPreviewRequest = {
  schema: string;
  name: string;
  parameters?: RoutineParameterDefinition[];
  returns: string;
  language?: string;
  body: string;
  volatility?: 'volatile' | 'stable' | 'immutable';
  security?: 'invoker' | 'definer';
};

export type BuildCreateOrReplaceProcedurePreviewRequest = {
  schema: string;
  name: string;
  parameters?: RoutineParameterDefinition[];
  language?: string;
  body: string;
  security?: 'invoker' | 'definer';
};

export type BuildDropSqlObjectPreviewRequest = {
  schema: string;
  name: string;
  kind: 'view' | SqlRoutineKind;
  signature?: RoutineParameterDefinition[];
  cascade?: boolean;
};

export type BuildRoutineTestCallRequest = {
  schema: string;
  name: string;
  kind: SqlRoutineKind;
  args?: unknown[];
  resultShape?: 'scalar' | 'setof';
  limit?: number;
};

export type RoutineTestCall = {
  sql: string;
  params: unknown[];
  warnings: string[];
};

export type SqlObjectPreview = {
  sql: string;
  statements: string[];
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  warnings: string[];
};

const DEFAULT_LANGUAGE = 'plpgsql';
const BODY_DELIMITER = '$dbagent$';
const DEFAULT_TEST_LIMIT = 100;
const MAX_TEST_LIMIT = 1000;

export function buildCreateOrReplaceViewPreview(
  request: BuildCreateOrReplaceViewPreviewRequest,
): Result<SqlObjectPreview> {
  const target = validateTarget(request.schema, request.view, 'View');
  if (!target.ok) return target;

  const selectSql = normalizeSingleViewSelect(request.selectSql);
  if (!selectSql.ok) return selectSql;

  const checkOption = request.checkOption ? `\nwith ${request.checkOption} check option` : '';
  const statement = `create or replace view ${qualifiedName(request.schema, request.view)} as\n${selectSql.data}${checkOption};`;
  return ok(toPreview([statement], ['View definition changes require explicit review before execution.']));
}

export function buildCreateOrReplaceFunctionPreview(
  request: BuildCreateOrReplaceFunctionPreviewRequest,
): Result<SqlObjectPreview> {
  const target = validateTarget(request.schema, request.name, 'Function');
  if (!target.ok) return target;
  const parameters = buildParameterList(request.parameters ?? []);
  if (!parameters.ok) return parameters;
  const returns = validateSqlFragment(request.returns, 'Function return type');
  if (!returns.ok) return returns;
  const body = validateRoutineBody(request.body);
  if (!body.ok) return body;
  const language = normalizeRoutineLanguage(request.language);
  if (!language.ok) return language;

  const options = buildRoutineOptions(request.volatility, request.security);
  const statement = [
    `create or replace function ${qualifiedName(request.schema, request.name)}(${parameters.data})`,
    `returns ${request.returns.trim()}`,
    `language ${language.data}`,
    ...options,
    `as ${BODY_DELIMITER}`,
    request.body.trim(),
    `${BODY_DELIMITER};`,
  ].join('\n');
  return ok(toPreview([statement], ['Function definition changes require explicit review before execution.']));
}

export function buildCreateOrReplaceProcedurePreview(
  request: BuildCreateOrReplaceProcedurePreviewRequest,
): Result<SqlObjectPreview> {
  const target = validateTarget(request.schema, request.name, 'Procedure');
  if (!target.ok) return target;
  const parameters = buildParameterList(request.parameters ?? []);
  if (!parameters.ok) return parameters;
  const body = validateRoutineBody(request.body);
  if (!body.ok) return body;
  const language = normalizeRoutineLanguage(request.language);
  if (!language.ok) return language;

  const options = buildRoutineOptions(undefined, request.security);
  const statement = [
    `create or replace procedure ${qualifiedName(request.schema, request.name)}(${parameters.data})`,
    `language ${language.data}`,
    ...options,
    `as ${BODY_DELIMITER}`,
    request.body.trim(),
    `${BODY_DELIMITER};`,
  ].join('\n');
  return ok(toPreview([statement], ['Procedure definition changes require explicit review before execution.']));
}

export function buildDropSqlObjectPreview(request: BuildDropSqlObjectPreviewRequest): Result<SqlObjectPreview> {
  const target = validateTarget(request.schema, request.name, request.kind);
  if (!target.ok) return target;

  if (request.kind === 'view') {
    const statement = `drop view ${qualifiedName(request.schema, request.name)}${request.cascade ? ' cascade' : ''};`;
    return ok(toPreview([statement], ['Dropping a view is destructive and must be confirmed.']));
  }

  const signature = buildSignature(request.signature ?? []);
  if (!signature.ok) return signature;
  const statement = `drop ${request.kind} ${qualifiedName(request.schema, request.name)}(${signature.data})${
    request.cascade ? ' cascade' : ''
  };`;
  return ok(toPreview([statement], [`Dropping a ${request.kind} is destructive and must be confirmed.`]));
}

export function buildRoutineTestCall(request: BuildRoutineTestCallRequest): Result<RoutineTestCall> {
  const target = validateTarget(request.schema, request.name, request.kind);
  if (!target.ok) return target;
  const args = request.args ?? [];
  const params = args.map((_, index) => `$${index + 1}`).join(', ');
  const warnings: string[] = [];

  if (request.kind === 'procedure') {
    return ok({
      sql: `call ${qualifiedName(request.schema, request.name)}(${params});`,
      params: args,
      warnings,
    });
  }

  if (request.resultShape === 'scalar') {
    return ok({
      sql: `select ${qualifiedName(request.schema, request.name)}(${params}) as value;`,
      params: args,
      warnings,
    });
  }

  return ok({
    sql: `select * from ${qualifiedName(request.schema, request.name)}(${params}) limit ${normalizeLimit(
      request.limit,
      warnings,
    )};`,
    params: args,
    warnings,
  });
}

function toPreview(statements: string[], warnings: string[]): SqlObjectPreview {
  return {
    sql: statements.join('\n'),
    statements,
    riskLevel: 'dangerous',
    requiresConfirmation: true,
    warnings,
  };
}

function normalizeSingleViewSelect(sql: string): Result<string> {
  const trimmed = sql.trim().replace(/;+\s*$/g, '');
  if (!trimmed) return err({ code: 'VALIDATION_ERROR', message: 'View SELECT SQL is required.' });
  if (containsMultipleStatements(trimmed)) {
    return err({ code: 'VALIDATION_ERROR', message: 'View definition must contain a single SELECT or WITH query.' });
  }
  const kind = firstStatementKind(stripSqlComments(trimmed).trim());
  if (kind !== 'SELECT' && kind !== 'WITH') {
    return err({ code: 'VALIDATION_ERROR', message: 'View definition must start with SELECT or WITH.' });
  }
  return ok(trimmed);
}

function buildParameterList(parameters: RoutineParameterDefinition[]): Result<string> {
  const parts: string[] = [];
  for (const parameter of parameters) {
    const built = buildParameter(parameter, true);
    if (!built.ok) return built;
    parts.push(built.data);
  }
  return ok(parts.join(', '));
}

function buildSignature(parameters: RoutineParameterDefinition[]): Result<string> {
  const parts: string[] = [];
  for (const parameter of parameters) {
    const built = buildParameter(parameter, false);
    if (!built.ok) return built;
    parts.push(built.data);
  }
  return ok(parts.join(', '));
}

function buildParameter(parameter: RoutineParameterDefinition, includeNameAndMode: boolean): Result<string> {
  const dataType = validateSqlFragment(parameter.dataType, 'Routine parameter type');
  if (!dataType.ok) return dataType;
  const parts: string[] = [];
  if (includeNameAndMode && parameter.mode) parts.push(parameter.mode);
  if (includeNameAndMode && parameter.name) {
    const name = validateIdentifier(parameter.name, 'Routine parameter');
    if (!name.ok) return name;
    parts.push(quotePgIdentifier(parameter.name));
  }
  parts.push(parameter.dataType.trim());
  return ok(parts.join(' '));
}

function buildRoutineOptions(
  volatility: BuildCreateOrReplaceFunctionPreviewRequest['volatility'] | undefined,
  security: BuildCreateOrReplaceFunctionPreviewRequest['security'] | undefined,
): string[] {
  const options: string[] = [];
  if (volatility) options.push(volatility);
  if (security) options.push(`security ${security}`);
  return options;
}

function normalizeRoutineLanguage(language: string | undefined): Result<string> {
  const value = (language ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  if (!value) return err({ code: 'VALIDATION_ERROR', message: 'Routine language is required.' });
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    return err({ code: 'VALIDATION_ERROR', message: 'Routine language contains unsafe SQL tokens.' });
  }
  return ok(value);
}

function validateRoutineBody(body: string): Result<void> {
  const trimmed = body.trim();
  if (!trimmed) return err({ code: 'VALIDATION_ERROR', message: 'Routine body is required.' });
  if (trimmed.includes(BODY_DELIMITER)) {
    return err({ code: 'VALIDATION_ERROR', message: 'Routine body contains the reserved DBAgent delimiter.' });
  }
  return ok(undefined);
}

function validateSqlFragment(value: string, label: string): Result<void> {
  const trimmed = value.trim();
  if (!trimmed) return err({ code: 'VALIDATION_ERROR', message: `${label} is required.` });
  if (trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*') || trimmed.includes('*/')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} contains unsafe SQL tokens.` });
  }
  return ok(undefined);
}

function validateTarget(schema: string, name: string, label: string): Result<void> {
  const schemaValidation = validateIdentifier(schema, 'Schema');
  if (!schemaValidation.ok) return schemaValidation;
  return validateIdentifier(name, label);
}

function validateIdentifier(identifier: string, label: string): Result<void> {
  if (!identifier || identifier.trim().length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name is required.` });
  }
  if (identifier.includes('\0')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains an invalid null byte.` });
  }
  return ok(undefined);
}

function qualifiedName(schema: string, name: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(name)}`;
}

function normalizeLimit(limit: number | undefined, warnings: string[]): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TEST_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) {
    warnings.push('Test call limit was below 1 and has been clamped to 1.');
    return 1;
  }
  if (floored > MAX_TEST_LIMIT) {
    warnings.push(`Test call limit exceeded ${MAX_TEST_LIMIT} and has been clamped.`);
    return MAX_TEST_LIMIT;
  }
  return floored;
}
