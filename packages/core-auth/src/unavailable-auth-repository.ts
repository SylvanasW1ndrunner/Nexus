import type { AuthAccount, AuthCodeRecord, AuthRepository } from './auth-service.js';

export class AuthDatabaseUnavailableError extends Error {
  constructor(message = 'Authentication PostgreSQL database is not configured.') {
    super(message);
    this.name = 'AuthDatabaseUnavailableError';
  }
}

export class UnavailableAuthRepository implements AuthRepository {
  constructor(private readonly reason = 'Authentication PostgreSQL database is not configured.') {}

  findAccountByIdentifier(): Promise<AuthAccount | undefined> {
    return Promise.reject(new AuthDatabaseUnavailableError(this.reason));
  }

  createAccount(): Promise<AuthAccount> {
    return Promise.reject(new AuthDatabaseUnavailableError(this.reason));
  }

  updatePassword(): Promise<AuthAccount | undefined> {
    return Promise.reject(new AuthDatabaseUnavailableError(this.reason));
  }

  upsertCode(): Promise<void> {
    return Promise.reject(new AuthDatabaseUnavailableError(this.reason));
  }

  consumeCode(): Promise<AuthCodeRecord | undefined> {
    return Promise.reject(new AuthDatabaseUnavailableError(this.reason));
  }
}
