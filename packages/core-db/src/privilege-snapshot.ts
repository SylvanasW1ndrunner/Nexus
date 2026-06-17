import type {
  BuildGrantPrivilegesPreviewRequest,
  BuildGrantRoleMembershipPreviewRequest,
  BuildRevokePrivilegesPreviewRequest,
  BuildRevokeRoleMembershipPreviewRequest,
  ObjectPrivilege,
  PrivilegeTarget,
  RoleAttributes,
} from './privilege-preview.js';
import {
  buildAlterRolePreview,
  buildGrantPrivilegesPreview,
  buildGrantRoleMembershipPreview,
  buildRevokePrivilegesPreview,
  buildRevokeRoleMembershipPreview,
} from './privilege-preview.js';
import type { Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';

export type RolePrivilegeSnapshot = {
  role: string;
  attributes: RoleAttributes;
};

export type RoleMembershipSnapshot = {
  role: string;
  member: string;
  adminOption?: boolean;
};

export type ObjectPrivilegeSnapshot = {
  target: PrivilegeTarget;
  grantee: string;
  privileges: ObjectPrivilege[];
  grantOption?: boolean;
};

export type PrivilegeSnapshot = {
  capturedAt: string;
  roles?: RolePrivilegeSnapshot[];
  memberships?: RoleMembershipSnapshot[];
  objectPrivileges?: ObjectPrivilegeSnapshot[];
};

export type PrivilegeDiffChange =
  | { kind: 'alter_role'; role: string }
  | { kind: 'grant_role'; role: string; member: string }
  | { kind: 'revoke_role'; role: string; member: string }
  | { kind: 'grant_privileges'; target: PrivilegeTarget; grantee: string; privileges: ObjectPrivilege[] }
  | { kind: 'revoke_privileges'; target: PrivilegeTarget; grantee: string; privileges: ObjectPrivilege[] };

export type BuildPrivilegeDiffPlanRequest = {
  current: PrivilegeSnapshot;
  desired: PrivilegeSnapshot;
};

export type PrivilegeDiffPlan = {
  preChangeSnapshot: PrivilegeSnapshot;
  statements: string[];
  changes: PrivilegeDiffChange[];
  warnings: string[];
  requiresConfirmation: boolean;
  requiresExtraConfirmation: boolean;
};

type ExplodedObjectPrivilege = {
  target: PrivilegeTarget;
  grantee: string;
  privilege: ObjectPrivilege;
  grantOption: boolean;
};

export function buildPrivilegeDiffPlan(request: BuildPrivilegeDiffPlanRequest): Result<PrivilegeDiffPlan> {
  const statements: string[] = [];
  const changes: PrivilegeDiffChange[] = [];
  const warnings: string[] = ['Current privilege snapshot must be persisted before executing this plan.'];
  let requiresExtraConfirmation = false;

  const rolePlan = appendRoleAttributeChanges(request.current.roles ?? [], request.desired.roles ?? []);
  if (!rolePlan.ok) return rolePlan;
  appendPlanOutput(rolePlan.data, statements, changes, warnings);
  requiresExtraConfirmation ||= rolePlan.data.requiresExtraConfirmation;

  const membershipPlan = appendMembershipChanges(request.current.memberships ?? [], request.desired.memberships ?? []);
  if (!membershipPlan.ok) return membershipPlan;
  appendPlanOutput(membershipPlan.data, statements, changes, warnings);
  requiresExtraConfirmation ||= membershipPlan.data.requiresExtraConfirmation;

  const objectPlan = appendObjectPrivilegeChanges(
    request.current.objectPrivileges ?? [],
    request.desired.objectPrivileges ?? [],
  );
  if (!objectPlan.ok) return objectPlan;
  appendPlanOutput(objectPlan.data, statements, changes, warnings);
  requiresExtraConfirmation ||= objectPlan.data.requiresExtraConfirmation;

  return ok({
    preChangeSnapshot: request.current,
    statements,
    changes,
    warnings,
    requiresConfirmation: statements.length > 0,
    requiresExtraConfirmation,
  });
}

function appendRoleAttributeChanges(
  currentRoles: RolePrivilegeSnapshot[],
  desiredRoles: RolePrivilegeSnapshot[],
): Result<Pick<PrivilegeDiffPlan, 'statements' | 'changes' | 'warnings' | 'requiresExtraConfirmation'>> {
  const statements: string[] = [];
  const changes: PrivilegeDiffChange[] = [];
  const warnings: string[] = [];
  let requiresExtraConfirmation = false;
  const currentByRole = new Map(currentRoles.map((role) => [role.role, role]));
  for (const desired of desiredRoles) {
    const current = currentByRole.get(desired.role);
    const patch = diffRoleAttributes(current?.attributes ?? {}, desired.attributes);
    if (Object.keys(patch).length === 0) continue;
    const preview = buildAlterRolePreview({ role: desired.role, attributes: patch });
    if (!preview.ok) return preview;
    statements.push(...preview.data.statements);
    warnings.push(...preview.data.warnings);
    requiresExtraConfirmation ||= preview.data.requiresExtraConfirmation;
    changes.push({ kind: 'alter_role', role: desired.role });
  }
  return ok({ statements, changes, warnings, requiresExtraConfirmation });
}

function appendMembershipChanges(
  currentMemberships: RoleMembershipSnapshot[],
  desiredMemberships: RoleMembershipSnapshot[],
): Result<Pick<PrivilegeDiffPlan, 'statements' | 'changes' | 'warnings' | 'requiresExtraConfirmation'>> {
  const current = new Map(currentMemberships.map((item) => [membershipKey(item), item]));
  const desired = new Map(desiredMemberships.map((item) => [membershipKey(item), item]));
  const grants: BuildGrantRoleMembershipPreviewRequest[] = [];
  const revokes: BuildRevokeRoleMembershipPreviewRequest[] = [];

  for (const item of desired.values()) {
    const existing = current.get(membershipKey(item));
    if (!existing || Boolean(existing.adminOption) !== Boolean(item.adminOption)) {
      grants.push({
        role: item.role,
        member: item.member,
        ...(item.adminOption === undefined ? {} : { adminOption: item.adminOption }),
      });
    }
  }
  for (const item of current.values()) {
    if (!desired.has(membershipKey(item))) revokes.push({ role: item.role, member: item.member });
  }

  const output = emptyOutput();
  for (const grant of grants) {
    const preview = buildGrantRoleMembershipPreview(grant);
    if (!preview.ok) return preview;
    appendPreview(output, preview.data);
    output.changes.push({ kind: 'grant_role', role: grant.role, member: grant.member });
  }
  for (const revoke of revokes) {
    const preview = buildRevokeRoleMembershipPreview(revoke);
    if (!preview.ok) return preview;
    appendPreview(output, preview.data);
    output.changes.push({ kind: 'revoke_role', role: revoke.role, member: revoke.member });
  }
  return ok(output);
}

function appendObjectPrivilegeChanges(
  currentPrivileges: ObjectPrivilegeSnapshot[],
  desiredPrivileges: ObjectPrivilegeSnapshot[],
): Result<Pick<PrivilegeDiffPlan, 'statements' | 'changes' | 'warnings' | 'requiresExtraConfirmation'>> {
  const current = new Map(explodePrivileges(currentPrivileges).map((item) => [objectPrivilegeKey(item), item]));
  const desired = new Map(explodePrivileges(desiredPrivileges).map((item) => [objectPrivilegeKey(item), item]));
  const grants = groupObjectPrivilegeDiff([...desired.values()].filter((item) => !current.has(objectPrivilegeKey(item))));
  const revokes = groupObjectPrivilegeDiff([...current.values()].filter((item) => !desired.has(objectPrivilegeKey(item))));
  const output = emptyOutput();

  for (const grant of grants) {
    const preview = buildGrantPrivilegesPreview(grant);
    if (!preview.ok) return preview;
    appendPreview(output, preview.data);
    output.changes.push({
      kind: 'grant_privileges',
      target: grant.target,
      grantee: grant.grantee,
      privileges: grant.privileges,
    });
  }
  for (const revoke of revokes) {
    const preview = buildRevokePrivilegesPreview(revoke);
    if (!preview.ok) return preview;
    appendPreview(output, preview.data);
    output.changes.push({
      kind: 'revoke_privileges',
      target: revoke.target,
      grantee: revoke.grantee,
      privileges: revoke.privileges,
    });
  }
  return ok(output);
}

function appendPlanOutput(
  source: Pick<PrivilegeDiffPlan, 'statements' | 'changes' | 'warnings'>,
  statements: string[],
  changes: PrivilegeDiffChange[],
  warnings: string[],
): void {
  statements.push(...source.statements);
  changes.push(...source.changes);
  warnings.push(...source.warnings);
}

function emptyOutput(): Pick<PrivilegeDiffPlan, 'statements' | 'changes' | 'warnings' | 'requiresExtraConfirmation'> {
  return { statements: [], changes: [], warnings: [], requiresExtraConfirmation: false };
}

function appendPreview(
  output: Pick<PrivilegeDiffPlan, 'statements' | 'warnings' | 'requiresExtraConfirmation'>,
  preview: { statements: string[]; warnings: string[]; requiresExtraConfirmation: boolean },
): void {
  output.statements.push(...preview.statements);
  output.warnings.push(...preview.warnings);
  output.requiresExtraConfirmation ||= preview.requiresExtraConfirmation;
}

function diffRoleAttributes(current: RoleAttributes, desired: RoleAttributes): RoleAttributes {
  const patch: RoleAttributes = {};
  for (const key of ['login', 'superuser', 'createDb', 'createRole', 'inherit', 'replication', 'bypassRls'] as const) {
    const desiredValue = desired[key];
    if (desiredValue !== undefined && current[key] !== desiredValue) patch[key] = desiredValue;
  }
  return patch;
}

function explodePrivileges(items: ObjectPrivilegeSnapshot[]): ExplodedObjectPrivilege[] {
  return items.flatMap((item) =>
    item.privileges.map((privilege) => ({
      target: item.target,
      grantee: item.grantee,
      privilege,
      grantOption: Boolean(item.grantOption),
    })),
  );
}

function groupObjectPrivilegeDiff(items: ExplodedObjectPrivilege[]): Array<
  BuildGrantPrivilegesPreviewRequest & BuildRevokePrivilegesPreviewRequest
> {
  const grouped = new Map<string, BuildGrantPrivilegesPreviewRequest & BuildRevokePrivilegesPreviewRequest>();
  for (const item of items) {
    const key = `${targetKey(item.target)}|${item.grantee}|${item.grantOption}`;
    const existing =
      grouped.get(key) ??
      ({
        target: item.target,
        grantee: item.grantee,
        privileges: [],
        grantOption: item.grantOption,
      } as BuildGrantPrivilegesPreviewRequest & BuildRevokePrivilegesPreviewRequest);
    existing.privileges.push(item.privilege);
    grouped.set(key, existing);
  }
  return [...grouped.values()];
}

function membershipKey(item: RoleMembershipSnapshot): string {
  return `${item.role}|${item.member}`;
}

function objectPrivilegeKey(item: ExplodedObjectPrivilege): string {
  return `${targetKey(item.target)}|${item.grantee}|${item.privilege}|${item.grantOption}`;
}

function targetKey(target: PrivilegeTarget): string {
  return `${target.type}|${target.schema}|${target.name ?? ''}|${(target.signature ?? []).join(',')}`;
}
