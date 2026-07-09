import type {
  McpConfigStore,
  McpRuntimeManager,
  McpRuntimeStartResult,
  McpRuntimeStopResult,
  McpServerConfig,
  McpServerHealthState,
  McpServerInput,
  McpToolRegistrationManager,
} from '@dbagent/core-tools';
import type {
  McpEnvValue,
  McpSafeEnvValue,
  McpServerConfigPreview,
  McpServerHealthPreview,
  McpServerOperationResult,
  McpServerSummary,
  McpUpsertServerRequest,
} from '@dbagent/shared';

export type McpSecretStore = {
  save(ref: string, value: string): Promise<void>;
  load(ref: string): Promise<string | undefined>;
  remove(ref: string): Promise<void>;
};

export type DesktopMcpServiceOptions = {
  configStore: McpConfigStore;
  runtime: McpRuntimeManager;
  tools: McpToolRegistrationManager;
  secrets: McpSecretStore;
};

export class DesktopMcpService {
  constructor(private readonly options: DesktopMcpServiceOptions) {}

  async list(): Promise<McpServerSummary[]> {
    const servers = await this.options.configStore.list();
    return servers.map((server) => this.toSummary(server));
  }

  async upsert(request: McpUpsertServerRequest): Promise<McpServerOperationResult> {
    const serverInput = await this.prepareServerInput(request);
    const server = await this.options.configStore.upsert(serverInput);
    if (!server.enabled) {
      const stopped = await this.options.runtime.stop(server.id);
      return this.fromStopResult(stopped, server, { tools: this.serverToolNames(server.id) });
    }
    if (request.start === true) {
      return this.fromStartResult(await this.options.runtime.start(server.id));
    }
    return {
      serverId: server.id,
      server: toServerPreview(server),
      tools: this.serverToolNames(server.id),
      removedTools: [],
      health: toHealthPreview(this.options.runtime.health(server.id)),
      running: this.options.runtime.isRunning(server.id),
    };
  }

  async remove(input: { id: string; deleteSecrets?: boolean }): Promise<McpServerOperationResult> {
    const stopped = await this.options.runtime.stop(input.id);
    const removed = await this.options.configStore.remove(input.id, {
      deleteSecrets: input.deleteSecrets === true,
    });
    if (input.deleteSecrets === true) {
      await Promise.all(removed.secretRefs.map((ref) => this.options.secrets.remove(ref)));
    }
    return {
      serverId: input.id,
      ...(removed.server === undefined ? {} : { server: toServerPreview(removed.server) }),
      tools: [],
      removedTools: stopped.removedTools,
      health: toHealthPreview(stopped.health),
      running: false,
      removed: removed.removed,
      secretRefs: removed.secretRefs,
    };
  }

  async start(id: string): Promise<McpServerOperationResult> {
    return this.fromStartResult(await this.options.runtime.start(id));
  }

  async stop(id: string): Promise<McpServerOperationResult> {
    return this.fromStopResult(await this.options.runtime.stop(id));
  }

  async startAutoStart(): Promise<McpServerOperationResult[]> {
    return (await this.options.runtime.startAutoStart()).map((result) =>
      this.fromStartResult(result),
    );
  }

  async restartDue(now?: string): Promise<McpServerOperationResult[]> {
    return (await this.options.runtime.restartDue(now)).map((result) =>
      this.fromStartResult(result),
    );
  }

  health(): McpServerHealthPreview[] {
    return this.options.runtime.listHealth().map(toHealthPreview);
  }

  resolveSecret(ref: string): Promise<string | undefined> {
    return this.options.secrets.load(ref);
  }

  private async prepareServerInput(request: McpUpsertServerRequest): Promise<McpServerInput> {
    const serverInput = toCoreServerInput(request);
    const secrets = request.secrets;
    if (secrets === undefined || Object.keys(secrets).length === 0) return serverInput;
    if (!serverInput.id) throw new Error('MCP server id is required when saving secrets.');

    const env: Record<string, McpEnvValue> = { ...(serverInput.env ?? {}) };
    for (const [rawName, value] of Object.entries(secrets)) {
      const name = normalizeEnvName(rawName);
      const ref = mcpEnvSecretRef(serverInput.id, name);
      await this.options.secrets.save(ref, value);
      env[name] = { ref };
    }
    return { ...serverInput, env };
  }

  private toSummary(server: McpServerConfig): McpServerSummary {
    return {
      server: toServerPreview(server),
      health: toHealthPreview(this.options.runtime.health(server.id)),
      tools: this.serverToolNames(server.id),
      running: this.options.runtime.isRunning(server.id),
    };
  }

  private fromStartResult(result: McpRuntimeStartResult): McpServerOperationResult {
    return {
      serverId: result.server.id,
      server: toServerPreview(result.server),
      tools: result.tools,
      removedTools: [],
      health: toHealthPreview(result.health),
      running: this.options.runtime.isRunning(result.server.id),
    };
  }

  private fromStopResult(
    result: McpRuntimeStopResult,
    server?: McpServerConfig,
    options: { tools?: string[] } = {},
  ): McpServerOperationResult {
    return {
      serverId: result.serverId,
      ...(server === undefined ? {} : { server: toServerPreview(server) }),
      tools: options.tools ?? [],
      removedTools: result.removedTools,
      health: toHealthPreview(result.health),
      running: false,
    };
  }

  private serverToolNames(serverId: string): string[] {
    return this.options.tools.listServerTools(serverId).map((tool) => tool.name);
  }
}

function toCoreServerInput(request: McpUpsertServerRequest): McpServerInput {
  return {
    ...(request.id === undefined ? {} : { id: request.id }),
    name: request.name,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    ...(request.autoStart === undefined ? {} : { autoStart: request.autoStart }),
    ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    ...(request.command === undefined ? {} : { command: request.command }),
    ...(request.args === undefined ? {} : { args: [...request.args] }),
    ...(request.url === undefined ? {} : { url: request.url }),
    ...(request.env === undefined ? {} : { env: { ...request.env } }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.packageName === undefined ? {} : { packageName: request.packageName }),
    ...(request.marketEntryId === undefined ? {} : { marketEntryId: request.marketEntryId }),
  };
}

function toServerPreview(server: McpServerConfig): McpServerConfigPreview {
  return {
    id: server.id,
    name: server.name,
    source: server.source,
    transport: server.transport,
    autoStart: server.autoStart,
    enabled: server.enabled,
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.env === undefined ? {} : { env: toSafeEnv(server.env) }),
    ...(server.description === undefined ? {} : { description: server.description }),
    ...(server.packageName === undefined ? {} : { packageName: server.packageName }),
    ...(server.marketEntryId === undefined ? {} : { marketEntryId: server.marketEntryId }),
    installedAt: server.installedAt,
    updatedAt: server.updatedAt,
  };
}

function toSafeEnv(env: Record<string, McpEnvValue>): Record<string, McpSafeEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      typeof value === 'string' ? { kind: 'plain' } : { kind: 'secret-ref', ref: value.ref },
    ]),
  );
}

function toHealthPreview(state: McpServerHealthState): McpServerHealthPreview {
  return {
    serverId: state.serverId,
    status: state.status,
    healthy: state.healthy,
    restartCount: state.restartCount,
    warnings: [...state.warnings],
    ...(state.lastStartedAt === undefined ? {} : { lastStartedAt: state.lastStartedAt }),
    ...(state.lastHealthyAt === undefined ? {} : { lastHealthyAt: state.lastHealthyAt }),
    ...(state.lastExitAt === undefined ? {} : { lastExitAt: state.lastExitAt }),
    ...(state.lastExitCode === undefined ? {} : { lastExitCode: state.lastExitCode }),
    ...(state.lastExitSignal === undefined ? {} : { lastExitSignal: state.lastExitSignal }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.nextRestartAt === undefined ? {} : { nextRestartAt: state.nextRestartAt }),
    ...(state.resource === undefined ? {} : { resource: { ...state.resource } }),
  };
}

function mcpEnvSecretRef(serverId: string, name: string): string {
  return `mcp:${serverId}:env:${name}`;
}

function normalizeEnvName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(normalized)) throw new Error(`Invalid MCP env var name: ${value}.`);
  return normalized;
}
