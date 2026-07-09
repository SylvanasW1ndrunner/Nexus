import {
  buildMcpServerInputFromMarketTemplate,
  type McpMarketProvider,
} from '@dbagent/core-tools';
import type {
  McpMarketEntry,
  McpMarketInstallRequest,
  McpMarketSearchRequest,
  McpServerOperationResult,
} from '@dbagent/shared';
import type { DesktopMcpService } from './mcp-service.js';

export class DesktopMcpMarketService {
  private readonly providers = new Map<string, McpMarketProvider>();

  constructor(
    providers: McpMarketProvider[],
    private readonly mcp: DesktopMcpService,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate MCP market provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
  }

  async search(request: McpMarketSearchRequest = {}): Promise<McpMarketEntry[]> {
    const providers = request.marketId === undefined ? [...this.providers.values()] : [this.provider(request.marketId)];
    const results: McpMarketEntry[] = [];
    for (const provider of providers) {
      results.push(...(await provider.search(request)));
    }
    return results.slice(0, clampLimit(request.limit));
  }

  async install(request: McpMarketInstallRequest): Promise<McpServerOperationResult> {
    const provider = this.provider(request.marketId);
    const template = await provider.getInstallTemplate(request.entryId);
    const install = buildMcpServerInputFromMarketTemplate(template, {
      ...(request.serverId === undefined ? {} : { serverId: request.serverId }),
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.envPlain === undefined ? {} : { envPlain: request.envPlain }),
      ...(request.envSecrets === undefined ? {} : { envSecrets: request.envSecrets }),
      ...(request.autoStart === undefined ? {} : { autoStart: request.autoStart }),
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    });
    return this.mcp.upsert({
      ...install.server,
      secrets: install.secrets,
      ...(request.start === undefined ? {} : { start: request.start }),
    });
  }

  private provider(id: string): McpMarketProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`MCP market provider not found: ${id}.`);
    return provider;
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 50;
  return Math.min(100, Math.floor(value));
}
