import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CredentialCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type CredentialRecord = {
  encrypted: string;
  safeStorage: boolean;
};

export class CredentialVault {
  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher,
  ) {}

  async save(connectionId: string, password: string): Promise<void> {
    const credentials = await this.loadAll();
    const encrypted = this.cipher.isEncryptionAvailable()
      ? this.cipher.encryptString(password).toString('base64')
      : Buffer.from(password, 'utf8').toString('base64');
    credentials[connectionId] = {
      encrypted,
      safeStorage: this.cipher.isEncryptionAvailable(),
    };
    await this.saveAll(credentials);
  }

  async load(connectionId: string): Promise<string | undefined> {
    const credentials = await this.loadAll();
    const credential = credentials[connectionId];
    if (!credential) return undefined;
    const buffer = Buffer.from(credential.encrypted, 'base64');
    return credential.safeStorage ? this.cipher.decryptString(buffer) : buffer.toString('utf8');
  }

  async remove(connectionId: string): Promise<void> {
    const credentials = await this.loadAll();
    if (!(connectionId in credentials)) return;
    delete credentials[connectionId];
    await this.saveAll(credentials);
  }

  private async loadAll(): Promise<Record<string, CredentialRecord>> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, CredentialRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async saveAll(credentials: Record<string, CredentialRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}
