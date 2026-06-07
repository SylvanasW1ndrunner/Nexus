import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';

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
    const service = new AuthService(await sessionPath());

    await expect(service.status()).resolves.toEqual({ authenticated: false });
  });

  it('persists a deterministic local user id on login', async () => {
    const path = await sessionPath();
    const service = new AuthService(path);

    const status = await service.login('Analyst@Example.com');

    expect(status).toEqual({
      authenticated: true,
      user: {
        id: 'local-YW5hbHlzdEBleGFtcGxlLmNvbQ',
        email: 'Analyst@Example.com',
        plan: 'free',
      },
    });
    await expect(service.status()).resolves.toEqual(status);
    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(status, null, 2)}\n`);
  });

  it('overwrites an authenticated session on logout', async () => {
    const path = await sessionPath();
    const service = new AuthService(path);
    await service.login('user@example.com');

    await expect(service.logout()).resolves.toEqual({ authenticated: false });
    await expect(service.status()).resolves.toEqual({ authenticated: false });
  });

  it('surfaces corrupt session JSON instead of silently resetting auth', async () => {
    const path = await sessionPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{bad json', 'utf8');

    await expect(new AuthService(path).status()).rejects.toThrow(SyntaxError);
  });
});
