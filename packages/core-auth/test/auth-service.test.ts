import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService, type AuthAccount, type AuthCodeRecord, type AuthRepository } from '../src/auth-service.js';

const tempDirs: string[] = [];

async function sessionPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-auth-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'session.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AuthService', () => {
  it('reports unauthenticated when the session file is missing', async () => {
    const service = new AuthService(await sessionPath(), new MemoryAuthRepository());

    await expect(service.status()).resolves.toEqual({ authenticated: false });
  });

  it('registers an email account after verification and persists the session', async () => {
    const path = await sessionPath();
    const repository = new MemoryAuthRepository();
    const service = new AuthService(path, repository);
    const code = await service.requestCode({ target: 'Analyst@Example.com', channel: 'email', purpose: 'register' });

    const status = await service.register({
      email: 'Analyst@Example.com',
      password: 'password-123',
      verificationCode: code.devCode!,
    });

    expect(status.authenticated).toBe(true);
    expect(status.user?.email).toBe('analyst@example.com');
    await expect(service.status()).resolves.toEqual(status);
    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(status, null, 2)}\n`);
  });

  it('logs in with password and with a phone verification code', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(await sessionPath(), repository);
    const registerCode = await service.requestCode({ target: '+8613800000000', channel: 'phone', purpose: 'register' });
    await service.register({ phone: '+8613800000000', password: 'password-123', verificationCode: registerCode.devCode! });

    await expect(service.login('+8613800000000', 'password-123')).resolves.toMatchObject({ authenticated: true });

    const loginCode = await service.requestCode({ target: '+8613800000000', channel: 'phone', purpose: 'login' });
    await expect(
      service.verifyCodeLogin({ target: '+8613800000000', channel: 'phone', verificationCode: loginCode.devCode! }),
    ).resolves.toMatchObject({ authenticated: true });
  });

  it('resets a password with email verification code', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(await sessionPath(), repository);
    const registerCode = await service.requestCode({ target: 'user@example.com', channel: 'email', purpose: 'register' });
    await service.register({ email: 'user@example.com', password: 'old-password', verificationCode: registerCode.devCode! });

    const resetCode = await service.requestCode({ target: 'user@example.com', channel: 'email', purpose: 'reset-password' });
    await service.resetPassword({
      target: 'user@example.com',
      channel: 'email',
      verificationCode: resetCode.devCode!,
      newPassword: 'new-password',
    });

    await expect(service.login('user@example.com', 'old-password')).rejects.toThrow(/invalid/i);
    await expect(service.login('user@example.com', 'new-password')).resolves.toMatchObject({ authenticated: true });
  });

  it('overwrites an authenticated session on logout', async () => {
    const service = new AuthService(await sessionPath(), new MemoryAuthRepository());

    await expect(service.logout()).resolves.toEqual({ authenticated: false });
    await expect(service.status()).resolves.toEqual({ authenticated: false });
  });

  it('surfaces corrupt session JSON instead of silently resetting auth', async () => {
    const path = await sessionPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{bad json', 'utf8');

    await expect(new AuthService(path, new MemoryAuthRepository()).status()).rejects.toThrow(SyntaxError);
  });
});

class MemoryAuthRepository implements AuthRepository {
  private readonly accounts = new Map<string, AuthAccount>();
  private readonly codes = new Map<string, AuthCodeRecord>();

  findAccountByIdentifier(identifier: string): Promise<AuthAccount | undefined> {
    return Promise.resolve([...this.accounts.values()].find((account) => account.email === identifier || account.phone === identifier));
  }

  createAccount(account: AuthAccount): Promise<AuthAccount> {
    this.accounts.set(account.id, account);
    return Promise.resolve(account);
  }

  async updatePassword(identifier: string, passwordHash: string): Promise<AuthAccount | undefined> {
    const account = await this.findAccountByIdentifier(identifier);
    if (!account) return undefined;
    const updated = { ...account, passwordHash, updatedAt: new Date().toISOString() };
    this.accounts.set(updated.id, updated);
    return updated;
  }

  upsertCode(record: AuthCodeRecord): Promise<void> {
    this.codes.set(codeKey(record.target, record.channel, record.purpose), record);
    return Promise.resolve();
  }

  consumeCode(input: {
    target: string;
    channel: AuthCodeRecord['channel'];
    purpose: AuthCodeRecord['purpose'];
    codeHash: string;
    now: Date;
  }): Promise<AuthCodeRecord | undefined> {
    const key = codeKey(input.target, input.channel, input.purpose);
    const record = this.codes.get(key);
    if (!record || record.codeHash !== input.codeHash || new Date(record.expiresAt) <= input.now) return Promise.resolve(undefined);
    this.codes.delete(key);
    return Promise.resolve(record);
  }
}

function codeKey(target: string, channel: string, purpose: string): string {
  return `${target}:${channel}:${purpose}`;
}
