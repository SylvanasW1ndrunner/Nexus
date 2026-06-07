import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuthStatus } from '@dbagent/shared';

export class AuthService {
  constructor(private readonly sessionPath: string) {}

  async status(): Promise<AuthStatus> {
    try {
      const raw = await readFile(this.sessionPath, 'utf8');
      return JSON.parse(raw) as AuthStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { authenticated: false };
      throw error;
    }
  }

  async login(email: string): Promise<AuthStatus> {
    const status: AuthStatus = {
      authenticated: true,
      user: {
        id: stableUserId(email),
        email,
        plan: 'free',
      },
    };
    await this.save(status);
    return status;
  }

  async logout(): Promise<AuthStatus> {
    const status: AuthStatus = { authenticated: false };
    await this.save(status);
    return status;
  }

  private async save(status: AuthStatus): Promise<void> {
    await mkdir(dirname(this.sessionPath), { recursive: true });
    await writeFile(this.sessionPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }
}

function stableUserId(email: string): string {
  return `local-${Buffer.from(email.toLowerCase()).toString('base64url')}`;
}
