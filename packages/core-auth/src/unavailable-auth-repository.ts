import type { AuthAccount, AuthCodeRecord, AuthRepository } from './auth-service.js';

export class UnavailableAuthRepository implements AuthRepository {
  constructor(private readonly reason = 'Authentication PostgreSQL database is not configured.') {}

  findAccountByIdentifier(): Promise<AuthAccount | undefined> {
    return Promise.reject(new Error(this.reason));
  }

  createAccount(): Promise<AuthAccount> {
    return Promise.reject(new Error(this.reason));
  }

  updatePassword(): Promise<AuthAccount | undefined> {
    return Promise.reject(new Error(this.reason));
  }

  upsertCode(): Promise<void> {
    return Promise.reject(new Error(this.reason));
  }

  consumeCode(): Promise<AuthCodeRecord | undefined> {
    return Promise.reject(new Error(this.reason));
  }
}
