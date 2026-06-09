import { Pool, type PoolConfig } from 'pg';
import type { AuthAccount, AuthCodeRecord, AuthRepository } from './auth-service.js';

export class PostgresAuthRepository implements AuthRepository {
  private readonly pool: Pool;
  private initialized = false;

  constructor(config: PoolConfig | string) {
    this.pool = typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config);
  }

  async findAccountByIdentifier(identifier: string): Promise<AuthAccount | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<AuthAccountRow>(
      `select id, email, phone, password_hash, plan, created_at, updated_at
       from dbagent_auth_accounts
       where lower(email) = lower($1) or phone = $1
       limit 1`,
      [identifier],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
  }

  async createAccount(account: AuthAccount): Promise<AuthAccount> {
    await this.ensureInitialized();
    const result = await this.pool.query<AuthAccountRow>(
      `insert into dbagent_auth_accounts (id, email, phone, password_hash, plan, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, email, phone, password_hash, plan, created_at, updated_at`,
      [
        account.id,
        account.email ?? null,
        account.phone ?? null,
        account.passwordHash,
        account.plan,
        account.createdAt,
        account.updatedAt,
      ],
    );
    return mapAccount(result.rows[0]!);
  }

  async updatePassword(identifier: string, passwordHash: string): Promise<AuthAccount | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<AuthAccountRow>(
      `update dbagent_auth_accounts
       set password_hash = $2, updated_at = now()
       where lower(email) = lower($1) or phone = $1
       returning id, email, phone, password_hash, plan, created_at, updated_at`,
      [identifier, passwordHash],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
  }

  async upsertCode(record: AuthCodeRecord): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(
      `insert into dbagent_auth_codes (target, channel, purpose, code_hash, expires_at, created_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (target, channel, purpose)
       do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_at = now()`,
      [record.target, record.channel, record.purpose, record.codeHash, record.expiresAt],
    );
  }

  async consumeCode(input: {
    target: string;
    channel: AuthCodeRecord['channel'];
    purpose: AuthCodeRecord['purpose'];
    codeHash: string;
    now: Date;
  }): Promise<AuthCodeRecord | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<AuthCodeRow>(
      `delete from dbagent_auth_codes
       where target = $1 and channel = $2 and purpose = $3 and code_hash = $4 and expires_at > $5
       returning target, channel, purpose, code_hash, expires_at`,
      [input.target, input.channel, input.purpose, input.codeHash, input.now.toISOString()],
    );
    const row = result.rows[0];
    return row
      ? {
          target: row.target,
          channel: row.channel,
          purpose: row.purpose,
          codeHash: row.code_hash,
          expiresAt: toIso(row.expires_at),
        }
      : undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      create table if not exists dbagent_auth_accounts (
        id text primary key,
        email text unique,
        phone text unique,
        password_hash text not null,
        plan text not null check (plan in ('free', 'pro', 'team')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (email is not null or phone is not null)
      );

      create table if not exists dbagent_auth_codes (
        target text not null,
        channel text not null check (channel in ('email', 'phone')),
        purpose text not null check (purpose in ('register', 'login', 'reset-password')),
        code_hash text not null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        primary key (target, channel, purpose)
      );
    `);
    this.initialized = true;
  }
}

type AuthAccountRow = {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  plan: 'free' | 'pro' | 'team';
  created_at: Date | string;
  updated_at: Date | string;
};

type AuthCodeRow = {
  target: string;
  channel: 'email' | 'phone';
  purpose: 'register' | 'login' | 'reset-password';
  code_hash: string;
  expires_at: Date | string;
};

function mapAccount(row: AuthAccountRow): AuthAccount {
  return {
    id: row.id,
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    passwordHash: row.password_hash,
    plan: row.plan,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
