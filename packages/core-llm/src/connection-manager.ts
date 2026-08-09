import { randomUUID } from 'node:crypto';
import { createBuiltinLlmProviderPlugins } from './builtin-provider-plugins.js';
import type { RoundContext } from '@dbagent/core-usage';
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
import { openAIChatCodec } from './protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from './protocol/codecs/openai-responses.js';
import { anthropicMessagesCodec } from './protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from './protocol/codecs/ollama-chat.js';
import type { ModelProtocolCodec } from './protocol/codec.js';
import { ModelCodecRegistryError } from './protocol/codec-registry.js';
import {
  bindTrustedModelSessionClient,
  type ModelClientBindingMetadata,
} from './model-client-binding.js';
import {
  LlmGateway,
  ModelExecutionGateway,
  modelGatewayToLegacyError,
  type LlmGatewayChatInput,
  type LlmGatewayContext,
  type LlmGatewayResult,
} from './llm-gateway.js';
import {
  legacyAttemptToResponse,
  legacyRequestToCanonical,
  legacyProviderCodec,
  LegacyProviderModelClient,
} from './legacy-model-compatibility.js';
import { assertNoTextualToolInvocation } from './tool-protocol.js';
import { LlmTaskRouter } from './routing.js';
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
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmEmbeddingResponse,
  type LlmGenerationConfig,
  type LlmGenerationParameterName,
  type LlmProvider,
  type LlmProviderCapabilities,
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

export type LlmParameterSource = 'provider-default' | 'project' | 'session' | 'request';

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

type LlmManagedChatRequest = Omit<
  LlmChatRequest,
  'model' | 'temperature' | 'topP' | 'maxTokens' | 'seed' | 'stop' | 'reasoning'
>;

export type LlmConnectionManagerChatInput = {
  selection: LlmModelSelection;
  request: LlmManagedChatRequest;
  context: LlmGatewayContext;
  sessionParameters?: LlmGenerationConfig;
  parameters?: LlmGenerationConfig;
  round?: RoundContext;
  /** Agent runtimes validate tool calls at their own execution boundary. */
  validateToolCalls?: boolean;
  /** Explicitly freezes all resolved compatible protocol alternatives into this Run bundle. */
  allowCompatibleProtocolFallbacks?: boolean;
  gateway?: Pick<
    LlmGatewayChatInput,
    | 'task'
    | 'policies'
    | 'budget'
    | 'cache'
    | 'timeoutMs'
    | 'maxRetries'
    | 'maxStructuredCorrections'
  >;
};

export type LlmConnectionManagerChatResult = {
  response: LlmChatResponse;
  route: LlmResolvedRoute;
  effectiveParameters: LlmEffectiveParameters;
  protocolAttempts: readonly string[];
  gateway: LlmGatewayResult;
};

export type LlmTrustedModelClientFactoryContext = Readonly<{
  connection: LlmConnection;
  resolution: LlmConnectionResolution;
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
  projectParameters?: LlmGenerationConfig;
  gateway?: LlmGateway;
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
  readonly gateway: LlmGateway;
  readonly catalog: LlmModelCatalogManager;

  private readonly registry: LlmProviderPluginRegistry;
  private readonly resolver: LlmConnectionResolver;
  private readonly configuredConnections = new Map<string, LlmConnection>();
  private readonly runtimes = new Map<string, ConnectionRuntime>();
  private readonly connectionOperationTails = new Map<string, Promise<void>>();
  private readonly fetchImpl: LlmFetch | undefined;
  private readonly trustedModelClientFactory: LlmTrustedModelClientFactory;
  private projectParameters: LlmGenerationConfig;

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
    this.gateway = options.gateway ?? new LlmGateway();
    this.catalog =
      options.catalogManager ??
      new LlmModelCatalogManager({ store: new LlmModelCatalogStore(options.cacheDirectory) });
    this.projectParameters = validateLlmGenerationConfig({
      ...(options.projectParameters ?? {}),
    });
  }

  replaceConnections(inputs: readonly (LlmConnectionInput | LlmConnection)[]): LlmConnection[] {
    const next = new Map<string, LlmConnection>();
    for (const input of inputs) {
      const candidate = isResolvedConnection(input) ? input : createLlmConnection(input);
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
    return this.connections();
  }

  connections(): LlmConnection[] {
    return [...this.configuredConnections.values()].map((connection) => ({
      ...connection,
      headers: { ...connection.headers },
    }));
  }

  setProjectParameters(parameters: LlmGenerationConfig): void {
    this.projectParameters = validateLlmGenerationConfig({ ...parameters });
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
    const previous = this.runtimes.get(connectionId);
    if (previous) this.unregisterRuntimeProviders(previous);
    const runtime: ConnectionRuntime = {
      connection,
      resolutions: Object.freeze(usableResolutions),
      providers,
      inspectedModels: new Set(options.inspectModelIds ?? []),
    };
    this.runtimes.set(connectionId, runtime);
    this.registerRuntime(runtime, catalog.models);
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
      signal?: AbortSignal;
    },
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
      const candidateCodec = canonicalCodec(candidate.protocol) ??
        (candidate.protocol === 'legacy-normalized'
          ? legacyProviderCodec
          : undefined);
      if (candidateCodec === undefined) {
        throw new ModelCodecRegistryError(candidate.protocol, `${candidate.protocol}@1`);
      }
      const candidateRouteId = modelSessionRouteId(candidate, selection.modelId);
      const provider = runtime.providers.get(candidate.pluginId);
      if (provider === undefined) {
        throw new ModelGatewayPreparationError(
          `Resolved Provider Plugin ${candidate.pluginId} has no prepared Provider client.`,
        );
      }
      const replay = fallback && candidateCodec.protocol !== 'legacy-normalized'
        ? {
            mode: 'compatible-protocol' as const,
            envelopes: options.replay?.mode !== undefined && options.replay.mode !== 'new'
              ? options.replay.envelopes
              : [],
          }
        : candidateCodec.protocol === 'legacy-normalized'
          ? { mode: 'new' as const }
          : options.replay;
      const injectedClient = options.clients?.[candidateRouteId] ??
        (!fallback ? options.client : undefined);
      const trustedBinding = injectedClient === undefined
        ? this.trustedModelClientFactory({
            connection: runtime.connection,
            resolution: candidate,
            ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
          })
        : undefined;
      const client = injectedClient ?? trustedBinding?.client ??
        new LegacyProviderModelClient(provider, false);
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
      ['project', this.projectParameters],
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

  async executeChat(input: LlmConnectionManagerChatInput): Promise<LlmConnectionManagerChatResult> {
    const runtime = await this.ensureReady(input.selection, input.request.signal);
    const effective = this.effectiveParameters(input.selection, {
      ...(input.sessionParameters === undefined ? {} : { session: input.sessionParameters }),
      ...(input.parameters === undefined ? {} : { request: input.parameters }),
    });
    const allowedFallbackRouteIds = input.allowCompatibleProtocolFallbacks
      ? runtime.resolutions.slice(1).map((resolution) =>
          modelSessionRouteId(resolution, input.selection.modelId))
      : [];
    let bundle: ModelSessionBundle;
    try {
      bundle = await this.prepareModelSessionBundle(input.selection, {
        generation: effective.values,
        allowedFallbackRouteIds,
        ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
      });
    } catch (error) {
      if (error instanceof ModelCodecRegistryError) {
        throw annotateRouteError(
          new LlmProviderError(
            'LLM_MODEL_BINDING_INVALID',
            error.message,
            false,
            undefined,
            { modelGatewayCode: error.code },
          ),
          input.selection,
          runtime.resolutions[0]!,
        );
      }
      throw annotateRouteError(
        modelGatewayToLegacyError(this.classifyProviderError(runtime.resolutions[0]!, error)),
        input.selection,
        runtime.resolutions[0]!,
      );
    }
    let execution;
    try {
      execution = await new ModelExecutionGateway().executeAttempt(
        bundle,
        legacyRequestToCanonical(input.request, input.selection.modelId),
        {
          maxRetries: input.gateway?.maxRetries ?? 0,
          ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
          ...(input.gateway?.timeoutMs === undefined
            ? {}
            : {
                timeouts: {
                  connectMs: input.gateway.timeoutMs,
                  firstEventMs: input.gateway.timeoutMs,
                  idleMs: input.gateway.timeoutMs,
                  totalMs: input.gateway.timeoutMs,
                },
              }),
        },
      );
    } catch (error) {
      const primaryResolution = runtime.resolutions[0]!;
      throw annotateRouteError(
        modelGatewayToLegacyError(this.classifyProviderError(primaryResolution, error)),
        input.selection,
        primaryResolution,
      );
    }
    const response = legacyAttemptToResponse(
      execution.attempt.blocks,
      execution.attempt.usage,
      execution.attempt.providerResponseId,
    );
    if (execution.attempt.finishReason !== undefined) {
      response.finishReason = execution.attempt.finishReason;
    }
    assertNoTextualToolInvocation({
      text: response.text,
      toolCalls: response.toolCalls,
      toolsRequested: Boolean(input.request.tools?.length),
      toolNames: input.request.tools?.map((tool) => tool.name) ?? [],
      protocol: execution.session.route.protocol,
    });
    const selectedResolution = runtime.resolutions.find((resolution) =>
      modelSessionRouteId(resolution, input.selection.modelId) === execution.session.route.routeId);
    if (selectedResolution === undefined) {
      throw new LlmProviderError('LLM_NO_ROUTE', 'Validated Session route left the prepared bundle.', false);
    }
    const registered = this.gateway.registry.find(
      selectedResolution.providerId,
      input.selection.modelId,
    );
    if (registered === undefined) {
      throw new LlmProviderError('LLM_NO_ROUTE', 'Prepared model is missing from the Gateway registry.', false);
    }
    const routeDecision = new LlmTaskRouter(this.gateway.registry).route({
      task: {
        taskType: input.context.taskType,
        requirements: { requiredModelIds: [registered.id] },
      },
    });
    const usage = response.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: true,
    };
    response.usage = usage;
    const protocolAttempts = [
      ...execution.discardedAttempts.map((discarded) =>
        runtime.resolutions.find((resolution) =>
          modelSessionRouteId(resolution, input.selection.modelId) === discarded.routeId)?.protocol ??
          'unknown'),
      selectedResolution.protocol,
    ];
    return {
      response,
      route: this.resolver.resolveRoute(selectedResolution, input.selection.modelId),
      effectiveParameters: effective,
      protocolAttempts,
      gateway: {
        requestId: input.context.requestId ?? randomUUID(),
        traceId: input.context.traceId ?? input.context.requestId ?? randomUUID(),
        response,
        route: routeDecision,
        providerId: selectedResolution.providerId,
        modelId: registered.id,
        attempts: execution.discardedAttempts.length + 1,
        cacheHit: false,
        usage,
      },
    };
  }

  async chat(input: LlmConnectionManagerChatInput): Promise<LlmChatResponse> {
    return (await this.executeChat(input)).response;
  }

  async *stream(input: LlmConnectionManagerChatInput): AsyncIterable<LlmChatStreamEvent> {
    const result = await this.executeChat(input);
    if (result.response.text) yield { type: 'text-delta', text: result.response.text };
    for (const toolCall of result.response.toolCalls) yield { type: 'tool-call', toolCall };
    if (result.response.usage) yield { type: 'usage', usage: result.response.usage };
    yield {
      type: 'finish',
      response: result.response,
      ...(result.response.finishReason === undefined
        ? {}
        : { reason: result.response.finishReason }),
    };
  }

  async embed(input: {
    selection: LlmModelSelection;
    input: string[];
    dimensions?: number;
    context: LlmGatewayContext;
    signal?: AbortSignal;
  }): Promise<LlmEmbeddingResponse> {
    const runtime = await this.ensureReady(input.selection, input.signal);
    const resolution = runtime.resolutions[0]!;
    const provider = runtime.providers.get(resolution.pluginId)!;
    this.registerProviderModel(provider, resolution, this.requireCatalogModel(input.selection));
    try {
      return await this.gateway.embed({
        providerId: provider.id,
        request: {
          model: input.selection.modelId,
          input: [...input.input],
          ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        context: input.context,
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
    context: LlmGatewayContext;
    signal?: AbortSignal;
  }): Promise<LlmRerankResponse> {
    const runtime = await this.ensureReady(input.selection, input.signal);
    const resolution = runtime.resolutions[0]!;
    const provider = runtime.providers.get(resolution.pluginId)!;
    this.registerProviderModel(provider, resolution, this.requireCatalogModel(input.selection));
    try {
      return await this.gateway.rerank({
        providerId: provider.id,
        request: {
          model: input.selection.modelId,
          query: input.query,
          documents: [...input.documents],
          ...(input.topN === undefined ? {} : { topN: input.topN }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        context: input.context,
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
        this.registerRuntime(runtime, snapshot.models);
      }
      this.requireCatalogModel(selection);
      return runtime;
    });
  }

  private registerRuntime(runtime: ConnectionRuntime, models: readonly LlmCatalogModel[]): void {
    for (const resolution of runtime.resolutions) {
      const provider = runtime.providers.get(resolution.pluginId);
      if (!provider) continue;
      this.gateway.registry.removeProvider(provider.id);
      this.gateway.registerProvider(provider);
      for (const model of models) this.registerProviderModel(provider, resolution, model);
    }
  }

  private registerProviderModel(
    provider: LlmProvider,
    resolution: LlmConnectionResolution,
    model: LlmCatalogModel,
  ): void {
    this.gateway.registerModel({
      providerId: provider.id,
      model: model.modelId,
      displayName: model.displayName.value ?? model.modelId,
      protocol: resolution.protocol,
      capabilities: gatewayCapabilities(model, provider),
      generationParameters: Object.fromEntries(
        Object.entries(model.generationParameters).map(([name, value]) => [
          name,
          value.value ?? 'unknown',
        ]),
      ),
      limits: {
        contextTokens: model.contextTokens.value,
        maxInputTokens: model.maxInputTokens.value,
        maxOutputTokens: model.maxOutputTokens.value,
      },
      ...(model.pricing.value === null ? {} : { pricing: model.pricing.value }),
    });
  }

  private removeRuntime(runtime: ConnectionRuntime): void {
    this.unregisterRuntimeProviders(runtime);
    this.catalog.removeConnection(runtime.connection.id);
  }

  private unregisterRuntimeProviders(runtime: ConnectionRuntime): void {
    for (const provider of runtime.providers.values()) this.gateway.registry.removeProvider(provider.id);
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
  return {
    client: new HttpJsonTransport({
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
    left.id !== right.id ||
    left.name !== right.name ||
    left.endpoint !== right.endpoint ||
    left.connectionConfigurationRevision !== right.connectionConfigurationRevision ||
    left.credentialRevision !== right.credentialRevision ||
    left.credentialScope !== right.credentialScope
  ) {
    return false;
  }
  const leftHeaders = Object.entries(left.headers).sort(([a], [b]) => a.localeCompare(b));
  const rightHeaders = Object.entries(right.headers).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftHeaders) === JSON.stringify(rightHeaders);
}

function gatewayCapabilities(
  model: LlmCatalogModel,
  provider: LlmProvider,
): Partial<LlmProviderCapabilities> {
  const result = Object.fromEntries(
    Object.entries(model.capabilities).map(([name, value]) => [name, value.value ?? 'unknown']),
  ) as Partial<LlmProviderCapabilities>;
  result.chat = result.chat === 'unsupported' ? 'unsupported' : 'supported';
  result.streaming = provider.stream ? 'supported' : 'unsupported';
  if (model.roles.embedding.value === true) result.embeddings = 'supported';
  if (model.roles.rerank.value === true) result.rerank = 'supported';
  // A fixed user route is allowed to try protocol-level features whose model
  // support is unknown. Known unsupported values remain blocked.
  if (result.toolCalling === 'unknown') result.toolCalling = 'supported';
  if (result.structuredOutput === 'unknown') result.structuredOutput = 'supported';
  return result;
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
    'credentialRevision' in input &&
    'credentialScope' in input;
}
