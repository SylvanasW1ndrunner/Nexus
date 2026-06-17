import { describe, expect, it } from 'vitest';
import { buildPrivilegeDiffPlan } from '../src/index.js';

describe('privilege snapshot diff planner', () => {
  it('builds a reviewable plan from current privileges to desired privileges', () => {
    const current = {
      capturedAt: '2026-06-18T00:00:00.000Z',
      roles: [{ role: 'app_user', attributes: { login: true, superuser: false } }],
      memberships: [{ role: 'readonly', member: 'app_user' }],
      objectPrivileges: [
        {
          target: { type: 'table' as const, schema: 'public', name: 'orders' },
          grantee: 'app_user',
          privileges: ['select' as const, 'delete' as const],
        },
      ],
    };
    const desired = {
      capturedAt: '2026-06-18T00:01:00.000Z',
      roles: [{ role: 'app_user', attributes: { login: true, superuser: false, createDb: true } }],
      memberships: [{ role: 'writer', member: 'app_user', adminOption: true }],
      objectPrivileges: [
        {
          target: { type: 'table' as const, schema: 'public', name: 'orders' },
          grantee: 'app_user',
          privileges: ['select' as const, 'insert' as const, 'update' as const],
        },
      ],
    };

    const plan = buildPrivilegeDiffPlan({ current, desired });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.preChangeSnapshot).toBe(current);
    expect(plan.data.requiresConfirmation).toBe(true);
    expect(plan.data.requiresExtraConfirmation).toBe(true);
    expect(plan.data.statements).toEqual([
      'alter role "app_user" with createdb;',
      'grant "writer" to "app_user" with admin option;',
      'revoke "readonly" from "app_user";',
      'grant INSERT, UPDATE on table "public"."orders" to "app_user";',
      'revoke DELETE on table "public"."orders" from "app_user";',
    ]);
    expect(plan.data.changes.map((change) => change.kind)).toEqual([
      'alter_role',
      'grant_role',
      'revoke_role',
      'grant_privileges',
      'revoke_privileges',
    ]);
    expect(plan.data.warnings).toContain('Current privilege snapshot must be persisted before executing this plan.');
    expect(plan.data.warnings).toContain('Role membership WITH ADMIN OPTION requires extra review.');
  });

  it('returns an empty no-op plan when snapshots already match', () => {
    const snapshot = {
      capturedAt: '2026-06-18T00:00:00.000Z',
      roles: [{ role: 'readonly', attributes: { login: false, inherit: true } }],
      memberships: [{ role: 'readonly', member: 'app_user' }],
      objectPrivileges: [
        {
          target: { type: 'schema' as const, schema: 'public' },
          grantee: 'readonly',
          privileges: ['usage' as const],
        },
      ],
    };

    const plan = buildPrivilegeDiffPlan({ current: snapshot, desired: snapshot });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.requiresConfirmation).toBe(false);
    expect(plan.data.requiresExtraConfirmation).toBe(false);
    expect(plan.data.statements).toEqual([]);
    expect(plan.data.changes).toEqual([]);
    expect(plan.data.warnings).toEqual(['Current privilege snapshot must be persisted before executing this plan.']);
  });

  it('groups object privilege grants by target, grantee, and grant option', () => {
    const plan = buildPrivilegeDiffPlan({
      current: { capturedAt: 'now', objectPrivileges: [] },
      desired: {
        capturedAt: 'later',
        objectPrivileges: [
          {
            target: { type: 'table' as const, schema: 'public', name: 'orders' },
            grantee: 'analyst',
            privileges: ['select' as const, 'insert' as const],
          },
          {
            target: { type: 'table' as const, schema: 'public', name: 'orders' },
            grantee: 'analyst',
            privileges: ['update' as const],
          },
        ],
      },
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.statements).toEqual([
      'grant SELECT, INSERT, UPDATE on table "public"."orders" to "analyst";',
    ]);
  });

  it('propagates validation errors from generated previews', () => {
    const plan = buildPrivilegeDiffPlan({
      current: { capturedAt: 'now' },
      desired: {
        capturedAt: 'later',
        objectPrivileges: [
          {
            target: { type: 'schema' as const, schema: 'public' },
            grantee: 'analyst',
            privileges: ['select' as const],
          },
        ],
      },
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'SELECT is not valid for schema privileges.',
      });
    }
  });
});
