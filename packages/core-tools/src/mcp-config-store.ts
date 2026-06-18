import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type McpTransport = 'stdio' | 'sse' | 'streamable-http';
export type McpServerSource = 'builtin' | 'user' | 'market';
export type McpEnvValue = string | { ref: string };

export type McpServerConfig = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: McpTransport;
  autoStart: boolean;
  enabled: boolean;
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
  env?: Record<string, McpEnvValue> | undefined;
  description?: string | undefined;
  packageName?: string | undefined;
  marketEntryId?: string | undefined;
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
  url?: string;
  env?: Record<string, McpEnvValue>;
  description?: string;
  packageName?: string;
  marketEntryId?: string;
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

export const defaultBuiltinMcpServers: McpServerInput[] = [
  {
    id: 'builtin-memory',
    name: 'Memory',
    source: 'builtin',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    autoStart: false,
    enabled: true,
    packageName: '@modelcontextprotocol/server-memory',
    description: 'Local memory MCP server.',
  },
  {
    id: 'builtin-time',
    name: 'Time',
    source: 'builtin',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    autoStart: false,
    enabled: true,
    packageName: '@modelcontextprotocol/server-time',
    description: 'Time and timezone MCP server.',
  },
  {
    id: 'builtin-fetch',
    name: 'Fetch',
    source: 'builtin',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    autoStart: false,
    enabled: true,
    packageName: '@modelcontextprotocol/server-fetch',
    description: 'Web fetch MCP server.',
  },
];

export class McpConfigStore {
  constructor(
    private readonly filePath: string,
    private readonly options: { now?: () => string; createId?: () => string; includeBuiltinDefaults?: boolean } = {},
  ) {}

  async load(): Promise<McpConfigFile> {
    const existing = await this.readExisting();
    if (existing) return existing;
    return {
      version: 1,
      servers:
        this.options.includeBuiltinDefaults === false
          ? []
          : sortServers(defaultBuiltinMcpServers.map((input) => normalizeServerInput(input, this.clock(), this.createId()))),
    };
  }

  async list(): Promise<McpServerConfig[]> {
    return (await this.load()).servers;
  }

  async upsert(input: McpServerInput): Promise<McpServerConfig> {
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
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined> {
    const file = await this.load();
    const index = file.servers.findIndex((server) => server.id === id);
    if (index === -1) return undefined;
    const updated = { ...file.servers[index]!, enabled, updatedAt: this.clock() };
    file.servers[index] = updated;
    await this.save({ version: 1, servers: sortServers(file.servers) });
    return updated;
  }

  async setAutoStart(id: string, autoStart: boolean): Promise<McpServerConfig | undefined> {
    const file = await this.load();
    const index = file.servers.findIndex((server) => server.id === id);
    if (index === -1) return undefined;
    const updated = { ...file.servers[index]!, autoStart, updatedAt: this.clock() };
    file.servers[index] = updated;
    await this.save({ version: 1, servers: sortServers(file.servers) });
    return updated;
  }

  async remove(id: string, options: { deleteSecrets?: boolean } = {}): Promise<McpRemovedServer> {
    const file = await this.load();
    const server = file.servers.find((item) => item.id === id);
    if (!server) return { removed: false, secretRefs: [] };
    await this.save({ version: 1, servers: sortServers(file.servers.filter((item) => item.id !== id)) });
    return {
      removed: true,
      server,
      secretRefs: options.deleteSecrets ? collectSecretRefs(server) : [],
    };
  }

  private async readExisting(): Promise<McpConfigFile | undefined> {
    try {
      return normalizeConfigFile(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async save(file: McpConfigFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
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

export function normalizeServerInput(input: McpServerInput & Partial<Pick<McpServerConfig, 'installedAt'>>, now: string, fallbackId: string): McpServerConfig {
  const id = normalizeId(input.id ?? fallbackId);
  const source = normalizeSource(input.source);
  const transport = normalizeTransport(input.transport);
  const base = normalizeServerBase(input, id, source, transport, now, input.installedAt);
  return normalizeServerByTransport(base);
}

function normalizeServerRecord(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error('Invalid mcp.json: server must be an object.');
  const id = normalizeId(input.id);
  const source = normalizeSource(input.source);
  const transport = normalizeTransport(input.transport);
  const installedAt = typeof input.installedAt === 'string' && input.installedAt ? input.installedAt : new Date(0).toISOString();
  const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : installedAt;
  const base = normalizeServerBase(input, id, source, transport, updatedAt, installedAt);
  return normalizeServerByTransport(base);
}

function normalizeServerBase(
  input: McpServerInput | Record<string, unknown>,
  id: string,
  source: McpServerSource,
  transport: McpTransport,
  now: string,
  installedAt?: string,
): McpServerConfig {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('MCP server name is required.');
  return {
    id,
    name: input.name.trim(),
    source,
    transport,
    autoStart: input.autoStart === true,
    enabled: input.enabled !== false,
    ...(typeof input.command === 'string' && input.command.trim() ? { command: input.command.trim() } : {}),
    ...(Array.isArray(input.args) ? { args: input.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
    ...(typeof input.url === 'string' && input.url.trim() ? { url: input.url.trim() } : {}),
    ...(isRecord(input.env) ? { env: normalizeEnv(input.env, id) } : {}),
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    ...(typeof input.packageName === 'string' && input.packageName.trim() ? { packageName: input.packageName.trim() } : {}),
    ...(typeof input.marketEntryId === 'string' && input.marketEntryId.trim() ? { marketEntryId: input.marketEntryId.trim() } : {}),
    installedAt: installedAt ?? now,
    updatedAt: now,
  };
}

function normalizeServerByTransport(server: McpServerConfig): McpServerConfig {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error(`MCP stdio server ${server.id} requires a command.`);
    const { url: _url, ...stdioServer } = server;
    return stdioServer;
  }

  if (!server.url) throw new Error(`MCP ${server.transport} server ${server.id} requires a URL.`);
  if (!/^https?:\/\//i.test(server.url)) throw new Error(`MCP server ${server.id} URL must use http or https.`);
  const { command: _command, args: _args, ...remoteServer } = server;
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
  assignDefined(merged, 'url', input.url ?? current?.url);
  assignDefined(merged, 'env', input.env ?? current?.env);
  assignDefined(merged, 'description', input.description ?? current?.description);
  assignDefined(merged, 'packageName', input.packageName ?? current?.packageName);
  assignDefined(merged, 'marketEntryId', input.marketEntryId ?? current?.marketEntryId);
  assignDefined(merged, 'installedAt', current?.installedAt);
  return merged;
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function normalizeEnv(env: Record<string, unknown>, serverId: string): Record<string, McpEnvValue> {
  const output: Record<string, McpEnvValue> = {};
  for (const [rawName, rawValue] of Object.entries(env)) {
    const name = normalizeEnvName(rawName);
    if (typeof rawValue === 'string') {
      if (looksSensitiveEnvName(name) || looksLikeSecret(rawValue)) {
        throw new Error(`MCP env ${name} for ${serverId} must be stored as a keychain ref.`);
      }
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
  return Object.values(server.env ?? {})
    .filter((value): value is { ref: string } => isRecord(value) && typeof value.ref === 'string')
    .map((value) => value.ref)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('MCP server id is required.');
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error(`Invalid MCP server id: ${normalized}.`);
  return normalized;
}

function normalizeSource(value: unknown): McpServerSource {
  if (value === 'builtin' || value === 'market') return value;
  return 'user';
}

function normalizeTransport(value: unknown): McpTransport {
  if (value === 'sse' || value === 'streamable-http') return value;
  return 'stdio';
}

function normalizeEnvName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(normalized)) throw new Error(`Invalid MCP env var name: ${value}.`);
  return normalized;
}

function looksSensitiveEnvName(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE)/i.test(name);
}

function looksLikeSecret(value: string): boolean {
  return /\b(sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,})\b/i.test(value);
}

function sortServers(servers: McpServerConfig[]): McpServerConfig[] {
  return [...servers].sort((left, right) => left.id.localeCompare(right.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
