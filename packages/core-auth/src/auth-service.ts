import { createHash, pbkdf2Sync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AuthCodeRequest,
  AuthCodeResponse,
  AuthRegisterRequest,
  AuthResetPasswordRequest,
  AuthStatus,
  AuthVerifyCodeLoginRequest,
} from '@dbagent/shared';

export type AuthAccount = {
  id: string;
  email?: string;
  phone?: string;
  passwordHash: string;
  plan: 'free' | 'pro' | 'team';
  createdAt: string;
  updatedAt: string;
};

export type AuthCodeRecord = AuthCodeRequest & {
  codeHash: string;
  expiresAt: string;
};

export interface AuthRepository {
  findAccountByIdentifier(identifier: string): Promise<AuthAccount | undefined>;
  createAccount(account: AuthAccount): Promise<AuthAccount>;
  updatePassword(identifier: string, passwordHash: string): Promise<AuthAccount | undefined>;
  upsertCode(record: AuthCodeRecord): Promise<void>;
  consumeCode(input: {
    target: string;
    channel: AuthCodeRequest['channel'];
    purpose: AuthCodeRequest['purpose'];
    codeHash: string;
    now: Date;
  }): Promise<AuthCodeRecord | undefined>;
}

export class AuthService {
  constructor(
    private readonly sessionPath: string,
    private readonly repository: AuthRepository,
  ) {}

  async status(): Promise<AuthStatus> {
    try {
      const raw = await readFile(this.sessionPath, 'utf8');
      return JSON.parse(raw) as AuthStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { authenticated: false };
      throw error;
    }
  }

  async login(identifier: string, password: string): Promise<AuthStatus> {
    const normalized = normalizeIdentifier(identifier);
    const account = await this.repository.findAccountByIdentifier(normalized);
    if (!account || !verifyPassword(password, account.passwordHash)) throw new Error('Invalid account or password.');
    if (shouldUpgradePasswordHash(account.passwordHash)) {
      await this.repository.updatePassword(normalized, hashPassword(password));
    }
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async register(request: AuthRegisterRequest): Promise<AuthStatus> {
    if (request.email && request.phone) throw new Error('Register with either email or phone, not both.');
    const target = normalizeIdentifier(request.email ?? request.phone);
    const channel = request.email ? 'email' : 'phone';
    if (!target) throw new Error('Email or phone is required.');
    validateVerificationTarget(target, channel);
    if (request.password.length < 8) throw new Error('Password must be at least 8 characters.');
    await this.verifyCode({ target, channel, purpose: 'register', verificationCode: request.verificationCode });
    const existing = await this.repository.findAccountByIdentifier(target);
    if (existing) throw new Error('Account already exists.');
    const now = new Date().toISOString();
    const account = await this.repository.createAccount({
      id: `local-${randomUUID()}`,
      ...(channel === 'email' ? { email: target } : { phone: target }),
      passwordHash: hashPassword(request.password),
      plan: 'free',
      createdAt: now,
      updatedAt: now,
    });
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async requestCode(request: AuthCodeRequest): Promise<AuthCodeResponse> {
    const target = normalizeIdentifier(request.target);
    if (!target) throw new Error('Verification target is required.');
    validateVerificationTarget(target, request.channel);
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await this.repository.upsertCode({
      ...request,
      target,
      codeHash: hashSecret(code),
      expiresAt,
    });
    return {
      target,
      channel: request.channel,
      expiresAt,
      devCode: code,
    };
  }

  async verifyCodeLogin(request: AuthVerifyCodeLoginRequest): Promise<AuthStatus> {
    const target = normalizeIdentifier(request.target);
    validateVerificationTarget(target, request.channel);
    await this.verifyCode({ ...request, target, purpose: 'login' });
    const account = await this.repository.findAccountByIdentifier(target);
    if (!account) throw new Error('Account does not exist.');
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async resetPassword(request: AuthResetPasswordRequest): Promise<AuthStatus> {
    const target = normalizeIdentifier(request.target);
    validateVerificationTarget(target, request.channel);
    if (request.newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    await this.verifyCode({ target, channel: request.channel, purpose: 'reset-password', verificationCode: request.verificationCode });
    const account = await this.repository.updatePassword(target, hashPassword(request.newPassword));
    if (!account) throw new Error('Account does not exist.');
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async logout(): Promise<AuthStatus> {
    const status: AuthStatus = { authenticated: false };
    await this.save(status);
    return status;
  }

  private async verifyCode(
    request: AuthVerifyCodeLoginRequest & { purpose: AuthCodeRequest['purpose'] },
  ): Promise<void> {
    const record = await this.repository.consumeCode({
      target: request.target,
      channel: request.channel,
      purpose: request.purpose,
      codeHash: hashSecret(request.verificationCode),
      now: new Date(),
    });
    if (!record) throw new Error('Invalid or expired verification code.');
  }

  private statusForAccount(account: AuthAccount): AuthStatus {
    return {
      authenticated: true,
      user: {
        id: account.id,
        email: account.email ?? '',
        ...(account.phone ? { phone: account.phone } : {}),
        plan: account.plan,
      },
    };
  }

  private async save(status: AuthStatus): Promise<void> {
    await mkdir(dirname(this.sessionPath), { recursive: true });
    await writeFile(this.sessionPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const iterations = 210_000;
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
  return `pbkdf2-sha256$${iterations}$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (isLegacySha256Hash(storedHash)) return hashSecret(password) === storedHash;
  const [algorithm, iterationsRaw, salt, hash] = storedHash.split('$');
  if (algorithm !== 'pbkdf2-sha256' || !iterationsRaw || !salt || !hash) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 100_000) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, 'sha256');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function shouldUpgradePasswordHash(storedHash: string): boolean {
  return isLegacySha256Hash(storedHash);
}

function isLegacySha256Hash(storedHash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(storedHash);
}

function normalizeIdentifier(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function validateVerificationTarget(target: string, channel: AuthCodeRequest['channel']): void {
  if (channel === 'email' && !isEmail(target)) throw new Error('A valid email address is required.');
  if (channel === 'phone' && !isPhone(target)) throw new Error('A valid phone number is required.');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPhone(value: string): boolean {
  return /^\+?[0-9][0-9\s-]{6,18}[0-9]$/.test(value);
}
