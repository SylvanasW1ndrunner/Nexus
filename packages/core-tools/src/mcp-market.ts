import type { McpEnvValue, McpServerInput, McpTransport } from './mcp-config-store.js';

export type McpMarketRequiredEnv = {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
  secret: boolean;
};

export type McpMarketEntry = {
  id: string;
  marketId: string;
  name: string;
  description: string;
  publisher: string;
  categories: string[];
  transport: McpTransport;
  packageName?: string;
  rating?: number;
  downloads?: number;
  requiredEnv: McpMarketRequiredEnv[];
};

export type McpMarketInstallTemplate = {
  entryId: string;
  marketId: string;
  server: McpServerInput;
  requiredEnv: McpMarketRequiredEnv[];
};

export type McpMarketSearchRequest = {
  query?: string;
  category?: string;
  limit?: number;
};

export type McpMarketProvider = {
  id: string;
  name: string;
  search(request?: McpMarketSearchRequest): Promise<McpMarketEntry[]> | McpMarketEntry[];
  getInstallTemplate(entryId: string): Promise<McpMarketInstallTemplate> | McpMarketInstallTemplate;
};

export type StaticMcpMarketEntry = McpMarketEntry & {
  install: Omit<McpMarketInstallTemplate, 'entryId' | 'marketId' | 'requiredEnv'> & {
    requiredEnv?: McpMarketRequiredEnv[];
  };
};

export class StaticMcpMarketProvider implements McpMarketProvider {
  readonly id: string;
  readonly name: string;
  private readonly entries: StaticMcpMarketEntry[];

  constructor(options: { id: string; name: string; entries: StaticMcpMarketEntry[] }) {
    this.id = options.id;
    this.name = options.name;
    this.entries = options.entries.map(cloneStaticEntry);
    assertUnique(this.entries.map((entry) => entry.id), 'MCP market entry');
  }

  search(request: McpMarketSearchRequest = {}): McpMarketEntry[] {
    const query = request.query?.trim().toLowerCase();
    const category = request.category?.trim().toLowerCase();
    const limit = clampLimit(request.limit);
    return this.entries
      .filter((entry) => {
        if (category && !entry.categories.some((item) => item.toLowerCase() === category)) return false;
        if (!query) return true;
        return [entry.id, entry.name, entry.description, entry.publisher, entry.packageName ?? '']
          .some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, limit)
      .map(toMarketEntry);
  }

  getInstallTemplate(entryId: string): McpMarketInstallTemplate {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) throw new Error(`MCP market entry not found: ${entryId}.`);
    return {
      entryId: entry.id,
      marketId: this.id,
      server: cloneServerInput(entry.install.server),
      requiredEnv: cloneRequiredEnv(entry.install.requiredEnv ?? entry.requiredEnv),
    };
  }
}

export function buildMcpServerInputFromMarketTemplate(
  template: McpMarketInstallTemplate,
  input: {
    serverId?: string;
    name?: string;
    envPlain?: Record<string, string>;
    envSecrets?: Record<string, string>;
    autoStart?: boolean;
    enabled?: boolean;
  } = {},
): { server: McpServerInput; secrets: Record<string, string> } {
  const env: Record<string, McpEnvValue> = { ...(template.server.env ?? {}) };
  const secrets: Record<string, string> = {};
  for (const item of template.requiredEnv) {
    const plain = input.envPlain?.[item.name];
    const secret = input.envSecrets?.[item.name];
    if (item.required && plain === undefined && secret === undefined && env[item.name] === undefined) {
      throw new Error(`MCP market entry requires env ${item.name}.`);
    }
    if (plain !== undefined) {
      if (item.secret) throw new Error(`MCP env ${item.name} must be stored as a secret.`);
      env[item.name] = plain;
    }
    if (secret !== undefined) secrets[item.name] = secret;
  }

  const base = cloneServerInput(template.server);
  const server: McpServerInput = {
    ...base,
    id: input.serverId ?? base.id ?? template.entryId,
    name: input.name ?? base.name,
    source: 'market',
    marketEntryId: template.entryId,
    env,
  };
  if (input.autoStart !== undefined) server.autoStart = input.autoStart;
  else if (base.autoStart !== undefined) server.autoStart = base.autoStart;
  if (input.enabled !== undefined) server.enabled = input.enabled;
  else if (base.enabled !== undefined) server.enabled = base.enabled;

  return {
    server,
    secrets,
  };
}

export const DEFAULT_STATIC_MCP_MARKET_ENTRIES: StaticMcpMarketEntry[] = [
  {
    id: 'modelcontextprotocol-memory',
    marketId: 'official-static',
    name: 'Memory',
    description: 'Local memory MCP server for structured notes and recall.',
    publisher: 'Model Context Protocol',
    categories: ['memory', 'official'],
    transport: 'stdio',
    packageName: '@modelcontextprotocol/server-memory',
    requiredEnv: [],
    install: {
      server: {
        id: 'market-memory',
        name: 'Memory',
        source: 'market',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        autoStart: false,
        enabled: true,
        packageName: '@modelcontextprotocol/server-memory',
        marketEntryId: 'modelcontextprotocol-memory',
      },
    },
  },
  {
    id: 'modelcontextprotocol-fetch',
    marketId: 'official-static',
    name: 'Fetch',
    description: 'Fetch web resources through an MCP server.',
    publisher: 'Model Context Protocol',
    categories: ['web', 'official'],
    transport: 'stdio',
    packageName: '@modelcontextprotocol/server-fetch',
    requiredEnv: [],
    install: {
      server: {
        id: 'market-fetch',
        name: 'Fetch',
        source: 'market',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-fetch'],
        autoStart: false,
        enabled: true,
        packageName: '@modelcontextprotocol/server-fetch',
        marketEntryId: 'modelcontextprotocol-fetch',
      },
    },
  },
];

export function createDefaultStaticMcpMarketProvider(): StaticMcpMarketProvider {
  return new StaticMcpMarketProvider({
    id: 'official-static',
    name: 'Official Static MCP Catalog',
    entries: DEFAULT_STATIC_MCP_MARKET_ENTRIES,
  });
}

function toMarketEntry(entry: StaticMcpMarketEntry): McpMarketEntry {
  return {
    id: entry.id,
    marketId: entry.marketId,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    categories: [...entry.categories],
    transport: entry.transport,
    ...(entry.packageName === undefined ? {} : { packageName: entry.packageName }),
    ...(entry.rating === undefined ? {} : { rating: entry.rating }),
    ...(entry.downloads === undefined ? {} : { downloads: entry.downloads }),
    requiredEnv: cloneRequiredEnv(entry.requiredEnv),
  };
}

function cloneStaticEntry(entry: StaticMcpMarketEntry): StaticMcpMarketEntry {
  return {
    ...toMarketEntry(entry),
    install: {
      server: cloneServerInput(entry.install.server),
      ...(entry.install.requiredEnv === undefined
        ? {}
        : { requiredEnv: cloneRequiredEnv(entry.install.requiredEnv) }),
    },
  };
}

function cloneServerInput(input: McpServerInput): McpServerInput {
  return {
    ...input,
    ...(input.args === undefined ? {} : { args: [...input.args] }),
    ...(input.env === undefined ? {} : { env: { ...input.env } }),
  };
}

function cloneRequiredEnv(values: McpMarketRequiredEnv[]): McpMarketRequiredEnv[] {
  return values.map((item) => ({ ...item }));
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 50;
  return Math.min(100, Math.floor(value));
}
