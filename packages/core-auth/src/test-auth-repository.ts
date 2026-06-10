import type { AuthAccount, AuthCodeRecord, AuthRepository } from './auth-service.js';
import { hashSecret } from './auth-service.js';

const testAccount: AuthAccount = {
  id: 'local-test-user',
  email: 'test',
  passwordHash: hashSecret('test'),
  plan: 'free',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export class TestAuthRepository implements AuthRepository {
  findAccountByIdentifier(identifier: string): Promise<AuthAccount | undefined> {
    return Promise.resolve(identifier.trim().toLowerCase() === 'test' ? testAccount : undefined);
  }

  createAccount(): Promise<AuthAccount> {
    return Promise.reject(new Error('Registration is not available in local test auth mode.'));
  }

  async updatePassword(identifier: string, passwordHash: string): Promise<AuthAccount | undefined> {
    const account = await this.findAccountByIdentifier(identifier);
    return account ? { ...account, passwordHash, updatedAt: new Date().toISOString() } : undefined;
  }

  upsertCode(): Promise<void> {
    return Promise.reject(new Error('Verification codes are not available in local test auth mode.'));
  }

  consumeCode(): Promise<AuthCodeRecord | undefined> {
    return Promise.resolve(undefined);
  }
}
