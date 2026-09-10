import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const mutationTails = new Map<string, Promise<void>>();

export type McpTransport = 'stdio' | 'sse' | 'streamable-http';
export type McpServerSource = 'builtin' | 'imported' | 'user';
export type McpEnvValue = string | { ref: string };
export type McpHeaderValue = McpEnvValue;

export type McpServerConfig = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: McpTransport;
  autoStart: boolean;
  enabled: boolean;
  command?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  url?: string | undefined;
  env?: Record<string, McpEnvValue> | undefined;
  headers?: Record<string, McpHeaderValue> | undefined;
  description?: string | undefined;
  packageName?: string | undefined;
  installedAt: string;
  updatedAt: string;
};

export type McpServerInput = {
  id?: string;
  name: string;
  source?: McpServerSource;
  transport?: McpTransport;
  autoStart?: boolean;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, McpEnvValue>;
  headers?: Record<string, McpHeaderValue>;
  description?: string;
  packageName?: string;
};

export type McpConfigFile = {
  version: 1;
  servers: McpServerConfig[];
};

export type McpRemovedServer = {
  removed: boolean;
  server?: McpServerConfig;
  secretRefs: string[];
};

export type McpServerNormalizationOptions = {
  allowInsecureRemote?: boolean;
};

/** Minimal persistence contract required by the MCP process runtime. */
export type McpConfigRepository = {
  list(): Promise<McpServerConfig[]>;
};

export class McpConfigStore {
  constructor(
    private readonly filePath: string,
    private readonly options: {
      now?: () => string;
      createId?: () => string;
    } = {},
  ) {}

  async load(): Promise<McpConfigFile> {
    const existing = await this.readExisting();
    if (existing) return existing;
    return {
      version: 1,
      servers: [],
    };
  }

  async list(): Promise<McpServerConfig[]> {
    return (await this.load()).servers;
  }

  async upsert(input: McpServerInput): Promise<McpServerConfig> {
    return this.mutate(async () => {
      const file = await this.load();
      const index = file.servers.findIndex((server) => server.id === input.id);
      const now = this.clock();
      const current = index === -1 ? undefined : file.servers[index];
      const server = normalizeServerInput(mergeServerInput(current, input), now, this.createId());
      const nextServers = [...file.servers];
      if (index === -1) nextServers.push(server);
      else nextServers[index] = server;
      await this.save({ version: 1, servers: sortServers(nextServers) });
      return server;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined> {
    return this.mutate(async () => {
      const file = await this.load();
      const index = file.servers.findIndex((server) => server.id === id);
      if (index === -1) return undefined;
      const updated = { ...file.servers[index]!, enabled, updatedAt: this.clock() };
      file.servers[index] = updated;
      await this.save({ version: 1, servers: sortServers(file.servers) });
      return updated;
    });
  }

  async setAutoStart(id: string, autoStart: boolean): Promise<McpServerConfig | undefined> {
    return this.mutate(async () => {
      const file = await this.load();
      const index = file.servers.findIndex((server) => server.id === id);
      if (index === -1) return undefined;
      const updated = { ...file.servers[index]!, autoStart, updatedAt: this.clock() };
      file.servers[index] = updated;
      await this.save({ version: 1, servers: sortServers(file.servers) });
      return updated;
    });
  }

  async remove(id: string, options: { deleteSecrets?: boolean } = {}): Promise<McpRemovedServer> {
    return this.mutate(async () => {
      const file = await this.load();
      const server = file.servers.find((item) => item.id === id);
      if (!server) return { removed: false, secretRefs: [] };
      await this.save({
        version: 1,
        servers: sortServers(file.servers.filter((item) => item.id !== id)),
      });
      return {
        removed: true,
        server,
        secretRefs: options.deleteSecrets ? collectSecretRefs(server) : [],
      };
    });
  }

  private async readExisting(): Promise<McpConfigFile | undefined> {
    try {
      return normalizeConfigFile(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) {
        throw new Error('Invalid mcp.json: malformed JSON.', { cause: error });
      }
      throw error;
    }
  }

  private async save(file: McpConfigFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const key = normalizedFileKey(this.filePath);
    const previous = mutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    mutationTails.set(key, tail);
    void tail.then(() => {
      if (mutationTails.get(key) === tail) mutationTails.delete(key);
    });
    return result;
  }

  private clock(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private createId(): string {
    return this.options.createId?.() ?? randomUUID();
  }
}

export function normalizeConfigFile(input: unknown): McpConfigFile {
  if (!isRecord(input)) throw new Error('Invalid mcp.json: expected an object.');
  if (input.version !== 1) throw new Error('Invalid mcp.json: unsupported version.');
  if (!Array.isArray(input.servers)) throw new Error('Invalid mcp.json: servers must be an array.');
  const seen = new Set<string>();
  const servers = input.servers.map((server) => normalizeServerRecord(server));
  for (const server of servers) {
    if (seen.has(server.id)) throw new Error(`Invalid mcp.json: duplicate server id ${server.id}.`);
    seen.add(server.id);
  }
  return { version: 1, servers: sortServers(servers) };
}

export function normalizeServerInput(
  input: McpServerInput & Partial<Pick<McpServerConfig, 'installedAt'>>,
  now: string,
  fallbackId: string,
  options: McpServerNormalizationOptions = {},
): McpServerConfig {
  const id = normalizeId(input.id ?? fallbackId);
  const source = normalizeSource(input.source);
  const transport = normalizeTransport(input.transport);
  const base = normalizeServerBase(input, id, source, transport, now, input.installedAt, options);
  return normalizeServerByTransport(base, options);
}

function normalizeServerRecord(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error('Invalid mcp.json: server must be an object.');
  const id = normalizeId(input.id);
  const source = normalizeSource(input.source);
  const transport = normalizeTransport(input.transport);
  const installedAt =
    typeof input.installedAt === 'string' && input.installedAt
      ? input.installedAt
      : new Date(0).toISOString();
  const updatedAt =
    typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : installedAt;
  const base = normalizeServerBase(input, id, source, transport, updatedAt, installedAt, {});
  return normalizeServerByTransport(base);
}

function normalizeServerBase(
  input: McpServerInput | Record<string, unknown>,
  id: string,
  source: McpServerSource,
  transport: McpTransport,
  now: string,
  installedAt?: string,
  options: McpServerNormalizationOptions = {},
): McpServerConfig {
  if (typeof input.name !== 'string' || !input.name.trim())
    throw new Error('MCP server name is required.');
  return {
    id,
    name: input.name.trim(),
    source,
    transport,
    autoStart: input.autoStart === true,
    enabled: input.enabled !== false,
    ...(typeof input.command === 'string' && input.command.trim()
      ? { command: normalizeCommand(input.command, id, options) }
      : {}),
    ...(Array.isArray(input.args) ? { args: normalizeArgs(input.args, id, options) } : {}),
    ...(typeof input.cwd === 'string' && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(typeof input.url === 'string' && input.url.trim() ? { url: input.url.trim() } : {}),
    ...(isRecord(input.env) ? { env: normalizeEnv(input.env, id, options) } : {}),
    ...(isRecord(input.headers) ? { headers: normalizeHeaders(input.headers, id, options) } : {}),
    ...(typeof input.description === 'string' && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    ...(typeof input.packageName === 'string' && input.packageName.trim()
      ? { packageName: input.packageName.trim() }
      : {}),
    installedAt: installedAt ?? now,
    updatedAt: now,
  };
}

function normalizeServerByTransport(
  server: McpServerConfig,
  options: McpServerNormalizationOptions = {},
): McpServerConfig {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error(`MCP stdio server ${server.id} requires a command.`);
    const stdioServer = { ...server };
    delete stdioServer.url;
    delete stdioServer.headers;
    return stdioServer;
  }

  if (!server.url) throw new Error(`MCP ${server.transport} server ${server.id} requires a URL.`);
  validateRemoteUrl(server.url, server.id, options);
  const remoteServer = { ...server };
  delete remoteServer.command;
  delete remoteServer.args;
  delete remoteServer.cwd;
  delete remoteServer.env;
  return remoteServer;
}

function mergeServerInput(
  current: McpServerConfig | undefined,
  input: McpServerInput,
): McpServerInput & Partial<Pick<McpServerConfig, 'installedAt'>> {
  const merged: McpServerInput & Partial<Pick<McpServerConfig, 'installedAt'>> = {
    name: input.name ?? current?.name ?? '',
  };
  assignDefined(merged, 'id', input.id ?? current?.id);
  assignDefined(merged, 'source', input.source ?? current?.source);
  assignDefined(merged, 'transport', input.transport ?? current?.transport);
  assignDefined(merged, 'autoStart', input.autoStart ?? current?.autoStart);
  assignDefined(merged, 'enabled', input.enabled ?? current?.enabled);
  assignDefined(merged, 'command', input.command ?? current?.command);
  assignDefined(merged, 'args', input.args ?? current?.args);
  assignDefined(merged, 'cwd', input.cwd ?? current?.cwd);
  assignDefined(merged, 'url', input.url ?? current?.url);
  assignDefined(merged, 'env', input.env ?? current?.env);
  assignDefined(merged, 'headers', input.headers ?? current?.headers);
  assignDefined(merged, 'description', input.description ?? current?.description);
  assignDefined(merged, 'packageName', input.packageName ?? current?.packageName);
  assignDefined(merged, 'installedAt', current?.installedAt);
  return merged;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function normalizeEnv(
  env: Record<string, unknown>,
  serverId: string,
  options: McpServerNormalizationOptions,
): Record<string, McpEnvValue> {
  const output: Record<string, McpEnvValue> = {};
  for (const [rawName, rawValue] of Object.entries(env)) {
    const name = normalizeEnvName(rawName);
    if (typeof rawValue === 'string') {
      output[name] = rawValue;
      continue;
    }
    if (isRecord(rawValue) && typeof rawValue.ref === 'string' && rawValue.ref.trim()) {
      output[name] = { ref: rawValue.ref.trim() };
      continue;
    }
    throw new Error(`Invalid MCP env value for ${name}.`);
  }
  return output;
}

function collectSecretRefs(server: McpServerConfig): string[] {
  return [
    ...new Set(
      [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
        .filter(
          (value): value is { ref: string } => isRecord(value) && typeof value.ref === 'string',
        )
        .map((value) => value.ref),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('MCP server id is required.');
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized))
    throw new Error(`Invalid MCP server id: ${normalized}.`);
  return normalized;
}

function normalizeSource(value: unknown): McpServerSource {
  if (value === 'builtin') return value;
  if (value === 'imported') return value;
  return 'user';
}

function normalizeTransport(value: unknown): McpTransport {
  if (value === undefined || value === 'stdio') return 'stdio';
  if (value === 'sse' || value === 'streamable-http') return value;
  throw new Error(
    `Invalid MCP transport: ${typeof value === 'string' ? value : typeof value}.`,
  );
}

function normalizeEnvName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(normalized))
    throw new Error(`Invalid MCP env var name: ${value}.`);
  return normalized;
}

function normalizeHeaders(
  headers: Record<string, unknown>,
  serverId: string,
  options: McpServerNormalizationOptions,
): Record<string, McpHeaderValue> {
  const output: Record<string, McpHeaderValue> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = normalizeHeaderName(rawName);
    if (typeof rawValue === 'string') {
      output[name] = rawValue;
      continue;
    }
    if (isRecord(rawValue) && typeof rawValue.ref === 'string' && rawValue.ref.trim()) {
      output[name] = { ref: rawValue.ref.trim() };
      continue;
    }
    throw new Error(`Invalid MCP header value for ${name}.`);
  }
  return output;
}

function normalizeHeaderName(value: string): string {
  const normalized = value.trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(normalized)) {
    throw new Error(`Invalid MCP HTTP header name: ${value}.`);
  }
  return normalized;
}

function normalizeCommand(
  value: string,
  _serverId: string,
  _options: McpServerNormalizationOptions,
): string {
  return value.trim();
}

function normalizeArgs(
  values: unknown[],
  _serverId: string,
  _options: McpServerNormalizationOptions,
): string[] {
  return values.filter((value): value is string => typeof value === 'string');
}

function validateRemoteUrl(
  value: string,
  serverId: string,
  options: McpServerNormalizationOptions,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MCP server ${serverId} URL must use http or https.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP server ${serverId} URL must use http or https.`);
  }
  if (!options.allowInsecureRemote && url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(`MCP server ${serverId} must use HTTPS unless it targets loopback.`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const numbers = octets.map(Number);
  return numbers.every((octet) => octet >= 0 && octet <= 255) && numbers[0] === 127;
}

function normalizedFileKey(filePath: string): string {
  const absolute = resolve(filePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function sortServers(servers: McpServerConfig[]): McpServerConfig[] {
  return [...servers].sort((left, right) => left.id.localeCompare(right.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
