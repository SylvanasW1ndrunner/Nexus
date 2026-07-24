import sqlParserPackage from 'node-sql-parser/build/postgresql.js';
import { analyzeSqlSafety } from './sql-safety.js';
import { splitSqlStatements } from './sql-statements.js';

const { Parser } = sqlParserPackage;

export type SqlPermissionLevel = 'read' | 'edit' | 'full';

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
  requiredPermission: SqlPermissionLevel;
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
      requiredPermission: 'full',
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
    const permission = maxPermission([
      ...statementKinds.map((kind, index) =>
        permissionForSqlStatement(
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
      requiredPermission: permission,
      tables: normalizeParserReferences(parsed.tableList),
      columns: normalizeParserReferences(parsed.columnList),
      hasWhere: astItems.some(astHasWhere),
    };
  } catch (error) {
    const statementKinds = segments.map((segment) => segment.statementKind);
    const permission = maxPermission([
      ...segments.map((segment) =>
        permissionForSqlStatement(
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
      requiredPermission: permission,
      tables: extractFallbackTables(sql),
      columns: [],
      hasWhere: segments.some((segment) => /\bWHERE\b/i.test(segment.text)),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function permissionAllows(
  current: SqlPermissionLevel,
  required: SqlPermissionLevel,
): boolean {
  return permissionRank(current) >= permissionRank(required);
}

export function permissionRank(permission: SqlPermissionLevel): number {
  if (permission === 'read') return 0;
  if (permission === 'edit') return 1;
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

function permissionForKind(kind: string): SqlPermissionLevel {
  if (READ_KINDS.has(kind)) return 'read';
  if (EDIT_KINDS.has(kind)) return 'edit';
  return 'full';
}

function permissionForSqlStatement(
  kind: string,
  sql: string,
  safetyBlocked: boolean,
): SqlPermissionLevel {
  const normalizedKind = kind.toUpperCase();
  const code = maskNonCode(sql);
  if (normalizedKind === 'WITH') {
    if (containsFullPermissionOperation(code)) return 'full';
    if (containsEditOperation(code)) return 'edit';
    return safetyBlocked ? 'full' : 'read';
  }
  if (normalizedKind === 'EXPLAIN') {
    if (!/\bANALYZE\b/i.test(code)) return 'read';
    if (containsFullPermissionOperation(code)) return 'full';
    if (containsEditOperation(code)) return 'edit';
    return safetyBlocked ? 'full' : 'read';
  }
  if (READ_KINDS.has(normalizedKind) && safetyBlocked) return 'full';
  return permissionForKind(normalizedKind);
}

function containsEditOperation(sql: string): boolean {
  return /\b(?:INSERT|REPLACE|UPDATE|DELETE|MERGE)\b/i.test(sql);
}

function containsFullPermissionOperation(sql: string): boolean {
  return /\b(?:CREATE|ALTER|DROP|TRUNCATE|CALL|GRANT|REVOKE|COMMENT|COPY|DO|LOCK|REFRESH|REINDEX|RESET|SET|VACUUM|CLUSTER)\b/i.test(
    sql,
  );
}

function maxPermission(permissions: SqlPermissionLevel[]): SqlPermissionLevel {
  return permissions.reduce<SqlPermissionLevel>(
    (current, next) =>
      permissionRank(next) > permissionRank(current) ? next : current,
    'read',
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
