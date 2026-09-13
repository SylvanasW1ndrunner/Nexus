import { createHash } from 'node:crypto';
import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'smol-toml';
import type { LlmGenerationConfig } from '@dbagent/core-llm';
import schema from './global-config.schema.json' with { type: 'json' };

const CONFIG_VERSION = 1 as const;
const CONFIG_MAX_BYTES = 512 * 1024;
const WATCH_DEBOUNCE_MS = 40;

export type GlobalSecretReference = { env: string } | { ref: string };
export type GlobalModelConnectionSettings = Readonly<{
  name?: string;
  endpoint: string;
  api_key?: string;
  api_key_env?: string;
  api_key_ref?: string;
  headers?: Readonly<Record<string, GlobalSecretReference>>;
}>;
export type GlobalConfigSettings = Readonly<{
  version: typeof CONFIG_VERSION;
  models: Readonly<{
    connections: readonly GlobalModelConnectionSettings[];
    parameters: Readonly<LlmGenerationConfig>;
  }>;
  agent: Readonly<{ permission_mode: 'default' | 'auto' | 'full-access'; require_sandbox: boolean }>;
  permissions: Readonly<{ rules: readonly GlobalPermissionRule[] }>;
}>;
export type GlobalPermissionRule = Readonly<{
  id: string;
  decision: 'allow' | 'ask' | 'deny';
  tools?: readonly string[];
  actions?: readonly string[];
  paths?: readonly string[];
  hosts?: readonly string[];
}>;
export type GlobalConfigDiagnostic = Readonly<{
  code:
    | 'schema_validation'
    | 'malformed_toml'
    | 'file_too_large'
    | 'unsupported_version';
  path: string;
  message: string;
}>;
export type GlobalConfigSnapshot = Readonly<{
  path: string;
  exists: boolean;
  revision: string;
  settings: GlobalConfigSettings;
  diagnostics: readonly GlobalConfigDiagnostic[];
}>;
export type ResolvedModelConnection = Readonly<{
  name?: string;
  endpoint: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
}>;
export type GlobalSecretResolver = (reference: string) => string | undefined;
export type GlobalConfigWatchOptions = Readonly<{
  /** Already-applied snapshot used as the comparison baseline. */
  initialSnapshot?: GlobalConfigSnapshot;
  /** Invalid edits and rejected listener applications remain observable and retryable. */
  onError?: (error: Error) => void | Promise<void>;
}>;

export class GlobalConfigValidationError extends Error {
  constructor(readonly diagnostics: readonly GlobalConfigDiagnostic[]) {
    super(
      `Invalid SchemaNaut global configuration: ${diagnostics.map((item) => `${item.path || '/'}: ${item.message}`).join('; ')}`,
    );
    this.name = 'GlobalConfigValidationError';
  }
}

export class GlobalConfigStore {
  readonly path: string;
  private readonly validateRoot: ValidateFunction;
  private latest: GlobalConfigSnapshot;

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? GlobalConfigStore.defaultPath();
    if (!this.path.trim()) throw new Error('Global config path must not be empty.');
    this.validateRoot = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    }).compile(schema);
    this.latest = createSnapshot(this.path, defaultSettings(), false);
  }

  static defaultPath(): string {
    return join(homedir(), '.schemanaut', 'config.toml');
  }

  async load(): Promise<GlobalConfigSnapshot> {
    try {
      const metadata = await stat(this.path);
      if (metadata.size > CONFIG_MAX_BYTES) {
        throw new GlobalConfigValidationError([
          {
            code: 'file_too_large',
            path: '',
            message: `config.toml exceeds the ${CONFIG_MAX_BYTES} byte limit.`,
          },
        ]);
      }
      const text = await readFile(this.path, 'utf8');
      let value: unknown;
      try {
        value = parse(text);
      } catch {
        throw new GlobalConfigValidationError([
          { code: 'malformed_toml', path: '', message: 'config.toml is not valid TOML.' },
        ]);
      }
      this.assertValid(value);
      this.latest = createSnapshot(this.path, normalizeSettings(value), true);
      return this.latest;
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        this.latest = createSnapshot(this.path, defaultSettings(), false);
        return this.latest;
      }
      throw error;
    }
  }

  async reload(): Promise<GlobalConfigSnapshot> {
    return this.load();
  }

  resolveModelConnections(
    environment: NodeJS.ProcessEnv = process.env,
    resolveReference?: GlobalSecretResolver,
    snapshot: GlobalConfigSnapshot = this.latest,
  ): readonly ResolvedModelConnection[] {
    return snapshot.settings.models.connections.map((connection) => {
      const apiKey =
        connection.api_key ??
        (connection.api_key_env === undefined
          ? connection.api_key_ref === undefined
            ? undefined
            : resolveRequiredReference(
                resolveReference,
                connection.api_key_ref,
                connection.name ?? connection.endpoint,
                'API key',
              )
          : environment[connection.api_key_env]);
      if (connection.api_key_env !== undefined && !apiKey?.trim()) {
        throw new Error(
          `Model connection ${connection.name ?? connection.endpoint} requires environment variable ${connection.api_key_env}; set it and retry.`,
        );
      }
      const headers =
        connection.headers === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(connection.headers).map(([name, reference]) => {
                if ('ref' in reference)
                  return [
                    name,
                    resolveRequiredReference(
                      resolveReference,
                      reference.ref,
                      connection.name ?? connection.endpoint,
                      `header ${name}`,
                    ),
                  ];
                const value = environment[reference.env];
                if (!value?.trim())
                  throw new Error(
                    `Model connection ${connection.name ?? connection.endpoint} requires environment variable ${reference.env} for header ${name}; set it and retry.`,
                  );
                return [name, value];
              }),
            );
      return Object.freeze({
        ...(connection.name === undefined ? {} : { name: connection.name }),
        endpoint: connection.endpoint,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers: Object.freeze(headers) }),
      });
    });
  }

  async watch(
    listener: (snapshot: GlobalConfigSnapshot) => void | Promise<void>,
    options: GlobalConfigWatchOptions = {},
  ): Promise<() => void> {
    let previous = options.initialSnapshot ?? await this.load();
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let deliveries = Promise.resolve();
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const deliverLatest = async (): Promise<void> => {
      if (closed) return;
      try {
        const current = await this.load();
        if (current.revision === previous.revision) return;
        await listener(current);
        previous = current;
      } catch (error) {
        await options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const enqueueReload = (): void => {
      deliveries = deliveries.catch(() => undefined).then(deliverLatest);
      void deliveries.catch(() => undefined);
    };
    const watcher: FSWatcher = watchFileSystem(directory, (_event, fileName) => {
      if (closed || (fileName !== null && fileName.toString() !== this.path.split(/[\\/]/).at(-1)))
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        enqueueReload();
      }, WATCH_DEBOUNCE_MS);
    });
    // The watcher is attached before reconciliation, so an edit between the
    // host's initial load and subscription is either observed here or queued.
    await deliverLatest();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  private assertValid(value: unknown): void {
    const diagnostics: GlobalConfigDiagnostic[] = [];
    if (!this.validateRoot(value)) diagnostics.push(...mapErrors(this.validateRoot.errors));
    if (isRecord(value) && value.version !== CONFIG_VERSION && typeof value.version === 'number')
      diagnostics.push({
        code: 'unsupported_version',
        path: '/version',
        message: `Unsupported config version ${value.version}. Expected ${CONFIG_VERSION}.`,
      });
    collectDuplicateRuleDiagnostics(value, diagnostics);
    if (diagnostics.length) throw new GlobalConfigValidationError(unique(diagnostics));
  }
}

function defaultSettings(): GlobalConfigSettings {
  return deepFreeze({
    version: 1,
    models: { connections: [], parameters: {} },
    agent: { permission_mode: 'default', require_sandbox: false },
    permissions: { rules: [] },
  });
}
function normalizeSettings(value: unknown): GlobalConfigSettings {
  const root = value as {
    version: 1;
    models?: { connections?: GlobalModelConnectionSettings[]; parameters?: LlmGenerationConfig };
    agent?: { permission_mode?: 'default' | 'auto' | 'full-access'; require_sandbox?: boolean };
    permissions?: { rules?: GlobalPermissionRule[] };
  };
  return deepFreeze({
    version: CONFIG_VERSION,
    models: {
      connections: root.models?.connections ?? [],
      parameters: root.models?.parameters ?? {},
    },
    agent: { permission_mode: root.agent?.permission_mode ?? 'default', require_sandbox: root.agent?.require_sandbox ?? false },
    permissions: { rules: root.permissions?.rules ?? [] },
  });
}
function createSnapshot(
  path: string,
  settings: GlobalConfigSettings,
  exists: boolean,
): GlobalConfigSnapshot {
  const immutable = deepFreeze(structuredClone(settings));
  return Object.freeze({
    path,
    exists,
    revision: `sha256:${createHash('sha256').update(canonicalJson(immutable)).digest('hex')}`,
    settings: immutable,
    diagnostics: Object.freeze([]),
  });
}
function collectDuplicateRuleDiagnostics(
  value: unknown,
  diagnostics: GlobalConfigDiagnostic[],
): void {
  if (!isRecord(value) || !isRecord(value.permissions) || !Array.isArray(value.permissions.rules))
    return;
  const seen = new Set<string>();
  value.permissions.rules.forEach((rule, index) => {
    if (!isRecord(rule) || typeof rule.id !== 'string' || !rule.id.trim()) return;
    if (seen.has(rule.id))
      diagnostics.push({
        code: 'schema_validation',
        path: `/permissions/rules/${index}/id`,
        message: `Permission rule id must be unique: ${rule.id}.`,
      });
    seen.add(rule.id);
  });
}
function mapErrors(errors: ErrorObject[] | null | undefined): GlobalConfigDiagnostic[] {
  return (errors ?? []).map((error) => {
    const additional =
      error.keyword === 'additionalProperties' &&
      typeof error.params.additionalProperty === 'string'
        ? `/${escapePointer(error.params.additionalProperty)}`
        : '';
    const missing =
      error.keyword === 'required' && typeof error.params.missingProperty === 'string'
        ? `/${escapePointer(error.params.missingProperty)}`
        : '';
    return {
      code: 'schema_validation',
      path: `${error.instancePath}${additional}${missing}`,
      message: error.message ?? 'Configuration does not satisfy its schema.',
    };
  });
}
function canonicalJson(value: unknown): string {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  throw new TypeError('Configuration must be JSON-compatible.');
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
function unique(diagnostics: GlobalConfigDiagnostic[]): GlobalConfigDiagnostic[] {
  return diagnostics.filter(
    (item, index, values) =>
      values.findIndex(
        (other) =>
          other.code === item.code && other.path === item.path && other.message === item.message,
      ) === index,
  );
}
function resolveRequiredReference(
  resolver: GlobalSecretResolver | undefined,
  reference: string,
  connection: string,
  field: string,
): string {
  const value = resolver?.(reference);
  if (!value?.trim()) {
    throw new Error(
      `Model connection ${connection} requires secure reference ${reference} for ${field}; make it available in the configured secret store and retry.`,
    );
  }
  return value;
}
