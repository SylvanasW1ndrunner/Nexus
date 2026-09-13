import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ContractValidationError,
  assertResourceRegistrySnapshot,
  type ResourceRegistrySnapshot,
} from '@dbagent/shared';

export interface ResourceSnapshotStore {
  load(): Promise<ResourceRegistrySnapshot | undefined>;
  save(snapshot: ResourceRegistrySnapshot): Promise<void>;
}

export class ResourceSnapshotStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SNAPSHOT_INVALID'
      | 'SNAPSHOT_READ_FAILED'
      | 'SNAPSHOT_WRITE_FAILED',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ResourceSnapshotStoreError';
  }
}

export class InMemoryResourceSnapshotStore implements ResourceSnapshotStore {
  #snapshot: ResourceRegistrySnapshot | undefined;

  constructor(initialSnapshot?: ResourceRegistrySnapshot) {
    if (initialSnapshot) {
      validateSnapshot(initialSnapshot);
      this.#snapshot = structuredClone(initialSnapshot);
    }
  }

  load(): Promise<ResourceRegistrySnapshot | undefined> {
    return Promise.resolve(
      this.#snapshot ? structuredClone(this.#snapshot) : undefined,
    );
  }

  save(snapshot: ResourceRegistrySnapshot): Promise<void> {
    validateSnapshot(snapshot);
    this.#snapshot = structuredClone(snapshot);
    return Promise.resolve();
  }

  clear(): void {
    this.#snapshot = undefined;
  }
}

export class JsonFileResourceSnapshotStore implements ResourceSnapshotStore {
  readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath.trim()) {
      throw new ResourceSnapshotStoreError(
        'Snapshot file path cannot be empty',
        'SNAPSHOT_INVALID',
      );
    }
    this.filePath = resolve(filePath);
  }

  async load(): Promise<ResourceRegistrySnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') return undefined;
      throw new ResourceSnapshotStoreError(
        'Unable to read the resource snapshot',
        'SNAPSHOT_READ_FAILED',
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
      assertResourceRegistrySnapshot(parsed);
    } catch (error) {
      throw new ResourceSnapshotStoreError(
        'Resource snapshot is invalid or uses an unsupported contract version',
        'SNAPSHOT_INVALID',
        { cause: error },
      );
    }
    return structuredClone(parsed);
  }

  async save(snapshot: ResourceRegistrySnapshot): Promise<void> {
    validateSnapshot(snapshot);
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(snapshot)}\n`,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      );
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      throw new ResourceSnapshotStoreError(
        'Unable to persist the resource snapshot atomically',
        'SNAPSHOT_WRITE_FAILED',
        { cause: error },
      );
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function validateSnapshot(snapshot: ResourceRegistrySnapshot): void {
  try {
    assertResourceRegistrySnapshot(snapshot);
  } catch (error) {
    if (error instanceof ResourceSnapshotStoreError) throw error;
    const detail =
      error instanceof ContractValidationError ? error.message : 'Invalid snapshot';
    throw new ResourceSnapshotStoreError(detail, 'SNAPSHOT_INVALID', {
      cause: error,
    });
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
