import { createHash } from 'node:crypto';
import { appendLlmEndpointPath, type LlmConnection } from './llm-connection.js';
import type {
  LlmConnectionResolution,
  LlmFetch,
  LlmPassiveJsonRequest,
  LlmPassiveJsonResponse,
  LlmProviderDiscovery,
  LlmProviderPluginMatch,
  LlmResolvedRoute,
  LlmRouteEvidence,
} from './provider-plugin.js';
import type { LlmProviderPluginRegistry } from './provider-plugin-registry.js';
import type { LlmProvider } from './types.js';
import { readLimitedResponseText } from './stream-safety.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_DISCOVERY_MAX_RESPONSE_BYTES = 256 * 1_024;
const HIGH_CONFIDENCE_STATIC_SCORE = 150;
const HIGH_CONFIDENCE_CANDIDATE_FLOOR = 100;

export type LlmConnectionResolverOptions = {
  registry: LlmProviderPluginRegistry;
  fetch?: LlmFetch;
  discoveryTimeoutMs?: number;
  discoveryMaxResponseBytes?: number;
  providerTimeoutMs?: number;
};

export class LlmConnectionResolver {
  private readonly registry: LlmProviderPluginRegistry;
  private readonly fetchImpl: LlmFetch;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryMaxResponseBytes: number;
  private readonly providerTimeoutMs: number;

  constructor(options: LlmConnectionResolverOptions) {
    this.registry = options.registry;
    this.fetchImpl = options.fetch ?? fetch;
    this.discoveryTimeoutMs = positiveInteger(
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      'discoveryTimeoutMs',
    );
    this.discoveryMaxResponseBytes = positiveInteger(
      options.discoveryMaxResponseBytes ?? DEFAULT_DISCOVERY_MAX_RESPONSE_BYTES,
      'discoveryMaxResponseBytes',
    );
    this.providerTimeoutMs = positiveInteger(options.providerTimeoutMs ?? 60_000, 'providerTimeoutMs');
  }

  async resolve(connection: LlmConnection, signal?: AbortSignal): Promise<LlmConnectionResolution> {
    const resolutions = await this.resolveCandidates(
      connection,
      signal === undefined ? {} : { signal },
    );
    return resolutions[0]!;
  }

  async resolveCandidates(
    connection: LlmConnection,
    options: { signal?: AbortSignal; includeFallbacks?: boolean } = {},
  ): Promise<readonly LlmConnectionResolution[]> {
    const matches = this.registry.match(connection);
    if (matches.length === 0) {
      throw new Error(`No LLM Provider Plugin matched connection ${connection.name}.`);
    }
    const topStaticScore = matches[0]?.match.score ?? 0;
    const candidates =
      !options.includeFallbacks && topStaticScore >= HIGH_CONFIDENCE_STATIC_SCORE
        ? matches.filter((candidate) => candidate.match.score >= HIGH_CONFIDENCE_CANDIDATE_FLOOR)
        : matches;
    const requestCache = new Map<string, Promise<LlmPassiveJsonResponse>>();
    const outcomes = await Promise.all(
      candidates.map((candidate) =>
        this.discoverCandidate(connection, candidate, requestCache, options.signal),
      ),
    );
    const successful = outcomes
      .filter((outcome): outcome is SuccessfulDiscovery => outcome.ok)
      .sort(compareDiscoveries);
    if (successful.length === 0) {
      throw new Error(`All LLM Provider Plugins failed while resolving ${connection.name}.`);
    }
    const runtimeEvidence = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.evidence]));
    return Object.freeze(successful.map((selected) => {
      const evidence = Object.freeze([
        ...selected.candidate.match.evidence.map((item) => Object.freeze({ ...item })),
        ...selected.discovery.evidence.map((item) => Object.freeze({ ...item })),
        ...runtimeEvidence.map((item) => Object.freeze({ ...item })),
      ]);
      const manifest = selected.candidate.plugin.manifest;
      const providerId = `${connection.id}:${manifest.id}`;
      const providerBaseUrl = selected.discovery.providerBaseUrl ?? connection.endpoint;
      const revision = routeRevision(
        connection.id,
        manifest.id,
        manifest.version,
        providerBaseUrl,
        evidence,
      );
      return Object.freeze({
        connectionId: connection.id,
        providerId,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        protocol: manifest.protocol,
        providerBaseUrl,
        models: Object.freeze(uniqueModels(selected.discovery.models ?? [])),
        revision,
        evidence,
      });
    }));
  }

  resolveRoute(resolution: LlmConnectionResolution, modelId: string): LlmResolvedRoute {
    const normalizedModel = modelId.trim();
    if (!normalizedModel) throw new Error('modelId must not be empty.');
    return Object.freeze({
      connectionId: resolution.connectionId,
      modelId: normalizedModel,
      providerId: resolution.providerId,
      pluginId: resolution.pluginId,
      protocol: resolution.protocol,
      revision: resolution.revision,
      evidence: resolution.evidence,
    });
  }

  createProvider(connection: LlmConnection, resolution: LlmConnectionResolution): LlmProvider {
    if (resolution.connectionId !== connection.id) {
      throw new Error('The LLM connection resolution belongs to a different connection.');
    }
    const plugin = this.registry.get(resolution.pluginId);
    if (!plugin || plugin.manifest.version !== resolution.pluginVersion) {
      throw new Error(`Resolved Provider Plugin ${resolution.pluginId} is no longer available.`);
    }
    const provider = plugin.createProvider({
      connection,
      resolution,
      fetch: this.fetchImpl,
      timeoutMs: this.providerTimeoutMs,
    });
    if (provider.id !== resolution.providerId) {
      throw new Error(
        `Provider Plugin ${resolution.pluginId} must use resolved provider id ${resolution.providerId}.`,
      );
    }
    return provider;
  }

  private async discoverCandidate(
    connection: LlmConnection,
    candidate: LlmProviderPluginMatch,
    requestCache: Map<string, Promise<LlmPassiveJsonResponse>>,
    parentSignal?: AbortSignal,
  ): Promise<DiscoveryOutcome> {
    if (!candidate.plugin.discover) {
      return {
        ok: true,
        candidate,
        discovery: { score: 0, evidence: [] },
      };
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Provider discovery timed out.'));
    }, this.discoveryTimeoutMs);
    try {
      const discovery = await Promise.race([
        candidate.plugin.discover({
          connection,
          signal: controller.signal,
          getJson: (request) => this.getJson(connection, request, requestCache, controller.signal),
        }),
        abortPromise(controller.signal),
      ]);
      validateDiscovery(discovery);
      return { ok: true, candidate, discovery };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Provider discovery failed.';
      return {
        ok: false,
        candidate,
        evidence: {
          source: 'runtime',
          kind: 'plugin-discovery-error',
          summary: `${candidate.plugin.manifest.name} discovery ${timedOut ? 'timed out' : 'failed'}${detail ? `: ${detail}` : '.'}`,
        },
      };
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  private getJson(
    connection: LlmConnection,
    request: LlmPassiveJsonRequest,
    requestCache: Map<string, Promise<LlmPassiveJsonResponse>>,
    signal: AbortSignal,
  ): Promise<LlmPassiveJsonResponse> {
    const url = appendLlmEndpointPath(connection.endpoint, request.path);
    const headers = { ...connection.headers, ...(request.headers ?? {}) };
    const cacheKey = `${url}\0${stableHeaders(headers)}`;
    const existing = requestCache.get(cacheKey);
    if (existing) return existing;
    const pending = this.fetchJson(url, headers, signal);
    requestCache.set(cacheKey, pending);
    return pending;
  }

  private async fetchJson(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<LlmPassiveJsonResponse> {
    const response = await this.fetchImpl(url, { method: 'GET', headers, signal });
    const text = await readLimitedResponseText(response, this.discoveryMaxResponseBytes);
    let json: unknown;
    if (text.trim()) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return Object.freeze({
      url,
      status: response.status,
      ok: response.ok,
      headers: Object.freeze(responseHeaders),
      ...(json === undefined ? {} : { json }),
    });
  }
}

type SuccessfulDiscovery = {
  ok: true;
  candidate: LlmProviderPluginMatch;
  discovery: LlmProviderDiscovery;
};

type FailedDiscovery = {
  ok: false;
  candidate: LlmProviderPluginMatch;
  evidence: LlmRouteEvidence;
};

type DiscoveryOutcome = SuccessfulDiscovery | FailedDiscovery;

function compareDiscoveries(left: SuccessfulDiscovery, right: SuccessfulDiscovery): number {
  const leftScore = left.candidate.match.score + left.discovery.score;
  const rightScore = right.candidate.match.score + right.discovery.score;
  return (
    rightScore - leftScore ||
    right.candidate.plugin.manifest.priority - left.candidate.plugin.manifest.priority ||
    left.candidate.registrationOrder - right.candidate.registrationOrder
  );
}

function validateDiscovery(discovery: LlmProviderDiscovery): void {
  if (!Number.isFinite(discovery.score) || discovery.score < 0) {
    throw new Error('Provider discovery score must be a finite non-negative number.');
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortReason(signal.reason));
    else signal.addEventListener('abort', () => reject(abortReason(signal.reason)), { once: true });
  });
}

function abortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' && reason ? reason : 'Provider discovery aborted.');
}

function routeRevision(
  connectionId: string,
  pluginId: string,
  pluginVersion: string,
  providerBaseUrl: string,
  evidence: readonly LlmRouteEvidence[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ connectionId, pluginId, pluginVersion, providerBaseUrl, evidence }))
    .digest('hex');
}

function stableHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLocaleLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
