import type { LlmConnection } from './llm-connection.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalogSnapshot } from './model-catalog.js';
import type {
  LlmModelCatalogStore,
  LlmCachedEndpointModel,
  LlmModelCatalogCacheKey,
} from './model-catalog-store.js';
import {
  LlmModelsDevIndex,
  classifyLlmModelRoles,
  mergeLlmCatalogModel,
  type LlmCatalogModel,
  type LlmMetadataSource,
  type LlmModelMetadataCandidate,
  type LlmModelRole,
} from './model-metadata.js';
import type { LlmConnectionResolution } from './provider-plugin.js';
import type {
  LlmGenerationParameterSupport,
  LlmModelMetadata,
  LlmProvider,
} from './types.js';

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const MAX_INSPECTED_MODELS_PER_REFRESH = 32;

export type LlmCatalogSnapshot = {
  connectionId: string;
  fetchedAt: string;
  stale: boolean;
  models: readonly LlmCatalogModel[];
};

export type LlmModelCatalogFilter = {
  connectionId?: string;
  role?: LlmModelRole;
};

export type LlmModelCatalogRefreshInput = {
  connection: LlmConnection;
  resolution: LlmConnectionResolution;
  provider: LlmProvider;
  parameterSupport?: Partial<LlmGenerationParameterSupport>;
  inspectModelIds?: readonly string[];
  ttlMs?: number;
  etag?: string;
  signal?: AbortSignal;
};

export class LlmModelCatalogManager {
  private readonly store: LlmModelCatalogStore;
  private readonly modelsDev: LlmModelsDevIndex;
  private readonly now: () => number;
  private readonly snapshots = new Map<string, LlmCatalogSnapshot>();

  constructor(options: {
    store: LlmModelCatalogStore;
    catalog?: ModelCatalogSnapshot;
    now?: () => number;
  }) {
    this.store = options.store;
    this.modelsDev = new LlmModelsDevIndex(options.catalog ?? DEFAULT_MODEL_CATALOG);
    this.now = options.now ?? Date.now;
  }

  async refresh(input: LlmModelCatalogRefreshInput): Promise<LlmCatalogSnapshot> {
    assertMatchingResolution(input.connection, input.resolution);
    const cacheKey = modelCacheKey(input.connection, input.resolution);
    try {
      const modelIds = uniqueModelIds(
        input.resolution.models.length > 0
          ? input.resolution.models
          : await requireModelList(input.provider, input.signal),
      );
      const inspect = uniqueModelIds(input.inspectModelIds ?? []);
      if (inspect.length > MAX_INSPECTED_MODELS_PER_REFRESH) {
        throw new Error(`At most ${MAX_INSPECTED_MODELS_PER_REFRESH} models can be inspected per refresh.`);
      }
      const metadata = new Map<string, LlmModelMetadata>();
      if (inspect.length > 0 && input.provider.getModelMetadata) {
        const values = await Promise.all(
          inspect.map(async (modelId) => [
            modelId,
            await input.provider.getModelMetadata!(modelId, input.signal),
          ] as const),
        );
        for (const [modelId, value] of values) metadata.set(modelId, value);
      }
      const fetchedAt = new Date(this.now()).toISOString();
      const cachedModels = modelIds.map((modelId) => ({
        modelId,
        metadata: metadataToCache(metadata.get(modelId)),
      }));
      await this.store.write(cacheKey, {
        fetchedAt,
        ttlMs: input.ttlMs ?? DEFAULT_CACHE_TTL_MS,
        ...(input.etag === undefined ? {} : { etag: input.etag }),
        models: cachedModels,
      });
      return this.installSnapshot(input, cachedModels, 'endpoint', fetchedAt, false);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const cached = await this.store.read(cacheKey);
      if (!cached) throw error;
      return this.installSnapshot(
        input,
        cached.snapshot.models,
        'endpoint-cache',
        cached.snapshot.fetchedAt,
        true,
      );
    }
  }

  models(filter: LlmModelCatalogFilter = {}): LlmCatalogModel[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => !filter.connectionId || snapshot.connectionId === filter.connectionId)
      .flatMap((snapshot) => snapshot.models)
      .filter((model) => !filter.role || model.roles[filter.role].value === true)
      .map(cloneCatalogModel)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(connectionId: string, modelId: string): LlmCatalogModel | undefined {
    const model = this.snapshots
      .get(connectionId)
      ?.models.find((candidate) => candidate.modelId === modelId);
    return model ? cloneCatalogModel(model) : undefined;
  }

  snapshot(connectionId: string): LlmCatalogSnapshot | undefined {
    const snapshot = this.snapshots.get(connectionId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  removeConnection(connectionId: string): boolean {
    return this.snapshots.delete(connectionId);
  }

  private installSnapshot(
    input: LlmModelCatalogRefreshInput,
    endpointModels: readonly LlmCachedEndpointModel[],
    endpointSource: Extract<LlmMetadataSource, 'endpoint' | 'endpoint-cache'>,
    fetchedAt: string,
    stale: boolean,
  ): LlmCatalogSnapshot {
    const providerHint =
      this.modelsDev.providerForEndpoint(input.resolution.providerBaseUrl) ??
      providerCatalogHint(input.resolution);
    const models = endpointModels.map((endpointModel) => {
      const endpointCandidate = cachedModelCandidate(endpointModel, endpointSource, fetchedAt);
      const heuristicRoles = classifyLlmModelRoles(
        endpointModel.modelId,
        endpointModel.metadata.family,
      );
      const pluginCandidate: LlmModelMetadataCandidate = {
        source: 'provider-plugin',
        displayName: endpointModel.modelId,
        roles: heuristicRoles,
        ...(input.provider.capabilities === undefined
          ? {}
          : { capabilities: input.provider.capabilities }),
        ...(input.provider.generationParameters === undefined && input.parameterSupport === undefined
          ? {}
          : {
              generationParameters: {
                ...(input.provider.generationParameters ?? {}),
                ...(input.parameterSupport ?? {}),
              },
            }),
      };
      const modelsDev = this.modelsDev.resolve(endpointModel.modelId, providerHint);
      return mergeLlmCatalogModel({
        connectionId: input.connection.id,
        modelId: endpointModel.modelId,
        candidates: [endpointCandidate, pluginCandidate, ...(modelsDev ? [modelsDev] : [])],
      });
    });
    const snapshot: LlmCatalogSnapshot = Object.freeze({
      connectionId: input.connection.id,
      fetchedAt,
      stale,
      models: Object.freeze(models.map((model) => Object.freeze(model))),
    });
    this.snapshots.set(input.connection.id, snapshot);
    return cloneSnapshot(snapshot);
  }
}

function cachedModelCandidate(
  model: LlmCachedEndpointModel,
  source: Extract<LlmMetadataSource, 'endpoint' | 'endpoint-cache'>,
  observedAt: string,
): LlmModelMetadataCandidate {
  const metadata = model.metadata;
  const capabilities = metadata.capabilities ?? {};
  return {
    source,
    observedAt,
    displayName: model.modelId,
    ...(metadata.contextTokens === undefined ? {} : { contextTokens: metadata.contextTokens }),
    ...(metadata.maxInputTokens === undefined ? {} : { maxInputTokens: metadata.maxInputTokens }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.family === undefined ? {} : { family: metadata.family }),
    ...(metadata.parameterSize === undefined ? {} : { parameterSize: metadata.parameterSize }),
    ...(metadata.quantization === undefined ? {} : { quantization: metadata.quantization }),
    capabilities,
    ...(metadata.generationParameters === undefined
      ? {}
      : { generationParameters: metadata.generationParameters }),
    roles: {
      ...(capabilities.chat === undefined || capabilities.chat === 'unknown'
        ? {}
        : { generation: capabilities.chat === 'supported' }),
      ...(capabilities.embeddings === undefined || capabilities.embeddings === 'unknown'
        ? {}
        : { embedding: capabilities.embeddings === 'supported' }),
      ...(capabilities.rerank === undefined || capabilities.rerank === 'unknown'
        ? {}
        : { rerank: capabilities.rerank === 'supported' }),
      ...(capabilities.vision === undefined || capabilities.vision === 'unknown'
        ? {}
        : { vision: capabilities.vision === 'supported' }),
    },
  };
}

function metadataToCache(metadata?: LlmModelMetadata): LlmCachedEndpointModel['metadata'] {
  if (!metadata) return {};
  return {
    capabilities: { ...metadata.capabilities },
    ...(metadata.contextTokens === undefined ? {} : { contextTokens: metadata.contextTokens }),
    ...(metadata.maxInputTokens === undefined ? {} : { maxInputTokens: metadata.maxInputTokens }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.generationParameters === undefined
      ? {}
      : { generationParameters: { ...metadata.generationParameters } }),
    ...(metadata.family === undefined ? {} : { family: metadata.family }),
    ...(metadata.parameterSize === undefined ? {} : { parameterSize: metadata.parameterSize }),
    ...(metadata.quantization === undefined ? {} : { quantization: metadata.quantization }),
  };
}

function providerCatalogHint(resolution: LlmConnectionResolution): string | undefined {
  if (resolution.pluginId === 'openai-responses') return 'openai';
  if (resolution.pluginId === 'anthropic-messages') return 'anthropic';
  if (resolution.pluginId === 'ollama-native') return 'ollama';
  return undefined;
}

function modelCacheKey(
  connection: LlmConnection,
  resolution: LlmConnectionResolution,
): LlmModelCatalogCacheKey {
  return {
    connectionId: connection.id,
    credentialScope: connection.credentialScope,
    pluginId: resolution.pluginId,
    pluginVersion: resolution.pluginVersion,
  };
}

async function requireModelList(provider: LlmProvider, signal?: AbortSignal): Promise<string[]> {
  if (!provider.listModels) throw new Error('The resolved Provider does not expose a model catalog.');
  return provider.listModels(signal);
}

function assertMatchingResolution(
  connection: LlmConnection,
  resolution: LlmConnectionResolution,
): void {
  if (connection.id !== resolution.connectionId) {
    throw new Error('The model catalog resolution belongs to a different LLM connection.');
  }
}

function uniqueModelIds(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function cloneCatalogModel(model: LlmCatalogModel): LlmCatalogModel {
  return structuredClone(model);
}

function cloneSnapshot(snapshot: LlmCatalogSnapshot): LlmCatalogSnapshot {
  return {
    connectionId: snapshot.connectionId,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    models: snapshot.models.map(cloneCatalogModel),
  };
}
