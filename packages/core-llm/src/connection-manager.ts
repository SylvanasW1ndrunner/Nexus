import { createBuiltinLlmProviderPlugins } from './builtin-provider-plugins.js';
import { LlmConnectionResolver } from './connection-resolver.js';
import {
  appendLlmEndpointPath,
  createLlmConnection,
  type LlmConnection,
  type LlmConnectionInput,
} from './llm-connection.js';
import {
  mergeLlmGenerationConfig,
  validateLlmGenerationConfig,
} from './generation-config.js';
import {
  createModelSessionBundle,
  createModelSession,
  type ModelClient,
  type ModelReplayBinding,
  type ModelSession,
  type ModelSessionBundle,
} from './model-client.js';
import { HttpJsonTransport } from './transport/http-json-transport.js';
import { SseTransport } from './transport/sse-transport.js';
import { NdjsonTransport } from './transport/ndjson-transport.js';
import { openAIChatCodec } from './protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from './protocol/codecs/openai-responses.js';
import { anthropicMessagesCodec } from './protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from './protocol/codecs/ollama-chat.js';
import type { ModelProtocolCodec } from './protocol/codec.js';
import {
  bindTrustedModelSessionClient,
  type ModelClientBindingMetadata,
} from './model-client-binding.js';
import {
  LlmModelCatalogManager,
  type LlmCatalogSnapshot,
  type LlmModelCatalogFilter,
} from './model-catalog-manager.js';
import { LlmModelCatalogStore } from './model-catalog-store.js';
import type { LlmCatalogModel } from './model-metadata.js';
import type {
  LlmConnectionResolution,
  LlmFetch,
  LlmProviderPlugin,
  LlmResolvedRoute,
} from './provider-plugin.js';
import { LlmProviderPluginRegistry } from './provider-plugin-registry.js';
import {
  LlmProviderError,
  type LlmEmbeddingResponse,
  type LlmGenerationConfig,
  type LlmGenerationParameterName,
  type LlmProvider,
  type LlmRerankResponse,
} from './types.js';

const GENERATION_PARAMETER_NAMES: LlmGenerationParameterName[] = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'seed',
  'stop',
  'reasoningEffort',
];

export type LlmModelSelection = {
  connectionId: string;
  modelId: string;
  routeRevision?: string;
};

export type LlmParameterSource = 'provider-default' | 'global' | 'session' | 'request';

export type LlmParameterDiagnostic = {
  parameter: LlmGenerationParameterName;
  status: 'unknown';
  message: string;
};

export type LlmEffectiveParameters = {
  values: LlmGenerationConfig;
  sources: Partial<Record<LlmGenerationParameterName, LlmParameterSource>>;
  diagnostics: readonly LlmParameterDiagnostic[];
};

export type LlmParameterLayers = {
  providerDefaults?: LlmGenerationConfig;
  session?: LlmGenerationConfig;
  request?: LlmGenerationConfig;
};

export type LlmConnectionDiscovery = {
  connection: LlmConnection;
  resolution: LlmConnectionResolution;
  alternatives: readonly LlmConnectionResolution[];
  catalog: LlmCatalogSnapshot;
};

export type LlmPreparedSelection = {
  selection: LlmModelSelection;
  route: LlmResolvedRoute;
  model: LlmCatalogModel;
};

export type LlmCallContext = Readonly<{
  tenantId: string;
  taskType: string;
  userId?: string;
}>;

export type LlmTrustedModelClientFactoryContext = Readonly<{
  connection: LlmConnection;
  resolution: LlmConnectionResolution;
  streaming: boolean;
  fetch?: LlmFetch;
}>;

export type LlmTrustedModelClientBinding = Readonly<{
  client: ModelClient;
  bindingEvidence: ModelClientBindingMetadata;
}>;

export type LlmTrustedModelClientFactory = (
  context: LlmTrustedModelClientFactoryContext,
) => LlmTrustedModelClientBinding | undefined;

export type LlmConnectionManagerOptions = {
  cacheDirectory: string;
  plugins?: readonly LlmProviderPlugin[];
  fetch?: LlmFetch;
  discoveryTimeoutMs?: number;
  providerTimeoutMs?: number;
  globalParameters?: LlmGenerationConfig;
  catalogManager?: LlmModelCatalogManager;
  /** Host-owned factory; public per-call clients never receive persistence authority. */
  trustedModelClientFactory?: LlmTrustedModelClientFactory;
};

type ConnectionRuntime = {
  connection: LlmConnection;
  resolutions: readonly LlmConnectionResolution[];
  providers: Map<string, LlmProvider>;
  inspectedModels: Set<string>;
};

export class LlmConnectionManager {
  readonly catalog: LlmModelCatalogManager;

  private readonly registry: LlmProviderPluginRegistry;
  private readonly resolver: LlmConnectionResolver;
  private readonly configuredConnections = new Map<string, LlmConnection>();
  private readonly runtimes = new Map<string, ConnectionRuntime>();
  private readonly connectionOperationTails = new Map<string, Promise<void>>();
  private readonly fetchImpl: LlmFetch | undefined;
  private readonly trustedModelClientFactory: LlmTrustedModelClientFactory;
  private globalParameters: LlmGenerationConfig;

  constructor(options: LlmConnectionManagerOptions) {
    this.fetchImpl = options.fetch;
    this.trustedModelClientFactory =
      options.trustedModelClientFactory ?? defaultTrustedModelClientFactory;
    this.registry = new LlmProviderPluginRegistry(
      options.plugins ?? createBuiltinLlmProviderPlugins(),
    );
    this.resolver = new LlmConnectionResolver({
      registry: this.registry,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.discoveryTimeoutMs === undefined
        ? {}
        : { discoveryTimeoutMs: options.discoveryTimeoutMs }),
      ...(options.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: options.providerTimeoutMs }),
    });
    this.catalog =
      options.catalogManager ??
      new LlmModelCatalogManager({ store: new LlmModelCatalogStore(options.cacheDirectory) });
    this.globalParameters = validateLlmGenerationConfig({
      ...(options.globalParameters ?? {}),
    });
  }

  replaceConnections(inputs: readonly (LlmConnectionInput | LlmConnection)[]): LlmConnection[] {
    return this.replaceConfiguration({
      connections: inputs,
      globalParameters: this.globalParameters,
    });
  }

  /** Validates the complete global model configuration before publishing any part of it. */
  replaceConfiguration(input: Readonly<{
    connections: readonly (LlmConnectionInput | LlmConnection)[];
    globalParameters: LlmGenerationConfig;
  }>): LlmConnection[] {
    const globalParameters = validateLlmGenerationConfig({ ...input.globalParameters });
    const next = new Map<string, LlmConnection>();
    for (const connectionInput of input.connections) {
      let candidate = isResolvedConnection(connectionInput)
        ? connectionInput
        : createLlmConnection(connectionInput);
      if (!isResolvedConnection(connectionInput)) {
        const existing = this.configuredConnections.get(candidate.id);
        if (existing !== undefined) {
          candidate = createLlmConnection({
            ...connectionInput,
            connectionConfigurationRevision:
              connectionInput.connectionConfigurationRevision ??
              (sameNonSecretConnection(existing, candidate)
                ? existing.connectionConfigurationRevision
                : candidate.connectionConfigurationRevision),
            credentialRevision:
              connectionInput.credentialRevision ??
              (sameCredentialValues(existing, candidate)
                ? existing.credentialRevision
                : candidate.credentialRevision),
          });
        }
      }
      const previous = this.configuredConnections.get(candidate.id);
      const connection = previous && sameConnection(previous, candidate) ? previous : candidate;
      if (next.has(connection.id)) {
        throw new Error(`Duplicate LLM connection identity: ${connection.name}.`);
      }
      next.set(connection.id, connection);
    }

    for (const [id, runtime] of this.runtimes) {
      if (next.get(id) === runtime.connection) continue;
      this.removeRuntime(runtime);
      this.runtimes.delete(id);
    }
    this.configuredConnections.clear();
    for (const [id, connection] of next) this.configuredConnections.set(id, connection);
    this.globalParameters = globalParameters;
    return this.connections();
  }

  connections(): LlmConnection[] {
    return [...this.configuredConnections.values()].map((connection) => ({
      ...connection,
      headers: { ...connection.headers },
    }));
  }

  setGlobalParameters(parameters: LlmGenerationConfig): void {
    this.globalParameters = validateLlmGenerationConfig({ ...parameters });
  }

  async discover(
    connectionId: string,
    options: { inspectModelIds?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<LlmConnectionDiscovery> {
    return await this.withConnectionOperation(connectionId, async () =>
      await this.discoverUnlocked(connectionId, options),
    );
  }

  private async discoverUnlocked(
    connectionId: string,
    options: { inspectModelIds?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<LlmConnectionDiscovery> {
    const connection = this.requireConnection(connectionId);
    const resolutions = await this.resolver.resolveCandidates(connection, {
      includeFallbacks: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const providers = new Map<string, LlmProvider>();
    const usableResolutions: LlmConnectionResolution[] = [];
    for (const resolution of resolutions) {
      try {
        const provider = this.resolver.createProvider(connection, resolution);
        providers.set(resolution.pluginId, provider);
        usableResolutions.push(resolution);
      } catch {
        // A protocol requiring credentials can be an alternate candidate for a
        // credential-free local endpoint. It is ignored without hiding the
        // healthy primary candidate.
      }
    }
    const primary = usableResolutions[0];
    if (!primary) throw new Error(`No usable LLM Provider Plugin resolved ${connection.name}.`);
    const provider = providers.get(primary.pluginId)!;
    const catalog = await this.catalog.refresh({
      connection,
      resolution: primary,
      provider,
      ...(this.registry.get(primary.pluginId)?.parameters?.support === undefined
        ? {}
        : { parameterSupport: this.registry.get(primary.pluginId)!.parameters!.support }),
      ...(options.inspectModelIds === undefined
        ? {}
        : { inspectModelIds: options.inspectModelIds }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (this.configuredConnections.get(connectionId) !== connection) {
      this.catalog.removeConnection(connectionId);
      throw new Error(`LLM connection changed while discovery was running: ${connection.name}.`);
    }
    const runtime: ConnectionRuntime = {
      connection,
      resolutions: Object.freeze(usableResolutions),
      providers,
      inspectedModels: new Set(options.inspectModelIds ?? []),
    };
    this.runtimes.set(connectionId, runtime);
    return {
      connection: { ...connection, headers: { ...connection.headers } },
      resolution: primary,
      alternatives: usableResolutions.slice(1),
      catalog,
    };
  }

  models(filter: LlmModelCatalogFilter = {}): LlmCatalogModel[] {
    const configured = new Set(this.configuredConnections.keys());
    return this.catalog.models(filter).filter((model) => configured.has(model.connectionId));
  }

  resolveRoute(selection: LlmModelSelection): LlmResolvedRoute {
    const runtime = this.requireRuntime(selection.connectionId);
    const resolution = runtime.resolutions[0]!;
    if (!this.catalog.resolve(selection.connectionId, selection.modelId)) {
      throw new LlmProviderError(
        'LLM_NO_ROUTE',
        `Model ${selection.modelId} is not available on connection ${runtime.connection.name}.`,
        false,
      );
    }
    return this.resolver.resolveRoute(resolution, selection.modelId);
  }

  modelMode(selection: LlmModelSelection): LlmProvider['mode'] {
    const runtime = this.requireRuntime(selection.connectionId);
    const resolution = runtime.resolutions[0]!;
    const provider = runtime.providers.get(resolution.pluginId);
    if (provider === undefined) {
      throw new LlmProviderError('LLM_NO_ROUTE', 'The selected connection adapter is unavailable.', false);
    }
    return provider.mode;
  }

  /** Resolves passive endpoint metadata and makes the selected route executable. */
  async prepare(
    selection: LlmModelSelection,
    options: { signal?: AbortSignal } = {},
  ): Promise<LlmPreparedSelection> {
    await this.ensureReady(selection, options.signal);
    const route = this.resolveRoute(selection);
    return {
      selection: { ...selection, routeRevision: route.revision },
      route,
      model: structuredClone(this.requireCatalogModel(selection)),
    };
  }

  /**
   * Builds the immutable canonical execution binding. This method performs no
   * model attempt, retry or fallback; ModelExecutionGateway owns those actions.
   */
  async prepareModelSession(
    selection: LlmModelSelection,
    options: {
      client?: ModelClient;
      generation?: LlmGenerationConfig;
      allowedFallbackRouteIds?: readonly string[];
      signal?: AbortSignal;
    },
  ): Promise<ModelSession> {
    return (await this.prepareModelSessionBundle(selection, options)).primary;
  }

  /** Prepares the complete authenticated primary/fallback binding without executing a model. */
  async prepareModelSessionBundle(
    selection: LlmModelSelection,
    options: {
      client?: ModelClient;
      clients?: Readonly<Record<string, ModelClient>>;
      generation?: LlmGenerationConfig;
      replay?: ModelReplayBinding;
      allowedFallbackRouteIds?: readonly string[];
      streaming?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ModelSessionBundle> {
    const prepared = await this.prepare(
      selection,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const runtime = this.requireRuntime(selection.connectionId);
    const resolution = runtime.resolutions.find(
      (candidate) => candidate.revision === prepared.route.revision,
    );
    if (resolution === undefined) {
      throw new LlmProviderError(
        'LLM_NO_ROUTE',
        'The prepared model route is no longer available.',
        false,
      );
    }
    const availableFallbacks = new Set(
      runtime.resolutions.slice(1).map((candidate) => modelSessionRouteId(candidate, selection.modelId)),
    );
    for (const fallbackRouteId of options.allowedFallbackRouteIds ?? []) {
      if (!availableFallbacks.has(fallbackRouteId)) {
        throw new ModelGatewayPreparationError(
          `Fallback route ${fallbackRouteId} was not resolved for this connection and model.`,
        );
      }
    }
    const allowedFallbackRouteIds = [...(options.allowedFallbackRouteIds ?? [])];
    const createBoundSession = (
      candidate: LlmConnectionResolution,
      fallback: boolean,
    ): ModelSession => {
      const candidateCodec = canonicalCodec(candidate.protocol);
      if (candidateCodec === undefined) {
        throw new ModelGatewayPreparationError(
          `Resolved protocol ${candidate.protocol} has no canonical Model codec.`,
        );
      }
      const candidateRouteId = modelSessionRouteId(candidate, selection.modelId);
      const provider = runtime.providers.get(candidate.pluginId);
      if (provider === undefined) {
        throw new ModelGatewayPreparationError(
          `Resolved Provider Plugin ${candidate.pluginId} has no prepared Provider client.`,
        );
      }
      const replay = fallback
        ? {
            mode: 'compatible-protocol' as const,
            envelopes: options.replay?.mode !== undefined && options.replay.mode !== 'new'
              ? options.replay.envelopes
              : [],
          }
        : options.replay;
      const injectedClient = options.clients?.[candidateRouteId] ??
        (!fallback ? options.client : undefined);
      const trustedBinding = injectedClient === undefined
        ? this.trustedModelClientFactory({
            connection: runtime.connection,
            resolution: candidate,
            streaming: options.streaming ?? false,
            ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
          })
        : undefined;
      const client = injectedClient ?? trustedBinding?.client;
      if (client === undefined) {
        throw new ModelGatewayPreparationError(
          `Resolved protocol ${candidate.protocol} has no canonical Model client binding.`,
        );
      }
      const session = createModelSession({
        route: {
          routeId: candidateRouteId,
          connectionId: selection.connectionId,
          providerId: candidate.providerId,
          modelId: selection.modelId,
          protocol: candidateCodec.protocol,
          codecRevision: candidateCodec.revision,
          capabilities: Object.fromEntries(
            Object.entries(prepared.model.capabilities).map(([name, metadata]) => [
              name,
              metadata.value ?? 'unknown',
            ]),
          ),
          generationParameters: Object.fromEntries(
            Object.entries(prepared.model.generationParameters).map(([name, metadata]) => [
              name,
              metadata.value ?? 'unknown',
            ]),
          ),
          contextTokens: prepared.model.contextTokens.value,
          maxInputTokens: prepared.model.maxInputTokens.value,
          maxOutputTokens: prepared.model.maxOutputTokens.value,
          encoding: candidateCodec.protocol !== 'openai-chat'
            ? {}
            : {
                openAIChatMaxOutputTokensWireKey:
                  prepared.model.openAIChatMaxOutputTokensWireKey.value ?? 'max_tokens',
              },
          metadata: {
            source: prepared.model.contextTokens.source,
            revision: candidate.revision,
            connectionConfigurationRevision:
              runtime.connection.connectionConfigurationRevision,
            credentialRevision: runtime.connection.credentialRevision,
            digest: 'computed-by-createModelSession',
          },
          allowedFallbackRouteIds: fallback ? [] : allowedFallbackRouteIds,
          compatibility: {
            mode: 'compatible-protocol',
            family: `${selection.connectionId}:${selection.modelId}:canonical-tools-v1`,
          },
        },
        generation: this.normalizeParameters(candidate, options.generation ?? {}),
        codec: candidateCodec,
        client,
        ...(replay === undefined ? {} : { replay }),
      });
      if (trustedBinding !== undefined) {
        bindTrustedModelSessionClient(session, trustedBinding.bindingEvidence);
      }
      return session;
    };
    const primarySession = createBoundSession(resolution, false);
    const fallbackSessions = runtime.resolutions
      .slice(1)
      .filter((candidate) => allowedFallbackRouteIds.includes(
        modelSessionRouteId(candidate, selection.modelId),
      ))
      .map((candidate) => createBoundSession(candidate, true));
    return createModelSessionBundle({ primary: primarySession, fallbacks: fallbackSessions });
  }

  effectiveParameters(
    selection: LlmModelSelection,
    layers: LlmParameterLayers = {},
  ): LlmEffectiveParameters {
    const model = this.requireCatalogModel(selection);
    const layerValues: Array<[LlmParameterSource, LlmGenerationConfig | undefined]> = [
      ['provider-default', layers.providerDefaults],
      ['global', this.globalParameters],
      ['session', layers.session],
      ['request', layers.request],
    ];
    let values: LlmGenerationConfig = {};
    const sources: Partial<Record<LlmGenerationParameterName, LlmParameterSource>> = {};
    for (const [source, config] of layerValues) {
      if (!config) continue;
      values = mergeLlmGenerationConfig(values, config);
      for (const parameter of GENERATION_PARAMETER_NAMES) {
        if (config[parameter] !== undefined) sources[parameter] = source;
      }
    }
    const diagnostics: LlmParameterDiagnostic[] = [];
    for (const parameter of GENERATION_PARAMETER_NAMES) {
      if (values[parameter] === undefined) continue;
      const support = model.generationParameters[parameter];
      if (support.value === 'unsupported') {
        throw parameterError(
          selection,
          parameter,
          `Model ${selection.modelId} does not support ${parameter}.`,
          support.source,
        );
      }
      if (support.value === null || support.value === 'unknown') {
        diagnostics.push({
          parameter,
          status: 'unknown',
          message: `${parameter} support is unknown; the user value will be sent unchanged.`,
        });
      }
    }
    if (
      values.maxOutputTokens !== undefined &&
      model.maxOutputTokens.value !== null &&
      values.maxOutputTokens > model.maxOutputTokens.value
    ) {
      throw parameterError(
        selection,
        'maxOutputTokens',
        `maxOutputTokens ${values.maxOutputTokens} exceeds the discovered model limit ${model.maxOutputTokens.value}.`,
        model.maxOutputTokens.source,
      );
    }
    return {
      values: cloneGenerationConfig(values),
      sources: { ...sources },
      diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  async embed(input: {
    selection: LlmModelSelection;
    input: string[];
    dimensions?: number;
    context: LlmCallContext;
    signal?: AbortSignal;
  }): Promise<LlmEmbeddingResponse> {
    const runtime = await this.ensureReady(input.selection, input.signal);
    const resolution = runtime.resolutions[0]!;
    const provider = runtime.providers.get(resolution.pluginId)!;
    try {
      if (provider.embed === undefined) {
        throw new LlmProviderError(
          'LLM_CAPABILITY_UNSUPPORTED',
          `Model ${input.selection.modelId} does not support embeddings.`,
          false,
        );
      }
      return await provider.embed({
        model: input.selection.modelId,
        input: [...input.input],
        ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw annotateRouteError(
        this.classifyProviderError(resolution, error),
        input.selection,
        resolution,
      );
    }
  }

  async rerank(input: {
    selection: LlmModelSelection;
    query: string;
    documents: string[];
    topN?: number;
    context: LlmCallContext;
    signal?: AbortSignal;
  }): Promise<LlmRerankResponse> {
    const runtime = await this.ensureReady(input.selection, input.signal);
    const resolution = runtime.resolutions[0]!;
    const provider = runtime.providers.get(resolution.pluginId)!;
    try {
      if (provider.rerank === undefined) {
        throw new LlmProviderError(
          'LLM_CAPABILITY_UNSUPPORTED',
          `Model ${input.selection.modelId} does not support reranking.`,
          false,
        );
      }
      return await provider.rerank({
        model: input.selection.modelId,
        query: input.query,
        documents: [...input.documents],
        ...(input.topN === undefined ? {} : { topN: input.topN }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw annotateRouteError(
        this.classifyProviderError(resolution, error),
        input.selection,
        resolution,
      );
    }
  }

  private async ensureReady(
    selection: LlmModelSelection,
    signal?: AbortSignal,
  ): Promise<ConnectionRuntime> {
    return await this.withConnectionOperation(selection.connectionId, async () => {
      let runtime = this.runtimes.get(selection.connectionId);
      if (!runtime) {
        await this.discoverUnlocked(selection.connectionId, {
          inspectModelIds: [selection.modelId],
          ...(signal === undefined ? {} : { signal }),
        });
        runtime = this.requireRuntime(selection.connectionId);
      } else if (!runtime.inspectedModels.has(selection.modelId)) {
        const primary = runtime.resolutions[0]!;
        const provider = runtime.providers.get(primary.pluginId)!;
        const snapshot = await this.catalog.refresh({
          connection: runtime.connection,
          resolution: primary,
          provider,
          ...(this.registry.get(primary.pluginId)?.parameters?.support === undefined
            ? {}
            : { parameterSupport: this.registry.get(primary.pluginId)!.parameters!.support }),
          inspectModelIds: [selection.modelId],
          ...(signal === undefined ? {} : { signal }),
        });
        if (this.configuredConnections.get(selection.connectionId) !== runtime.connection) {
          this.catalog.removeConnection(selection.connectionId);
          throw new Error(`LLM connection changed while model metadata was loading.`);
        }
        runtime.inspectedModels.add(selection.modelId);
        void snapshot;
      }
      this.requireCatalogModel(selection);
      return runtime;
    });
  }

  private removeRuntime(runtime: ConnectionRuntime): void {
    this.catalog.removeConnection(runtime.connection.id);
  }

  private normalizeParameters(
    resolution: LlmConnectionResolution,
    parameters: LlmGenerationConfig,
  ): LlmGenerationConfig {
    const adapter = this.registry.get(resolution.pluginId)?.parameters;
    if (!adapter?.normalize) return cloneGenerationConfig(parameters);
    const normalized = validateLlmGenerationConfig(
      adapter.normalize(cloneGenerationConfig(parameters)),
    );
    for (const name of GENERATION_PARAMETER_NAMES) {
      if (parameters[name] !== undefined && normalized[name] === undefined) {
        throw new LlmProviderError(
          'LLM_PARAMETER_UNSUPPORTED',
          `Provider Plugin ${resolution.pluginId} removed configured parameter ${name}.`,
          false,
          undefined,
          { parameter: name, pluginId: resolution.pluginId },
        );
      }
    }
    return normalized;
  }

  private classifyProviderError(
    resolution: LlmConnectionResolution,
    error: unknown,
  ): unknown {
    const classifier = this.registry.get(resolution.pluginId)?.errors;
    if (!classifier) return error;
    let current: unknown = error;
    const visited = new Set<unknown>();
    while (!visited.has(current)) {
      visited.add(current);
      try {
        const classified = classifier.classify(current);
        if (classified !== undefined) return classified;
      } catch {
        return error;
      }
      current = current instanceof Error ? current.cause : undefined;
      if (current === undefined) break;
    }
    return error;
  }

  private withConnectionOperation<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.connectionOperationTails.get(connectionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.connectionOperationTails.set(connectionId, tail);
    void tail.finally(() => {
      if (this.connectionOperationTails.get(connectionId) === tail) {
        this.connectionOperationTails.delete(connectionId);
      }
    });
    return result;
  }

  private requireConnection(connectionId: string): LlmConnection {
    const connection = this.configuredConnections.get(connectionId);
    if (!connection) throw new Error(`LLM connection is not configured: ${connectionId}.`);
    return connection;
  }

  private requireRuntime(connectionId: string): ConnectionRuntime {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime) throw new Error(`LLM connection has not been discovered: ${connectionId}.`);
    return runtime;
  }

  private requireCatalogModel(selection: LlmModelSelection): LlmCatalogModel {
    const model = this.catalog.resolve(selection.connectionId, selection.modelId);
    if (!model) {
      throw new LlmProviderError(
        'LLM_NO_ROUTE',
        `Model ${selection.modelId} is not available on connection ${selection.connectionId}.`,
        false,
      );
    }
    return model;
  }
}

class ModelGatewayPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelGatewayPreparationError';
  }
}

function canonicalCodec(protocol: string): ModelProtocolCodec | undefined {
  if (protocol === 'openai-chat') return openAIChatCodec;
  if (protocol === 'openai-responses') return openAIResponsesCodec;
  if (protocol === 'anthropic-messages') return anthropicMessagesCodec;
  if (protocol === 'ollama-chat') return ollamaChatCodec;
  return undefined;
}

function modelSessionRouteId(
  resolution: LlmConnectionResolution,
  modelId: string,
): string {
  return `${resolution.connectionId}:${modelId}:${resolution.pluginId}:${resolution.revision}`;
}

function defaultTrustedModelClientFactory(
  context: LlmTrustedModelClientFactoryContext,
): LlmTrustedModelClientBinding | undefined {
  const { connection, resolution } = context;
  const path = resolution.protocol === 'openai-chat'
    ? '/chat/completions'
    : resolution.protocol === 'openai-responses'
      ? '/responses'
      : resolution.protocol === 'anthropic-messages'
        ? '/messages'
        : resolution.protocol === 'ollama-chat'
          ? '/api/chat'
          : undefined;
  if (path === undefined) {
    return undefined;
  }
  const Transport = context.streaming
    ? resolution.protocol === 'ollama-chat' ? NdjsonTransport : SseTransport
    : HttpJsonTransport;
  return {
    client: new Transport({
      url: appendLlmEndpointPath(resolution.providerBaseUrl, path),
      headers: canonicalModelHeaders(connection, resolution.protocol),
      ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
    }),
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  };
}

function canonicalModelHeaders(
  connection: LlmConnection,
  protocol: string,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { ...connection.headers };
  if (connection.apiKey !== undefined) {
    if (protocol === 'anthropic-messages') {
      headers['x-api-key'] = connection.apiKey;
      headers['anthropic-version'] ??= '2023-06-01';
    } else {
      headers.authorization ??= `Bearer ${connection.apiKey}`;
    }
  }
  return headers;
}

function sameConnection(left: LlmConnection, right: LlmConnection): boolean {
  if (
    !sameNonSecretConnection(left, right) ||
    left.connectionConfigurationRevision !== right.connectionConfigurationRevision ||
    left.credentialRevision !== right.credentialRevision ||
    !sameCredentialValues(left, right)
  ) {
    return false;
  }
  return true;
}

function sameNonSecretConnection(left: LlmConnection, right: LlmConnection): boolean {
  return left.id === right.id && left.name === right.name && left.endpoint === right.endpoint;
}

function sameCredentialValues(left: LlmConnection, right: LlmConnection): boolean {
  if (left.apiKey !== right.apiKey) return false;
  const leftHeaders = Object.entries(left.headers).sort(([a], [b]) => a.localeCompare(b));
  const rightHeaders = Object.entries(right.headers).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftHeaders) === JSON.stringify(rightHeaders);
}

function parameterError(
  selection: LlmModelSelection,
  parameter: LlmGenerationParameterName,
  message: string,
  metadataSource: string,
): LlmProviderError {
  return new LlmProviderError('LLM_PARAMETER_UNSUPPORTED', message, false, undefined, {
    connectionId: selection.connectionId,
    modelId: selection.modelId,
    parameter,
    metadataSource,
  });
}

function annotateRouteError(
  error: unknown,
  selection: LlmModelSelection,
  resolution: LlmConnectionResolution,
): LlmProviderError {
  const normalized = error instanceof LlmProviderError
    ? error
    : new LlmProviderError(
        'LLM_PROVIDER_ERROR',
        error instanceof Error ? error.message : String(error),
        false,
      );
  return new LlmProviderError(
    normalized.code,
    normalized.message,
    normalized.retryable,
    normalized.statusCode,
    {
      ...(normalized.detail ?? {}),
      connectionId: selection.connectionId,
      modelId: selection.modelId,
      pluginId: resolution.pluginId,
      routeRevision: resolution.revision,
    },
  );
}

function cloneGenerationConfig(config: LlmGenerationConfig): LlmGenerationConfig {
  return {
    ...config,
    ...(config.stop === undefined ? {} : { stop: [...config.stop] }),
  };
}

function isResolvedConnection(
  input: LlmConnectionInput | LlmConnection,
): input is LlmConnection {
  return 'id' in input &&
    'connectionConfigurationRevision' in input &&
    'credentialRevision' in input;
}
