import sqlParserPackage from 'node-sql-parser/build/postgresql.js';
import type { SqlOperationClass } from '@dbagent/shared';
import { analyzeSqlSafety } from './sql-safety.js';
import { splitSqlStatements } from './sql-statements.js';

const { Parser } = sqlParserPackage;

export type { SqlOperationClass } from '@dbagent/shared';

export type SqlParserDialect =
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'bigquery'
  | 'redshift'
  | 'transactsql'
  | 'flinksql';

export type SqlParseResult = {
  dialect: SqlParserDialect;
  valid: boolean;
  parser: 'node-sql-parser' | 'statement-scanner';
  statementCount: number;
  statementKinds: string[];
  requiredOperationClass: SqlOperationClass;
  tables: string[];
  columns: string[];
  hasWhere: boolean;
  parseError?: string;
};

const READ_KINDS = new Set(['SELECT', 'VALUES', 'SHOW', 'EXPLAIN', 'DESCRIBE']);
const EDIT_KINDS = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'MERGE']);

export function parseSql(
  sql: string,
  options: { dialect?: SqlParserDialect } = {},
): SqlParseResult {
  const dialect = options.dialect ?? 'postgresql';
  const segments = splitSqlStatements(sql);
  if (segments.length === 0) {
    return {
      dialect,
      valid: false,
      parser: 'statement-scanner',
      statementCount: 0,
      statementKinds: [],
      requiredOperationClass: 'schema-admin',
      tables: [],
      columns: [],
      hasWhere: false,
      parseError: 'SQL is empty.',
    };
  }

  try {
    if (dialect !== 'postgresql') {
      throw new Error(
        `The ${dialect} AST adapter is not installed in this runtime.`,
      );
    }
    const parser = new Parser();
    const parsed = parser.parse(sql);
    const astItems = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
    const statementKinds = astItems.map(astStatementKind);
    const operationClass = maxOperationClass([
      ...statementKinds.map((kind, index) =>
        operationClassForSqlStatement(
          segments[index]?.statementKind ?? kind,
          segments[index]?.text ?? sql,
          analyzeSqlSafety(segments[index]?.text ?? sql, {
            readOnly: true,
          }).blocked,
        ),
      ),
    ]);
    return {
      dialect,
      valid: true,
      parser: 'node-sql-parser',
      statementCount: astItems.length,
      statementKinds,
      requiredOperationClass: operationClass,
      tables: normalizeParserReferences(parsed.tableList),
      columns: normalizeParserReferences(parsed.columnList),
      hasWhere: astItems.some(astHasWhere),
    };
  } catch (error) {
    const statementKinds = segments.map((segment) => segment.statementKind);
    const operationClass = maxOperationClass([
      ...segments.map((segment) =>
        operationClassForSqlStatement(
          segment.statementKind,
          segment.text,
          analyzeSqlSafety(segment.text, { readOnly: true }).blocked,
        ),
      ),
    ]);
    return {
      dialect,
      valid: false,
      parser: 'statement-scanner',
      statementCount: segments.length,
      statementKinds,
      requiredOperationClass: operationClass,
      tables: extractFallbackTables(sql),
      columns: [],
      hasWhere: segments.some((segment) => /\bWHERE\b/i.test(segment.text)),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function operationClassAllows(
  authorized: SqlOperationClass,
  required: SqlOperationClass,
): boolean {
  return operationClassRank(authorized) >= operationClassRank(required);
}

export function operationClassRank(operationClass: SqlOperationClass): number {
  if (operationClass === 'query') return 0;
  if (operationClass === 'mutation') return 1;
  return 2;
}

function astStatementKind(ast: unknown): string {
  if (!isRecord(ast) || typeof ast.type !== 'string') return 'UNKNOWN';
  return ast.type.toUpperCase();
}

function astHasWhere(ast: unknown): boolean {
  if (!isRecord(ast)) return false;
  if (ast.where !== null && ast.where !== undefined) return true;
  if (Array.isArray(ast.with)) {
    return ast.with.some((item) => {
      if (!isRecord(item) || !isRecord(item.stmt)) return false;
      return astHasWhere(item.stmt.ast);
    });
  }
  return false;
}

function operationClassForKind(kind: string): SqlOperationClass {
  if (READ_KINDS.has(kind)) return 'query';
  if (EDIT_KINDS.has(kind)) return 'mutation';
  return 'schema-admin';
}

function operationClassForSqlStatement(
  kind: string,
  sql: string,
  safetyBlocked: boolean,
): SqlOperationClass {
  const normalizedKind = kind.toUpperCase();
  const code = maskNonCode(sql);
  if (normalizedKind === 'WITH') {
    if (containsSchemaAdminOperation(code)) return 'schema-admin';
    if (containsEditOperation(code)) return 'mutation';
    return safetyBlocked ? 'schema-admin' : 'query';
  }
  if (normalizedKind === 'EXPLAIN') {
    if (!/\bANALYZE\b/i.test(code)) return 'query';
    if (containsSchemaAdminOperation(code)) return 'schema-admin';
    if (containsEditOperation(code)) return 'mutation';
    return safetyBlocked ? 'schema-admin' : 'query';
  }
  if (READ_KINDS.has(normalizedKind) && safetyBlocked) return 'schema-admin';
  return operationClassForKind(normalizedKind);
}

function containsEditOperation(sql: string): boolean {
  return /\b(?:INSERT|REPLACE|UPDATE|DELETE|MERGE)\b/i.test(sql);
}

function containsSchemaAdminOperation(sql: string): boolean {
  return /\b(?:CREATE|ALTER|DROP|TRUNCATE|CALL|GRANT|REVOKE|COMMENT|COPY|DO|LOCK|REFRESH|REINDEX|RESET|SET|VACUUM|CLUSTER)\b/i.test(
    sql,
  );
}

function maxOperationClass(operationClasses: SqlOperationClass[]): SqlOperationClass {
  return operationClasses.reduce<SqlOperationClass>(
    (current, next) =>
      operationClassRank(next) > operationClassRank(current) ? next : current,
    'query',
  );
}

function normalizeParserReferences(references: string[]): string[] {
  return [
    ...new Set(
      references
        .map((reference) => {
          const parts = reference.split('::');
          const objectParts = parts.slice(1).filter(Boolean);
          return normalizeIdentifierReference(objectParts.join('.'));
        })
        .filter(Boolean),
    ),
  ].sort();
}

function extractFallbackTables(sql: string): string[] {
  const tables = new Set<string>();
  const masked = maskStringLiterals(sql);
  const pattern =
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|USING)\s+((?:"(?:[^"]|"")*"|[a-zA-Z_\u4e00-\u9fff][\w$\u4e00-\u9fff]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[a-zA-Z_\u4e00-\u9fff][\w$\u4e00-\u9fff]*))?)/gi;
  for (const match of masked.matchAll(pattern)) {
    if (match[1]) {
      tables.add(normalizeIdentifierReference(match[1].replace(/\s+/g, '')));
    }
  }
  return [...tables].sort();
}

function normalizeIdentifierReference(reference: string): string {
  return reference.replace(/"((?:[^"]|"")*)"/g, (_match, identifier: string) =>
    identifier.replace(/""/g, '"'),
  );
}

function maskStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, (value) => ' '.repeat(value.length));
}

function maskNonCode(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$[\s\S]*?\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/g, ' ')
    .replace(/'(?:''|\\.|[^'])*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
