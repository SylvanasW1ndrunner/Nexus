import type { QueryRiskLevel, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';

export type RoleAttributes = {
  login?: boolean;
  superuser?: boolean;
  createDb?: boolean;
  createRole?: boolean;
  inherit?: boolean;
  replication?: boolean;
  bypassRls?: boolean;
};

export type BuildCreateRolePreviewRequest = {
  role: string;
  attributes?: RoleAttributes;
  comment?: string;
};

export type BuildAlterRolePreviewRequest = {
  role: string;
  attributes: RoleAttributes;
};

export type BuildDropRolePreviewRequest = {
  role: string;
  ifExists?: boolean;
};

export type BuildGrantRoleMembershipPreviewRequest = {
  role: string;
  member: string;
  adminOption?: boolean;
};

export type BuildRevokeRoleMembershipPreviewRequest = {
  role: string;
  member: string;
  adminOptionOnly?: boolean;
};

export type PrivilegeObjectType = 'schema' | 'table' | 'sequence' | 'function' | 'procedure';

export type ObjectPrivilege =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'truncate'
  | 'references'
  | 'trigger'
  | 'usage'
  | 'create'
  | 'execute';

export type PrivilegeTarget = {
  type: PrivilegeObjectType;
  schema: string;
  name?: string;
  signature?: string[];
};

export type BuildGrantPrivilegesPreviewRequest = {
  target: PrivilegeTarget;
  grantee: string;
  privileges: ObjectPrivilege[];
  grantOption?: boolean;
};

export type BuildRevokePrivilegesPreviewRequest = {
  target: PrivilegeTarget;
  grantee: string;
  privileges: ObjectPrivilege[];
  grantOptionOnly?: boolean;
  cascade?: boolean;
};

export type PrivilegePreview = {
  sql: string;
  statements: string[];
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  requiresExtraConfirmation: boolean;
  warnings: string[];
};

const OBJECT_PRIVILEGES: Record<PrivilegeObjectType, Set<ObjectPrivilege>> = {
  schema: new Set(['usage', 'create']),
  table: new Set(['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']),
  sequence: new Set(['select', 'update', 'usage']),
  function: new Set(['execute']),
  procedure: new Set(['execute']),
};

export function buildCreateRolePreview(request: BuildCreateRolePreviewRequest): Result<PrivilegePreview> {
  const role = validateIdentifier(request.role, 'Role');
  if (!role.ok) return role;
  const attributes = normalizeRoleAttributes(request.attributes ?? {});
  const statements = [`create role ${quotePgIdentifier(request.role)} with ${attributes.sql.join(' ')};`];
  if (request.comment !== undefined) statements.push(`comment on role ${quotePgIdentifier(request.role)} is ${toSqlString(request.comment)};`);
  return ok(toPreview(statements, attributes.warnings, attributes.requiresExtraConfirmation));
}

export function buildAlterRolePreview(request: BuildAlterRolePreviewRequest): Result<PrivilegePreview> {
  const role = validateIdentifier(request.role, 'Role');
  if (!role.ok) return role;
  const attributes = normalizeRoleAttributes(request.attributes);
  if (attributes.sql.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Alter role preview requires at least one attribute change.' });
  }
  return ok(
    toPreview(
      [`alter role ${quotePgIdentifier(request.role)} with ${attributes.sql.join(' ')};`],
      attributes.warnings,
      attributes.requiresExtraConfirmation,
    ),
  );
}

export function buildDropRolePreview(request: BuildDropRolePreviewRequest): Result<PrivilegePreview> {
  const role = validateIdentifier(request.role, 'Role');
  if (!role.ok) return role;
  return ok(
    toPreview(
      [`drop role ${request.ifExists ? 'if exists ' : ''}${quotePgIdentifier(request.role)};`],
      ['Dropping a role can break database access and must be confirmed.'],
      true,
    ),
  );
}

export function buildGrantRoleMembershipPreview(
  request: BuildGrantRoleMembershipPreviewRequest,
): Result<PrivilegePreview> {
  const validation = validateRolePair(request.role, request.member);
  if (!validation.ok) return validation;
  const statement = `grant ${quotePgIdentifier(request.role)} to ${quotePgIdentifier(request.member)}${
    request.adminOption ? ' with admin option' : ''
  };`;
  return ok(toPreview([statement], request.adminOption ? ['Role membership WITH ADMIN OPTION requires extra review.'] : [], Boolean(request.adminOption)));
}

export function buildRevokeRoleMembershipPreview(
  request: BuildRevokeRoleMembershipPreviewRequest,
): Result<PrivilegePreview> {
  const validation = validateRolePair(request.role, request.member);
  if (!validation.ok) return validation;
  const statement = `revoke ${request.adminOptionOnly ? 'admin option for ' : ''}${quotePgIdentifier(request.role)} from ${quotePgIdentifier(
    request.member,
  )};`;
  return ok(toPreview([statement], ['Revoking role membership can break application access and must be confirmed.'], false));
}

export function buildGrantPrivilegesPreview(request: BuildGrantPrivilegesPreviewRequest): Result<PrivilegePreview> {
  const target = buildTargetSql(request.target);
  if (!target.ok) return target;
  const privileges = normalizePrivileges(request.target.type, request.privileges);
  if (!privileges.ok) return privileges;
  const grantee = validateIdentifier(request.grantee, 'Grantee');
  if (!grantee.ok) return grantee;

  const statement = `grant ${privileges.data.join(', ')} on ${target.data} to ${quotePgIdentifier(request.grantee)}${
    request.grantOption ? ' with grant option' : ''
  };`;
  return ok(
    toPreview(
      [statement],
      request.grantOption ? ['WITH GRANT OPTION allows the grantee to delegate privileges and requires extra review.'] : [],
      Boolean(request.grantOption),
    ),
  );
}

export function buildRevokePrivilegesPreview(request: BuildRevokePrivilegesPreviewRequest): Result<PrivilegePreview> {
  const target = buildTargetSql(request.target);
  if (!target.ok) return target;
  const privileges = normalizePrivileges(request.target.type, request.privileges);
  if (!privileges.ok) return privileges;
  const grantee = validateIdentifier(request.grantee, 'Grantee');
  if (!grantee.ok) return grantee;

  const statement = `revoke ${request.grantOptionOnly ? 'grant option for ' : ''}${privileges.data.join(', ')} on ${
    target.data
  } from ${quotePgIdentifier(request.grantee)}${request.cascade ? ' cascade' : ''};`;
  return ok(toPreview([statement], ['Revoking privileges can break application access and must be confirmed.'], false));
}

function toPreview(
  statements: string[],
  warnings: string[],
  requiresExtraConfirmation: boolean,
): PrivilegePreview {
  return {
    sql: statements.join('\n'),
    statements,
    riskLevel: 'dangerous',
    requiresConfirmation: true,
    requiresExtraConfirmation,
    warnings,
  };
}

function normalizeRoleAttributes(attributes: RoleAttributes): {
  sql: string[];
  warnings: string[];
  requiresExtraConfirmation: boolean;
} {
  const sql: string[] = [];
  const warnings: string[] = [];
  let requiresExtraConfirmation = false;
  appendRoleFlag(sql, 'login', attributes.login);
  appendRoleFlag(sql, 'superuser', attributes.superuser);
  appendRoleFlag(sql, 'createdb', attributes.createDb);
  appendRoleFlag(sql, 'createrole', attributes.createRole);
  appendRoleFlag(sql, 'inherit', attributes.inherit);
  appendRoleFlag(sql, 'replication', attributes.replication);
  appendRoleFlag(sql, 'bypassrls', attributes.bypassRls);

  if (attributes.superuser) {
    warnings.push('SUPERUSER bypasses nearly all PostgreSQL permission checks and requires extra confirmation.');
    requiresExtraConfirmation = true;
  }
  if (attributes.replication) {
    warnings.push('REPLICATION role can access replication streams and requires extra confirmation.');
    requiresExtraConfirmation = true;
  }
  if (attributes.bypassRls) {
    warnings.push('BYPASSRLS bypasses row level security and requires extra confirmation.');
    requiresExtraConfirmation = true;
  }
  return { sql, warnings, requiresExtraConfirmation };
}

function appendRoleFlag(parts: string[], keyword: string, value: boolean | undefined): void {
  if (value === undefined) return;
  parts.push(value ? keyword : `no${keyword}`);
}

function buildTargetSql(target: PrivilegeTarget): Result<string> {
  const schema = validateIdentifier(target.schema, 'Schema');
  if (!schema.ok) return schema;
  if (target.type === 'schema') return ok(`schema ${quotePgIdentifier(target.schema)}`);
  if (!target.name) return err({ code: 'VALIDATION_ERROR', message: 'Privilege target object name is required.' });
  const name = validateIdentifier(target.name, 'Privilege target');
  if (!name.ok) return name;
  if (target.type === 'function' || target.type === 'procedure') {
    const signature = buildSignature(target.signature ?? []);
    if (!signature.ok) return signature;
    return ok(`${target.type} ${quotePgIdentifier(target.schema)}.${quotePgIdentifier(target.name)}(${signature.data})`);
  }
  return ok(`${target.type} ${quotePgIdentifier(target.schema)}.${quotePgIdentifier(target.name)}`);
}

function buildSignature(signature: string[]): Result<string> {
  const parts: string[] = [];
  for (const dataType of signature) {
    const validation = validateSqlFragment(dataType, 'Routine signature type');
    if (!validation.ok) return validation;
    parts.push(dataType.trim());
  }
  return ok(parts.join(', '));
}

function normalizePrivileges(type: PrivilegeObjectType, privileges: ObjectPrivilege[]): Result<string[]> {
  if (privileges.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'At least one privilege is required.' });
  }
  const allowed = OBJECT_PRIVILEGES[type];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const privilege of privileges) {
    if (!allowed.has(privilege)) {
      return err({ code: 'VALIDATION_ERROR', message: `${privilege.toUpperCase()} is not valid for ${type} privileges.` });
    }
    if (!seen.has(privilege)) {
      seen.add(privilege);
      normalized.push(privilege.toUpperCase());
    }
  }
  return ok(normalized);
}

function validateRolePair(role: string, member: string): Result<void> {
  const roleValidation = validateIdentifier(role, 'Role');
  if (!roleValidation.ok) return roleValidation;
  return validateIdentifier(member, 'Member role');
}

function validateIdentifier(identifier: string, label: string): Result<void> {
  if (!identifier || identifier.trim().length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name is required.` });
  }
  if (identifier.includes('\0')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains an invalid null byte.` });
  }
  if (identifier.includes(';') || identifier.includes('--') || identifier.includes('/*') || identifier.includes('*/')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains unsafe SQL tokens.` });
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

function toSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
