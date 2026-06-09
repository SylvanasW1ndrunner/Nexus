import { createHash, randomInt, randomUUID } from 'node:crypto';
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
    if (!account || account.passwordHash !== hashSecret(password)) throw new Error('Invalid account or password.');
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async register(request: AuthRegisterRequest): Promise<AuthStatus> {
    const target = normalizeIdentifier(request.email ?? request.phone);
    const channel = request.email ? 'email' : 'phone';
    if (!target) throw new Error('Email or phone is required.');
    if (request.password.length < 8) throw new Error('Password must be at least 8 characters.');
    await this.verifyCode({ target, channel, purpose: 'register', verificationCode: request.verificationCode });
    const existing = await this.repository.findAccountByIdentifier(target);
    if (existing) throw new Error('Account already exists.');
    const now = new Date().toISOString();
    const account = await this.repository.createAccount({
      id: `local-${randomUUID()}`,
      ...(channel === 'email' ? { email: target } : { phone: target }),
      passwordHash: hashSecret(request.password),
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
    await this.verifyCode({ ...request, target, purpose: 'login' });
    const account = await this.repository.findAccountByIdentifier(target);
    if (!account) throw new Error('Account does not exist.');
    const status = this.statusForAccount(account);
    await this.save(status);
    return status;
  }

  async resetPassword(request: AuthResetPasswordRequest): Promise<AuthStatus> {
    const target = normalizeIdentifier(request.target);
    if (request.newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    await this.verifyCode({ target, channel: request.channel, purpose: 'reset-password', verificationCode: request.verificationCode });
    const account = await this.repository.updatePassword(target, hashSecret(request.newPassword));
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

function normalizeIdentifier(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}
