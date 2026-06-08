import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialVault, type CredentialCipher } from './credential-vault.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('CredentialVault', () => {
  it('stores and restores passwords through safeStorage when encryption is available', async () => {
    const filePath = await tempCredentialPath();
    const cipher = createCipher(true);
    const vault = new CredentialVault(filePath, cipher);

    await vault.save('conn-prod', 'pg-secret');

    await expect(vault.load('conn-prod')).resolves.toBe('pg-secret');
    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('pg-secret');
    expect(JSON.parse(raw)).toEqual({
      'conn-prod': {
        encrypted: Buffer.from('cipher:pg-secret', 'utf8').toString('base64'),
        safeStorage: true,
      },
    });
  });

  it('uses base64 fallback when safeStorage is unavailable', async () => {
    const filePath = await tempCredentialPath();
    const vault = new CredentialVault(filePath, createCipher(false));

    await vault.save('conn-local', 'local-password');

    await expect(vault.load('conn-local')).resolves.toBe('local-password');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      'conn-local': {
        encrypted: Buffer.from('local-password', 'utf8').toString('base64'),
        safeStorage: false,
      },
    });
  });

  it('removes only the selected connection credential', async () => {
    const filePath = await tempCredentialPath();
    const vault = new CredentialVault(filePath, createCipher(true));

    await vault.save('conn-a', 'secret-a');
    await vault.save('conn-b', 'secret-b');
    await vault.remove('conn-a');

    await expect(vault.load('conn-a')).resolves.toBeUndefined();
    await expect(vault.load('conn-b')).resolves.toBe('secret-b');
  });

  it('treats a missing credential file as an empty vault', async () => {
    const filePath = join(await tempDir(), 'missing', 'credentials.json');
    const vault = new CredentialVault(filePath, createCipher(true));

    await expect(vault.load('unknown')).resolves.toBeUndefined();
    await expect(vault.remove('unknown')).resolves.toBeUndefined();
  });
});

async function tempCredentialPath(): Promise<string> {
  return join(await tempDir(), 'data', 'credentials.json');
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-credential-vault-'));
  tempDirs.push(dir);
  return dir;
}

function createCipher(available: boolean): CredentialCipher {
  return {
    isEncryptionAvailable() {
      return available;
    },
    encryptString(value) {
      return Buffer.from(`cipher:${value}`, 'utf8');
    },
    decryptString(value) {
      return value.toString('utf8').replace(/^cipher:/, '');
    },
  };
}
