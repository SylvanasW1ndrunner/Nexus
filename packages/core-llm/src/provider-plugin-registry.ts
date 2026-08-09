import { redactKnownSecrets } from './known-secret-sanitizer.js';
import type { LlmConnection } from './llm-connection.js';
import type {
  LlmProviderPlugin,
  LlmProviderPluginDiagnostic,
  LlmProviderPluginMatch,
} from './provider-plugin.js';

export class LlmProviderPluginRegistry {
  private readonly plugins = new Map<string, { plugin: LlmProviderPlugin; order: number }>();
  private lastDiagnostics: LlmProviderPluginDiagnostic[] = [];
  private registrationSequence = 0;

  constructor(plugins: readonly LlmProviderPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: LlmProviderPlugin): void {
    validateManifest(plugin);
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`LLM Provider Plugin ${plugin.manifest.id} is already registered.`);
    }
    this.plugins.set(plugin.manifest.id, { plugin, order: this.registrationSequence++ });
  }

  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId);
  }

  get(pluginId: string): LlmProviderPlugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  list(): readonly LlmProviderPlugin[] {
    return [...this.plugins.values()].sort((left, right) => left.order - right.order).map(({ plugin }) => plugin);
  }

  match(connection: LlmConnection): LlmProviderPluginMatch[] {
    const diagnostics: LlmProviderPluginDiagnostic[] = [];
    const matches: LlmProviderPluginMatch[] = [];
    for (const { plugin, order } of this.plugins.values()) {
      try {
        const match = plugin.match(connection);
        if (!Number.isFinite(match.score) || match.score < 0) {
          throw new Error('match score must be a finite non-negative number');
        }
        if (match.score === 0) continue;
        matches.push({
          plugin,
          match: {
            score: match.score,
            evidence: match.evidence.map((evidence) => Object.freeze({ ...evidence })),
          },
          registrationOrder: order,
        });
      } catch (error) {
        const secrets = connectionSecrets(connection);
        const detail = redactKnownSecrets(
          error instanceof Error ? error.message : 'Provider Plugin match failed.',
          secrets,
        );
        diagnostics.push({
          pluginId: plugin.manifest.id,
          phase: 'match',
          message: `Provider Plugin match failed${detail ? `: ${detail}` : '.'}`,
        });
      }
    }
    this.lastDiagnostics = diagnostics;
    return matches.sort(
      (left, right) =>
        right.match.score - left.match.score ||
        right.plugin.manifest.priority - left.plugin.manifest.priority ||
        left.registrationOrder - right.registrationOrder,
    );
  }

  diagnostics(): readonly LlmProviderPluginDiagnostic[] {
    return this.lastDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }
}

function validateManifest(plugin: LlmProviderPlugin): void {
  if (!plugin.manifest.id.trim()) throw new Error('Provider Plugin id must not be empty.');
  if (!plugin.manifest.name.trim()) throw new Error('Provider Plugin name must not be empty.');
  if (!plugin.manifest.version.trim()) throw new Error('Provider Plugin version must not be empty.');
  if (!plugin.manifest.protocol.trim()) throw new Error('Provider Plugin protocol must not be empty.');
  if (!Number.isFinite(plugin.manifest.priority)) {
    throw new Error('Provider Plugin priority must be finite.');
  }
}

function connectionSecrets(connection: LlmConnection): string[] {
  return [connection.apiKey, ...Object.values(connection.headers)].filter(
    (secret): secret is string => Boolean(secret),
  );
}
