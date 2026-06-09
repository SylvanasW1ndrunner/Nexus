import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthService,
  hashSecret,
  verifyPassword,
  type AuthAccount,
  type AuthCodeRecord,
  type AuthRepository,
} from '../src/auth-service.js';

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
    const account = await repository.findAccountByIdentifier('analyst@example.com');
    expect(account?.passwordHash.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(account?.passwordHash).not.toBe(hashSecret('password-123'));
    expect(verifyPassword('password-123', account!.passwordHash)).toBe(true);
    await expect(service.status()).resolves.toEqual(status);
    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(status, null, 2)}\n`);
  });

  it('logs in with password and with a phone verification code', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(await sessionPath(), repository);
    const registerCode = await service.requestCode({ target: '+86 138-0000-0000', channel: 'phone', purpose: 'register' });
    await service.register({ phone: '+86 138-0000-0000', password: 'password-123', verificationCode: registerCode.devCode! });

    await expect(service.login('+86 138-0000-0000', 'password-123')).resolves.toMatchObject({ authenticated: true });

    const account = await repository.findAccountByIdentifier('+8613800000000');
    expect(account?.phone).toBe('+8613800000000');

    const loginCode = await service.requestCode({ target: '+86 138 0000 0000', channel: 'phone', purpose: 'login' });
    await expect(
      service.verifyCodeLogin({ target: '+86-138-0000-0000', channel: 'phone', verificationCode: loginCode.devCode! }),
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

  it('rejects verification codes when the target does not match the channel', async () => {
    const service = new AuthService(await sessionPath(), new MemoryAuthRepository());

    await expect(
      service.requestCode({ target: 'not-an-email', channel: 'email', purpose: 'register' }),
    ).rejects.toThrow(/email/i);
    await expect(
      service.requestCode({ target: 'analyst@example.com', channel: 'phone', purpose: 'login' }),
    ).rejects.toThrow(/phone/i);
  });

  it('requires registration to use exactly one verified identifier type', async () => {
    const service = new AuthService(await sessionPath(), new MemoryAuthRepository());
    const code = await service.requestCode({ target: 'analyst@example.com', channel: 'email', purpose: 'register' });

    await expect(
      service.register({
        email: 'analyst@example.com',
        phone: '+8613800000000',
        password: 'password-123',
        verificationCode: code.devCode!,
      }),
    ).rejects.toThrow(/either email or phone/i);
  });

  it('checks account existence before issuing purpose-specific verification codes', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(await sessionPath(), repository);

    await expect(
      service.requestCode({ target: 'missing@example.com', channel: 'email', purpose: 'login' }),
    ).rejects.toThrow(/does not exist/i);
    await expect(
      service.requestCode({ target: 'missing@example.com', channel: 'email', purpose: 'reset-password' }),
    ).rejects.toThrow(/does not exist/i);

    const registerCode = await service.requestCode({ target: 'exists@example.com', channel: 'email', purpose: 'register' });
    await service.register({ email: 'exists@example.com', password: 'password-123', verificationCode: registerCode.devCode! });

    await expect(
      service.requestCode({ target: 'exists@example.com', channel: 'email', purpose: 'register' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('accepts legacy sha256 password hashes and upgrades them after login', async () => {
    const repository = new MemoryAuthRepository();
    const account: AuthAccount = {
      id: 'legacy-user',
      email: 'legacy@example.com',
      passwordHash: hashSecret('legacy-password'),
      plan: 'free',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repository.createAccount(account);
    const service = new AuthService(await sessionPath(), repository);

    await expect(service.login('legacy@example.com', 'legacy-password')).resolves.toMatchObject({ authenticated: true });

    const upgraded = await repository.findAccountByIdentifier('legacy@example.com');
    expect(upgraded?.passwordHash.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(upgraded?.passwordHash).not.toBe(account.passwordHash);
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
