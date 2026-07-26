import { describe, expect, it } from 'vitest';
import {
  ContractValidationError,
  assertConnectionProfile,
  assertDatabaseAccessError,
  assertQuerySubmission,
  type ConnectionProfile,
} from '../src/index.js';

const time = '2026-07-23T00:00:00.000Z';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Analytics',
    connectorId: 'postgres-native',
    engine: 'postgres',
    endpoints: [
      {
        transport: 'tcp',
        host: '127.0.0.1',
        port: 5432,
        database: 'analytics',
      },
    ],
    credentialRef: {
      provider: 'environment',
      reference: 'DB_PASSWORD',
    },
    principal: 'readonly',
    purpose: 'read-only',
    readOnly: true,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}

describe('database public contracts', () => {
  it('accepts credential references and rejects embedded credential material', () => {
    expect(() => assertConnectionProfile(profile())).not.toThrow();
    expect(() =>
      assertConnectionProfile(
        profile({
          endpoints: [
            {
              transport: 'http',
              baseUrl: 'https://warehouse.example.com',
              headers: { 'x-client-version': '1.0' },
            },
          ],
        }),
      ),
    ).not.toThrow();
    expect(
      captureContractFailure(() =>
        assertConnectionProfile({
          ...profile(),
          password: 'do-not-return',
        }),
      ).issues[0],
    ).toMatchObject({ code: 'SECRET_MATERIAL' });
    expect(() => assertConnectionProfile(profile({ endpoints: [] }))).toThrowError(
      ContractValidationError,
    );
    expect(
      captureContractFailure(() =>
        assertConnectionProfile(
          profile({
            endpoints: [
              {
                transport: 'http',
                baseUrl: 'https://warehouse.example.com',
                headers: { Authorization: 'Bearer do-not-return-1234567890' },
              },
            ],
          }),
        ),
      ).issues[0],
    ).toMatchObject({
      code: 'SECRET_MATERIAL',
      path: '$.endpoints[0].headers.Authorization',
    });
  });

  it('validates an optional resource scope on connection profiles', () => {
    expect(() =>
      assertConnectionProfile(
        profile({
          scope: {
            tenantId: 'tenant-a',
            projectId: 'analytics',
            environment: 'production',
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertConnectionProfile({
        ...profile(),
        scope: { tenantId: 'tenant-a', unsupported: 'leak' },
      }),
    ).toThrowError(ContractValidationError);
    expect(() =>
      assertConnectionProfile({
        ...profile(),
        scope: { tenantId: '   ' },
      }),
    ).toThrowError(ContractValidationError);
  });

  it('validates query limits and native values at the public boundary', () => {
    expect(() =>
      assertQuerySubmission({
        profileId: 'profile-1',
        sql: 'select $1::bigint',
        params: [9_007_199_254_740_993n, new Date(time), Uint8Array.from([1, 2])],
        timeoutMs: 1_000,
        rowLimit: 100,
        authorization: {
          actorId: 'operator-1',
          approvalId: 'approval-1',
          permissionMode: 'read',
        },
      }),
    ).not.toThrow();
    for (const invalid of [
      { profileId: 'profile-1', sql: '', timeoutMs: 1000 },
      { profileId: 'profile-1', sql: 'select 1', timeoutMs: 0 },
      { profileId: 'profile-1', sql: 'select 1', maximumCost: -1 },
      { profileId: 'profile-1', sql: 'select 1', params: [Number.NaN] },
    ]) {
      expect(() => assertQuerySubmission(invalid)).toThrowError(ContractValidationError);
    }
  });

  it('keeps stable database error semantics and strips secret-bearing errors', () => {
    expect(() =>
      assertDatabaseAccessError({
        code: 'QUERY_TIMEOUT',
        category: 'timeout',
        message: 'Query timed out.',
        stage: 'execute',
        retryable: true,
        outcome: 'unchanged',
        recovery: 'Increase the bounded timeout.',
      }),
    ).not.toThrow();
    expect(() =>
      assertDatabaseAccessError({
        code: 'QUERY_FAILED',
        category: 'unexpected',
        message: 'failed',
        retryable: false,
        outcome: 'unknown',
      }),
    ).toThrowError(ContractValidationError);
    expect(
      captureContractFailure(() =>
        assertDatabaseAccessError({
          code: 'QUERY_FAILED',
          category: 'provider',
          message: 'postgres://admin:do-not-return@localhost/app',
          retryable: false,
          outcome: 'unknown',
        }),
      ).issues[0],
    ).toMatchObject({ code: 'SECRET_MATERIAL' });
  });
});

function captureContractFailure(operation: () => void): ContractValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ContractValidationError) return error;
    throw error;
  }
  throw new Error('Expected ContractValidationError');
}
