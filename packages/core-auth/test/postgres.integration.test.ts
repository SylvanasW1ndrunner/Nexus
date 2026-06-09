import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService, PostgresAuthRepository } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const databaseUrl = buildDatabaseUrl();
const tempDirs: string[] = [];
const touchedTargets: string[] = [];

afterEach(async () => {
  await cleanupAuthRows();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!runPostgresTests)('PostgresAuthRepository real PostgreSQL integration', () => {
  it('stores verified email accounts, password login, code login, and reset password in PostgreSQL', async () => {
    const repository = new PostgresAuthRepository(databaseUrl);
    const service = new AuthService(await sessionPath(), repository);
    const email = target(`analyst-${randomUUID()}@example.com`);

    try {
      const registerCode = await service.requestCode({ target: email, channel: 'email', purpose: 'register' });
      const registered = await service.register({
        email,
        password: 'password-123',
        verificationCode: registerCode.devCode!,
      });

      expect(registered.authenticated).toBe(true);
      expect(registered.user?.email).toBe(email);
      await expect(service.login(email.toUpperCase(), 'password-123')).resolves.toMatchObject({ authenticated: true });

      const loginCode = await service.requestCode({ target: email, channel: 'email', purpose: 'login' });
      await expect(service.verifyCodeLogin({ target: email, channel: 'email', verificationCode: loginCode.devCode! })).resolves.toMatchObject({
        authenticated: true,
      });

      const resetCode = await service.requestCode({ target: email, channel: 'email', purpose: 'reset-password' });
      await service.resetPassword({
        target: email,
        channel: 'email',
        verificationCode: resetCode.devCode!,
        newPassword: 'password-456',
      });

      await expect(service.login(email, 'password-123')).rejects.toThrow(/invalid/i);
      await expect(service.login(email, 'password-456')).resolves.toMatchObject({ authenticated: true });
    } finally {
      await repository.close();
    }
  });

  it('stores verified phone accounts and consumes verification codes once', async () => {
    const repository = new PostgresAuthRepository(databaseUrl);
    const service = new AuthService(await sessionPath(), repository);
    const phone = target(`+8613${Math.floor(100000000 + Math.random() * 899999999)}`);

    try {
      const registerCode = await service.requestCode({ target: phone, channel: 'phone', purpose: 'register' });
      await expect(
        service.register({ phone, password: 'password-123', verificationCode: registerCode.devCode! }),
      ).resolves.toMatchObject({ authenticated: true });

      await expect(
        service.register({ phone, password: 'password-123', verificationCode: registerCode.devCode! }),
      ).rejects.toThrow(/verification code/i);

      const loginCode = await service.requestCode({ target: phone, channel: 'phone', purpose: 'login' });
      await expect(service.verifyCodeLogin({ target: phone, channel: 'phone', verificationCode: loginCode.devCode! })).resolves.toMatchObject({
        authenticated: true,
      });
    } finally {
      await repository.close();
    }
  });
});

async function sessionPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-auth-pg-'));
  tempDirs.push(dir);
  return join(dir, 'session.json');
}

function target(value: string): string {
  touchedTargets.push(value.toLowerCase());
  return value.toLowerCase();
}

async function cleanupAuthRows(): Promise<void> {
  if (!runPostgresTests || touchedTargets.length === 0) return;
  const targets = touchedTargets.splice(0);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('delete from dbagent_auth_codes where target = any($1)', [targets]);
    await pool.query('delete from dbagent_auth_accounts where lower(email) = any($1) or phone = any($1)', [targets]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error;
  } finally {
    await pool.end();
  }
}

function buildDatabaseUrl(): string {
  if (process.env.DBAGENT_TEST_AUTH_DATABASE_URL) return process.env.DBAGENT_TEST_AUTH_DATABASE_URL;
  const host = process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1';
  const port = process.env.DBAGENT_TEST_PG_PORT ?? '5432';
  const database = process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_demo';
  const user = process.env.DBAGENT_TEST_PG_USER ?? 'postgres';
  const password = process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}
