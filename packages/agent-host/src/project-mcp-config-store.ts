import { randomUUID } from 'node:crypto';
import {
  normalizeServerInput,
  type McpConfigFile,
  type McpConfigRepository,
  type McpRemovedServer,
  type McpServerConfig,
  type McpServerInput,
} from '@dbagent/core-tools';
import type {
  ProjectSettingsStore,
  SchemaNautMcpServerSettings,
  SchemaNautMcpValue,
} from './project-settings.js';

const STATIC_SETTINGS_TIMESTAMP = new Date(0).toISOString();

/**
 * MCP configuration repository backed by the single Project settings file.
 * Runtime health and process state intentionally never enter settings.json.
 */
export class ProjectMcpConfigStore implements McpConfigRepository {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: ProjectSettingsStore,
    private readonly options: {
      now?: () => string;
      createId?: () => string;
    } = {},
  ) {}

  async load(): Promise<McpConfigFile> {
    const snapshot = await this.settings.load();
    const servers = Object.entries(snapshot.settings.mcp?.servers ?? {})
      .map(([id, server]) => this.normalizeStored(id, server))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { version: 1, servers };
  }

  async list(): Promise<McpServerConfig[]> {
    return (await this.load()).servers;
  }

  async upsert(input: McpServerInput): Promise<McpServerConfig> {
    return this.mutate(async () => {
      const snapshot = await this.settings.load();
      const servers = structuredClone(snapshot.settings.mcp?.servers ?? {});
      const id = input.id?.trim() || this.createId();
      const current = servers[id];
      const merged = mergeSettingsInput(id, current, input);
      const normalized = normalizeServerInput(merged, this.clock(), id, PROJECT_NORMALIZATION);
      servers[id] = toStoredSettings(normalized);
      await this.settings.replaceMcpServers(servers);
      return normalized;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined> {
    return this.updateExisting(id, { enabled });
  }

  async setAutoStart(id: string, autoStart: boolean): Promise<McpServerConfig | undefined> {
    return this.updateExisting(id, { autoStart });
  }

  async remove(id: string, options: { deleteSecrets?: boolean } = {}): Promise<McpRemovedServer> {
    return this.mutate(async () => {
      const snapshot = await this.settings.load();
      const servers = structuredClone(snapshot.settings.mcp?.servers ?? {});
      const existing = servers[id];
      if (!existing) return { removed: false, secretRefs: [] };
      const server = this.normalizeStored(id, existing);
      delete servers[id];
      await this.settings.replaceMcpServers(servers);
      return {
        removed: true,
        server,
        secretRefs: options.deleteSecrets ? collectReferences(server) : [],
      };
    });
  }

  private async updateExisting(
    id: string,
    patch: Pick<McpServerInput, 'enabled'> | Pick<McpServerInput, 'autoStart'>,
  ): Promise<McpServerConfig | undefined> {
    return this.mutate(async () => {
      const snapshot = await this.settings.load();
      const servers = structuredClone(snapshot.settings.mcp?.servers ?? {});
      const current = servers[id];
      if (!current) return undefined;
      const normalized = normalizeServerInput(
        mergeSettingsInput(id, current, patch),
        this.clock(),
        id,
        PROJECT_NORMALIZATION,
      );
      servers[id] = toStoredSettings(normalized);
      await this.settings.replaceMcpServers(servers);
      return normalized;
    });
  }

  private normalizeStored(id: string, input: SchemaNautMcpServerSettings): McpServerConfig {
    return normalizeServerInput(
      {
        id,
        name: input.name?.trim() || id,
        source: 'user',
        ...structuredClone(input),
      },
      STATIC_SETTINGS_TIMESTAMP,
      id,
      PROJECT_NORMALIZATION,
    );
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private clock(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private createId(): string {
    return this.options.createId?.() ?? randomUUID();
  }
}

const PROJECT_NORMALIZATION = {
  allowInsecureRemote: true,
} as const;

function mergeSettingsInput(
  id: string,
  current: SchemaNautMcpServerSettings | undefined,
  input: Partial<McpServerInput>,
): McpServerInput {
  const merged = {
    ...(current === undefined ? {} : structuredClone(current)),
    ...definedEntries(input),
  } as McpServerInput;
  return {
    ...merged,
    id,
    name: input.name?.trim() || current?.name?.trim() || id,
    source: 'user',
  };
}

function toStoredSettings(server: McpServerConfig): SchemaNautMcpServerSettings {
  return {
    ...(server.name === server.id ? {} : { name: server.name }),
    transport: server.transport,
    ...(server.autoStart ? { autoStart: true } : {}),
    ...(server.enabled ? {} : { enabled: false }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.env === undefined ? {} : { env: structuredClone(server.env) }),
    ...(server.headers === undefined ? {} : { headers: storedHeaders(server) }),
    ...(server.description === undefined ? {} : { description: server.description }),
    ...(server.packageName === undefined ? {} : { packageName: server.packageName }),
  };
}

function storedHeaders(server: McpServerConfig): Record<string, SchemaNautMcpValue> {
  const headers: Record<string, SchemaNautMcpValue> = {};
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    headers[name] = typeof value === 'string' ? value : { ref: value.ref };
  }
  return headers;
}

function definedEntries(input: Partial<McpServerInput>): Partial<McpServerInput> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function collectReferences(server: McpServerConfig): string[] {
  return [...new Set(
    [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
      .filter((value): value is Extract<SchemaNautMcpValue, { ref: string }> =>
        typeof value === 'object' && value !== null && typeof value.ref === 'string')
      .map((value) => value.ref),
  )].sort((left, right) => left.localeCompare(right));
}
