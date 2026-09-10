import { createHash, randomUUID } from 'node:crypto';
import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import {
  copyFile as copyFileAsync,
  mkdir as mkdirAsync,
  open as openAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  rm as rmAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { dirname, join, type PlatformPath } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import settingsSchema from './schemanaut-settings.schema.json' with { type: 'json' };

const SETTINGS_DIRECTORY = '.schemanaut';
const SETTINGS_FILE = 'settings.json';
const SETTINGS_VERSION = 1 as const;
const BACKUP_COUNT = 5;
const WATCH_DEBOUNCE_MS = 40;

export type SchemaNautMcpSecretReference = { ref: string };
export type SchemaNautMcpValue = string | SchemaNautMcpSecretReference;

export type SchemaNautMcpServerSettings = {
  name?: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  autoStart?: boolean;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, SchemaNautMcpValue>;
  headers?: Record<string, SchemaNautMcpValue>;
  description?: string;
  packageName?: string;
};

export type SchemaNautMcpSettings = {
  servers: Record<string, SchemaNautMcpServerSettings>;
};

export type SchemaNautProjectSettings = {
  version: typeof SETTINGS_VERSION;
  mcp?: SchemaNautMcpSettings;
};

export type ProjectSettingsDiagnosticCode =
  | 'schema_validation'
  | 'legacy_project_setting'
  | 'malformed_json'
  | 'unsupported_version';

export type ProjectSettingsDiagnostic = {
  code: ProjectSettingsDiagnosticCode;
  path: string;
  message: string;
  keyword?: string;
  moduleId?: string;
};

export type ProjectSettingsSnapshot = {
  path: string;
  settings: Readonly<SchemaNautProjectSettings>;
  exists: boolean;
  recoveredFromBackup: boolean;
  loadedAt: string;
  revision: string;
  diagnostics: readonly ProjectSettingsDiagnostic[];
};

export type ProjectSettingsPatch = {
  version?: typeof SETTINGS_VERSION;
  mcp?: SchemaNautMcpSettings;
};

export type ProjectSettingsChange = {
  previous: ProjectSettingsSnapshot;
  current: ProjectSettingsSnapshot;
};

export class ProjectSettingsValidationError extends Error {
  readonly diagnostics: readonly ProjectSettingsDiagnostic[];
  readonly settingsPath: string | undefined;

  constructor(diagnostics: readonly ProjectSettingsDiagnostic[], settingsPath?: string) {
    super(formatValidationMessage(diagnostics, settingsPath));
    this.name = 'ProjectSettingsValidationError';
    this.diagnostics = diagnostics;
    this.settingsPath = settingsPath;
  }
}

export class ProjectSettingsStore {
  readonly projectDirectory: string;
  readonly settingsPath: string;

  private readonly ajv: Ajv2020;
  private readonly validateRoot: ValidateFunction;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(projectDirectory: string) {
    if (!projectDirectory.trim()) throw new Error('projectDirectory must not be empty.');
    this.projectDirectory = projectDirectory;
    this.settingsPath = ProjectSettingsStore.resolveSettingsPath(projectDirectory);
    this.ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    this.validateRoot = this.ajv.compile(settingsSchema);
  }

  static resolveSettingsPath(
    projectDirectory: string,
    pathImplementation: Pick<PlatformPath, 'join'> = { join },
  ): string {
    return pathImplementation.join(projectDirectory, SETTINGS_DIRECTORY, SETTINGS_FILE);
  }

  validate(input: unknown): ProjectSettingsDiagnostic[] {
    const diagnostics: ProjectSettingsDiagnostic[] = [];
    if (!this.validateRoot(input)) {
      diagnostics.push(...mapAjvErrors(this.validateRoot.errors, 'schema_validation'));
    }
    if (!isRecord(input)) return diagnostics;

    if (input.version !== SETTINGS_VERSION && typeof input.version === 'number') {
      diagnostics.push({
        code: 'unsupported_version',
        path: '/version',
        message: `Unsupported settings version ${String(input.version)}. Expected ${SETTINGS_VERSION}.`,
      });
    }

    for (const legacyKey of ['llm', 'modules'])
      if (legacyKey in input)
        diagnostics.push({
          code: 'legacy_project_setting',
          path: `/${legacyKey}`,
          message:
            legacyKey === 'llm'
              ? 'Model configuration moved to ~/.schemanaut/config.toml; remove /llm from project settings.'
              : 'Capability module configuration is no longer supported; remove /modules from project settings.',
        });

    return uniqueDiagnostics(diagnostics);
  }

  async load(): Promise<ProjectSettingsSnapshot> {
    try {
      const text = await readFileAsync(this.settingsPath, 'utf8');
      return this.parseSnapshot(text, true, false, []);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT'))
        return createSnapshot(this.settingsPath, defaultSettings(), false);
      if (!(error instanceof SyntaxError)) throw error;
      return this.recoverMalformedSettings(error);
    }
  }

  async replace(settings: SchemaNautProjectSettings): Promise<ProjectSettingsSnapshot> {
    return this.enqueueWrite(async () => {
      const value = cloneValue(settings);
      this.assertValid(value);
      await this.atomicWrite(value);
      return createSnapshot(this.settingsPath, value, true);
    });
  }

  async patch(patch: ProjectSettingsPatch): Promise<ProjectSettingsSnapshot> {
    return this.enqueueWrite(async () => {
      const current = await this.load();
      const next = mergeSettings(current.settings, patch);
      this.assertValid(next);
      await this.atomicWrite(next);
      return createSnapshot(this.settingsPath, next, true);
    });
  }

  async replaceMcpServers(
    servers: Record<string, SchemaNautMcpServerSettings>,
  ): Promise<ProjectSettingsSnapshot> {
    return this.enqueueWrite(async () => {
      const current = await this.load();
      const next: SchemaNautProjectSettings = {
        ...cloneValue(current.settings),
        mcp: { servers: cloneValue(servers) },
      };
      this.assertValid(next);
      await this.atomicWrite(next);
      return createSnapshot(this.settingsPath, next, true);
    });
  }

  async watch(
    listener: (change: ProjectSettingsChange) => void | Promise<void>,
  ): Promise<() => void> {
    await mkdirAsync(dirname(this.settingsPath), { recursive: true });
    let previous = await this.load();
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let deliveries = Promise.resolve();
    const watcher: FSWatcher = watchFileSystem(dirname(this.settingsPath), (event, fileName) => {
      if (closed || (fileName !== null && fileName.toString() !== SETTINGS_FILE)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const deliver = async (): Promise<void> => {
          if (closed) return;
          const current = await this.load();
          if (closed || current.revision === previous.revision) return;
          const change = { previous, current };
          await listener(change);
          // A revision becomes accepted only after its consumer completes.
          // Saving the same content can then retry a failed MCP reconciliation
          // instead of being silently skipped.
          previous = current;
        };
        deliveries = deliveries.catch(() => undefined).then(deliver);
        // File-system callbacks are fire-and-forget; retain the rejected tail
        // for retry ordering while always observing it here.
        void deliveries.catch(() => undefined);
      }, WATCH_DEBOUNCE_MS);
    });
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  private parseSnapshot(
    text: string,
    exists: boolean,
    recoveredFromBackup: boolean,
    diagnostics: readonly ProjectSettingsDiagnostic[],
  ): ProjectSettingsSnapshot {
    const value = JSON.parse(text) as unknown;
    this.assertValid(value);
    return createSnapshot(this.settingsPath, value, exists, recoveredFromBackup, diagnostics);
  }

  private assertValid(value: unknown): asserts value is SchemaNautProjectSettings {
    const diagnostics = this.validate(value);
    if (diagnostics.length > 0) {
      throw new ProjectSettingsValidationError(diagnostics, this.settingsPath);
    }
  }

  private async recoverMalformedSettings(
    parseError: SyntaxError,
  ): Promise<ProjectSettingsSnapshot> {
    const diagnostic: ProjectSettingsDiagnostic = {
      code: 'malformed_json',
      path: '',
      message: `settings.json is not valid JSON: ${parseError.message}`,
    };
    for (let index = 0; index < BACKUP_COUNT; index += 1) {
      const backupPath = backupFilePath(this.settingsPath, index);
      try {
        const text = await readFileAsync(backupPath, 'utf8');
        const snapshot = this.parseSnapshot(text, true, true, [diagnostic]);
        const quarantinePath = `${this.settingsPath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
        await renameAsync(this.settingsPath, quarantinePath);
        const temporaryPath = this.temporaryPath();
        await copyFileAsync(backupPath, temporaryPath);
        await renameAsync(temporaryPath, this.settingsPath);
        return snapshot;
      } catch (error) {
        if (
          isFileSystemError(error, 'ENOENT') ||
          error instanceof SyntaxError ||
          error instanceof ProjectSettingsValidationError
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ProjectSettingsValidationError([diagnostic], this.settingsPath);
  }

  private async atomicWrite(settings: SchemaNautProjectSettings): Promise<void> {
    const directory = dirname(this.settingsPath);
    await mkdirAsync(directory, { recursive: true });
    const temporaryPath = this.temporaryPath();
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    const handle = await openAsync(temporaryPath, 'wx');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    let movedCurrent = false;
    try {
      await rotateBackups(this.settingsPath);
      if (await pathExists(this.settingsPath)) {
        await renameAsync(this.settingsPath, backupFilePath(this.settingsPath, 0));
        movedCurrent = true;
      }
      await renameAsync(temporaryPath, this.settingsPath);
      await syncDirectory(directory);
    } catch (error) {
      await rmAsync(temporaryPath, { force: true }).catch(() => undefined);
      if (movedCurrent && !(await pathExists(this.settingsPath))) {
        await renameAsync(backupFilePath(this.settingsPath, 0), this.settingsPath).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  private temporaryPath(): string {
    return join(dirname(this.settingsPath), `.${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function defaultSettings(): SchemaNautProjectSettings {
  return {
    version: SETTINGS_VERSION,
    mcp: { servers: {} },
  };
}

function createSnapshot(
  path: string,
  settings: SchemaNautProjectSettings,
  exists: boolean,
  recoveredFromBackup = false,
  diagnostics: readonly ProjectSettingsDiagnostic[] = [],
): ProjectSettingsSnapshot {
  const cloned = cloneValue(settings);
  const serialized = JSON.stringify(cloned);
  return Object.freeze({
    path,
    settings: deepFreeze(cloned),
    exists,
    recoveredFromBackup,
    loadedAt: new Date().toISOString(),
    revision: createHash('sha256').update(serialized).digest('hex'),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
  });
}

function mergeSettings(
  current: SchemaNautProjectSettings,
  patch: ProjectSettingsPatch,
): SchemaNautProjectSettings {
  return deepMerge(current, patch) as SchemaNautProjectSettings;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return cloneValue(patch);
  const result: Record<string, unknown> = cloneValue(base);
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key];
    result[key] =
      isRecord(previous) && isRecord(value) ? deepMerge(previous, value) : cloneValue(value);
  }
  return result;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function mapAjvErrors(
  errors: ErrorObject[] | null | undefined,
  code: 'schema_validation',
  prefix = '',
  moduleId?: string,
): ProjectSettingsDiagnostic[] {
  return (errors ?? []).map((error) => {
    const additionalProperty =
      error.keyword === 'additionalProperties' &&
      typeof error.params.additionalProperty === 'string'
        ? `/${escapeJsonPointer(error.params.additionalProperty)}`
        : '';
    const missingProperty =
      error.keyword === 'required' && typeof error.params.missingProperty === 'string'
        ? `/${escapeJsonPointer(error.params.missingProperty)}`
        : '';
    const path = `${prefix}${error.instancePath}${additionalProperty}${missingProperty}`;
    return {
      code,
      path,
      keyword: error.keyword,
      message: error.message ?? 'Configuration does not satisfy its schema.',
      ...(moduleId === undefined ? {} : { moduleId }),
    };
  });
}

function uniqueDiagnostics(
  diagnostics: readonly ProjectSettingsDiagnostic[],
): ProjectSettingsDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatValidationMessage(
  diagnostics: readonly ProjectSettingsDiagnostic[],
  settingsPath?: string,
): string {
  const details = diagnostics
    .slice(0, 8)
    .map((diagnostic) => `${diagnostic.path || '/'}: ${diagnostic.message}`)
    .join('; ');
  const location = settingsPath ? ` at ${settingsPath}` : '';
  return `Invalid SchemaNaut project settings${location}${details ? `: ${details}` : '.'}`;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function backupFilePath(settingsPath: string, index: number): string {
  return index === 0 ? `${settingsPath}.bak` : `${settingsPath}.bak.${index}`;
}

async function rotateBackups(settingsPath: string): Promise<void> {
  await rmAsync(backupFilePath(settingsPath, BACKUP_COUNT - 1), { force: true });
  for (let index = BACKUP_COUNT - 2; index >= 0; index -= 1) {
    const source = backupFilePath(settingsPath, index);
    if (!(await pathExists(source))) continue;
    await renameAsync(source, backupFilePath(settingsPath, index + 1));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await statAsync(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await openAsync(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems. The file itself
    // has already been synced and atomically placed, so this is best-effort only.
  }
}
