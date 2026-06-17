import { describe, expect, it } from 'vitest';
import {
  buildAlterRolePreview,
  buildCreateRolePreview,
  buildDropRolePreview,
  buildGrantPrivilegesPreview,
  buildGrantRoleMembershipPreview,
  buildRevokePrivilegesPreview,
  buildRevokeRoleMembershipPreview,
} from '../src/index.js';

describe('privilege management preview builder', () => {
  it('builds a create login role preview without embedding passwords', () => {
    const preview = buildCreateRolePreview({
      role: 'app_user',
      attributes: {
        login: true,
        superuser: false,
        createDb: false,
        createRole: false,
        inherit: true,
      },
      comment: "应用'账号",
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe(
      [
        'create role "app_user" with login nosuperuser nocreatedb nocreaterole inherit;',
        "comment on role \"app_user\" is '应用''账号';",
      ].join('\n'),
    );
    expect(preview.data.requiresConfirmation).toBe(true);
    expect(preview.data.requiresExtraConfirmation).toBe(false);
    expect(preview.data.sql.toLowerCase()).not.toContain('password');
  });

  it('marks dangerous role attributes for extra confirmation', () => {
    const preview = buildAlterRolePreview({
      role: 'analytics_admin',
      attributes: { superuser: true, replication: true, bypassRls: true },
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe('alter role "analytics_admin" with superuser replication bypassrls;');
    expect(preview.data.requiresExtraConfirmation).toBe(true);
    expect(preview.data.warnings).toEqual([
      'SUPERUSER bypasses nearly all PostgreSQL permission checks and requires extra confirmation.',
      'REPLICATION role can access replication streams and requires extra confirmation.',
      'BYPASSRLS bypasses row level security and requires extra confirmation.',
    ]);
  });

  it('builds role membership grant and revoke previews', () => {
    const grant = buildGrantRoleMembershipPreview({
      role: 'readonly',
      member: 'app_user',
      adminOption: true,
    });
    const revoke = buildRevokeRoleMembershipPreview({
      role: 'readonly',
      member: 'app_user',
      adminOptionOnly: true,
    });

    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.data.sql).toBe('grant "readonly" to "app_user" with admin option;');
    expect(grant.data.requiresExtraConfirmation).toBe(true);

    expect(revoke.ok).toBe(true);
    if (!revoke.ok) return;
    expect(revoke.data.sql).toBe('revoke admin option for "readonly" from "app_user";');
    expect(revoke.data.warnings).toEqual([
      'Revoking role membership can break application access and must be confirmed.',
    ]);
  });

  it('builds table grant and revoke previews with deduplicated privileges', () => {
    const grant = buildGrantPrivilegesPreview({
      target: { type: 'table', schema: 'public', name: 'orders' },
      grantee: 'app_user',
      privileges: ['select', 'insert', 'update', 'select'],
    });
    const revoke = buildRevokePrivilegesPreview({
      target: { type: 'table', schema: 'public', name: 'orders' },
      grantee: 'app_user',
      privileges: ['delete', 'truncate'],
      cascade: true,
    });

    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.data.sql).toBe('grant SELECT, INSERT, UPDATE on table "public"."orders" to "app_user";');

    expect(revoke.ok).toBe(true);
    if (!revoke.ok) return;
    expect(revoke.data.sql).toBe('revoke DELETE, TRUNCATE on table "public"."orders" from "app_user" cascade;');
  });

  it('builds schema and function privilege previews', () => {
    const schemaGrant = buildGrantPrivilegesPreview({
      target: { type: 'schema', schema: 'analytics' },
      grantee: 'analyst',
      privileges: ['usage', 'create'],
      grantOption: true,
    });
    const functionGrant = buildGrantPrivilegesPreview({
      target: { type: 'function', schema: 'public', name: 'get_user_stats', signature: ['bigint'] },
      grantee: 'analyst',
      privileges: ['execute'],
    });

    expect(schemaGrant.ok).toBe(true);
    if (!schemaGrant.ok) return;
    expect(schemaGrant.data.sql).toBe('grant USAGE, CREATE on schema "analytics" to "analyst" with grant option;');
    expect(schemaGrant.data.requiresExtraConfirmation).toBe(true);

    expect(functionGrant.ok).toBe(true);
    if (!functionGrant.ok) return;
    expect(functionGrant.data.sql).toBe('grant EXECUTE on function "public"."get_user_stats"(bigint) to "analyst";');
  });

  it('rejects invalid privilege combinations and unsafe identifiers before preview', () => {
    const invalidPrivilege = buildGrantPrivilegesPreview({
      target: { type: 'schema', schema: 'public' },
      grantee: 'app_user',
      privileges: ['select'],
    });
    const unsafeRole = buildCreateRolePreview({
      role: 'app_user; drop role postgres',
      attributes: { login: true },
    });
    const unsafeSignature = buildGrantPrivilegesPreview({
      target: { type: 'function', schema: 'public', name: 'get_user_stats', signature: ['bigint; drop table users'] },
      grantee: 'analyst',
      privileges: ['execute'],
    });

    expect(invalidPrivilege.ok).toBe(false);
    if (!invalidPrivilege.ok) {
      expect(invalidPrivilege.error.message).toBe('SELECT is not valid for schema privileges.');
    }
    expect(unsafeRole.ok).toBe(false);
    if (!unsafeRole.ok) {
      expect(unsafeRole.error.message).toBe('Role name contains unsafe SQL tokens.');
    }
    expect(unsafeSignature.ok).toBe(false);
    if (!unsafeSignature.ok) {
      expect(unsafeSignature.error.message).toBe('Routine signature type contains unsafe SQL tokens.');
    }
  });

  it('builds a destructive drop role preview with extra confirmation', () => {
    const preview = buildDropRolePreview({ role: 'old_app_user', ifExists: true });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe('drop role if exists "old_app_user";');
    expect(preview.data.requiresExtraConfirmation).toBe(true);
    expect(preview.data.warnings).toEqual(['Dropping a role can break database access and must be confirmed.']);
  });

  it('requires at least one role attribute or privilege', () => {
    const alter = buildAlterRolePreview({ role: 'app_user', attributes: {} });
    const grant = buildGrantPrivilegesPreview({
      target: { type: 'table', schema: 'public', name: 'orders' },
      grantee: 'app_user',
      privileges: [],
    });

    expect(alter.ok).toBe(false);
    if (!alter.ok) expect(alter.error.message).toBe('Alter role preview requires at least one attribute change.');
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.error.message).toBe('At least one privilege is required.');
  });
});
