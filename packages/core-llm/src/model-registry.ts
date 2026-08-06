import {
  UNKNOWN_LLM_CAPABILITIES,
  UNKNOWN_LLM_GENERATION_PARAMETERS,
  type LlmCapabilityName,
  type LlmCapabilityStatus,
  type LlmGenerationParameterSupport,
  type LlmModelMetadata,
  type LlmProvider,
  type LlmProviderCapabilities,
  type LlmProviderMode,
} from './types.js';
import {
  DEFAULT_MODEL_CATALOG,
  resolveModelCatalogMetadata,
  type ModelCatalogSnapshot,
} from './model-catalog.js';

export type LlmDataPolicy = {
  deployment: 'public-cloud' | 'domestic-cloud' | 'private';
  regions: string[];
  retainsPrompts: boolean | 'unknown';
  allowsSensitiveData: boolean | 'unknown';
};

export type LlmModelPricing = {
  currency: 'CNY' | 'USD';
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
};

export type LlmModelLimits = {
  contextTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrency?: number;
};

export type LlmModelQuality = 'economy' | 'balanced' | 'advanced';

export type LlmModelProfile = {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  enabled: boolean;
  mode: LlmProviderMode;
  protocol: string;
  capabilities: LlmProviderCapabilities;
  generationParameters: LlmGenerationParameterSupport;
  limits: LlmModelLimits;
  dataPolicy: LlmDataPolicy;
  quality: LlmModelQuality;
  pricing?: LlmModelPricing;
  tags?: string[];
  canonicalModel?: string;
};

export type LlmModelHealth = {
  state: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  checkedAt?: string;
  latencyMs?: number;
  detail?: string;
  consecutiveFailures: number;
};

export type LlmModelDiscoveryRecord = {
  source: LlmModelMetadata['source'];
  sources: LlmModelMetadata['source'][];
  discoveredAt: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
};

export type RegisteredLlmModel = LlmModelProfile & {
  health: LlmModelHealth;
  discovery?: LlmModelDiscoveryRecord;
};

export type RegisterModelInput = Omit<
  LlmModelProfile,
  | 'id'
  | 'displayName'
  | 'enabled'
  | 'mode'
  | 'protocol'
  | 'capabilities'
  | 'generationParameters'
  | 'limits'
  | 'dataPolicy'
  | 'quality'
> & {
  id?: string;
  displayName?: string;
  enabled?: boolean;
  mode?: LlmProviderMode;
  protocol?: string;
  capabilities?: Partial<LlmProviderCapabilities>;
  limits?: Partial<LlmModelLimits>;
  dataPolicy?: Partial<LlmDataPolicy>;
  quality?: LlmModelQuality;
  canonicalModel?: string;
  generationParameters?: Partial<LlmGenerationParameterSupport>;
};

const DEFAULT_LIMITS: LlmModelLimits = {
  contextTokens: null,
  maxInputTokens: null,
  maxOutputTokens: null,
};

const DEFAULT_DATA_POLICY: LlmDataPolicy = {
  deployment: 'public-cloud',
  regions: [],
  retainsPrompts: 'unknown',
  allowsSensitiveData: 'unknown',
};

export class LlmModelRegistry {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly models = new Map<string, RegisteredLlmModel>();

  constructor(
    private readonly options: { catalog?: ModelCatalogSnapshot } = {},
  ) {}

  registerProvider(provider: LlmProvider): void {
    requireIdentifier(provider.id, 'provider.id');
    this.providers.set(provider.id, provider);
  }

  removeProvider(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    for (const [id, model] of this.models) {
      if (model.providerId === providerId) {
        this.models.delete(id);
      }
    }
    return removed;
  }

  provider(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): LlmProvider[] {
    return [...this.providers.values()];
  }

  registerModel(input: RegisterModelInput): RegisteredLlmModel {
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new Error(`LLM provider is not registered: ${input.providerId}`);
    requireIdentifier(input.model, 'model');
    const id = input.id?.trim() || `${input.providerId}:${input.model}`;
    requireIdentifier(id, 'model.id');

    const catalogMetadata = resolveModelCatalogMetadata({
      catalog: this.options.catalog ?? DEFAULT_MODEL_CATALOG,
      providerId: input.providerId,
      model: input.model,
      ...(input.canonicalModel?.trim()
        ? { canonicalModel: input.canonicalModel.trim() }
        : {}),
    });
    const capabilities = mergeCapabilities(
      provider,
      catalogMetadata?.metadata.capabilities,
      input.capabilities,
    );
    const generationParameters: LlmGenerationParameterSupport = {
      ...UNKNOWN_LLM_GENERATION_PARAMETERS,
      ...provider.generationParameters,
      ...catalogMetadata?.metadata.generationParameters,
      ...input.generationParameters,
    };
    const limits: LlmModelLimits = {
      contextTokens: nullablePositiveInteger(
        input.limits?.contextTokens ??
          catalogMetadata?.metadata.contextTokens ??
          DEFAULT_LIMITS.contextTokens,
        'contextTokens',
      ),
      maxInputTokens: nullablePositiveInteger(
        input.limits?.maxInputTokens ??
          catalogMetadata?.metadata.maxInputTokens ??
          DEFAULT_LIMITS.maxInputTokens,
        'maxInputTokens',
      ),
      maxOutputTokens: nullablePositiveInteger(
        input.limits?.maxOutputTokens ??
          catalogMetadata?.metadata.maxOutputTokens ??
          DEFAULT_LIMITS.maxOutputTokens,
        'maxOutputTokens',
      ),
      ...(input.limits?.requestsPerMinute === undefined
        ? {}
        : { requestsPerMinute: positiveInteger(input.limits.requestsPerMinute, 'requestsPerMinute') }),
      ...(input.limits?.tokensPerMinute === undefined
        ? {}
        : { tokensPerMinute: positiveInteger(input.limits.tokensPerMinute, 'tokensPerMinute') }),
      ...(input.limits?.maxConcurrency === undefined
        ? {}
        : { maxConcurrency: positiveInteger(input.limits.maxConcurrency, 'maxConcurrency') }),
    };
    const dataPolicy: LlmDataPolicy = {
      deployment: input.dataPolicy?.deployment ?? deploymentFromMode(input.mode ?? provider.mode),
      regions: [...(input.dataPolicy?.regions ?? DEFAULT_DATA_POLICY.regions)],
      retainsPrompts: input.dataPolicy?.retainsPrompts ?? DEFAULT_DATA_POLICY.retainsPrompts,
      allowsSensitiveData: input.dataPolicy?.allowsSensitiveData ?? DEFAULT_DATA_POLICY.allowsSensitiveData,
    };
    const previous = this.models.get(id);
    const profile: RegisteredLlmModel = {
      id,
      providerId: input.providerId,
      model: input.model.trim(),
      displayName: input.displayName?.trim() || input.model.trim(),
      enabled: input.enabled ?? true,
      mode: input.mode ?? provider.mode,
      protocol: input.protocol?.trim() || provider.protocol || 'custom',
      capabilities,
      generationParameters,
      limits,
      dataPolicy,
      quality: input.quality ?? 'balanced',
      ...(input.pricing === undefined && catalogMetadata?.pricing === undefined
        ? {}
        : {
            pricing: normalizePricing(
              input.pricing ?? catalogMetadata!.pricing!,
            ),
          }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
      ...(input.canonicalModel?.trim()
        ? { canonicalModel: input.canonicalModel.trim() }
        : catalogMetadata === undefined
          ? {}
          : { canonicalModel: catalogMetadata.canonicalModel }),
      health: previous?.health ?? { state: 'unknown', consecutiveFailures: 0 },
      ...(previous?.discovery !== undefined
        ? { discovery: { ...previous.discovery, sources: [...previous.discovery.sources] } }
        : catalogMetadata === undefined
          ? {}
          : {
              discovery: {
                source: 'models-dev',
                sources: ['models-dev'],
                discoveredAt: catalogMetadata.generatedAt,
                ...(catalogMetadata.metadata.family === undefined
                  ? {}
                  : { family: catalogMetadata.metadata.family }),
              },
            }),
    };
    this.models.set(id, profile);
    return cloneModel(profile);
  }

  model(id: string): RegisteredLlmModel | undefined {
    const model = this.models.get(id);
    return model ? cloneModel(model) : undefined;
  }

  find(providerId: string, model: string): RegisteredLlmModel | undefined {
    const result = [...this.models.values()].find(
      (candidate) => candidate.providerId === providerId && candidate.model === model,
    );
    return result ? cloneModel(result) : undefined;
  }

  listModels(options: { enabledOnly?: boolean } = {}): RegisteredLlmModel[] {
    return [...this.models.values()]
      .filter((model) => !options.enabledOnly || model.enabled)
      .map(cloneModel)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  setEnabled(id: string, enabled: boolean): RegisteredLlmModel {
    const current = this.requireModel(id);
    current.enabled = enabled;
    return cloneModel(current);
  }

  updateHealth(id: string, update: Omit<LlmModelHealth, 'consecutiveFailures'>): RegisteredLlmModel {
    const current = this.requireModel(id);
    current.health = {
      ...update,
      consecutiveFailures:
        update.state === 'healthy' ? 0 : Math.max(1, current.health.consecutiveFailures + 1),
    };
    return cloneModel(current);
  }

  updateCapability(id: string, capability: LlmCapabilityName, status: LlmCapabilityStatus): RegisteredLlmModel {
    const current = this.requireModel(id);
    current.capabilities[capability] = status;
    return cloneModel(current);
  }

  applyModelMetadata(
    id: string,
    input: LlmModelMetadata,
    discoveredAt = new Date(),
  ): RegisteredLlmModel {
    const current = this.requireModel(id);
    current.capabilities = { ...current.capabilities, ...input.capabilities };
    current.generationParameters = {
      ...current.generationParameters,
      ...input.generationParameters,
    };
    current.limits = {
      ...current.limits,
      ...(input.contextTokens === undefined
        ? {}
        : { contextTokens: positiveInteger(input.contextTokens, 'contextTokens') }),
      ...(input.maxInputTokens === undefined
        ? {}
        : { maxInputTokens: positiveInteger(input.maxInputTokens, 'maxInputTokens') }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: positiveInteger(input.maxOutputTokens, 'maxOutputTokens') }),
    };
    const previousSources = current.discovery?.sources ?? [];
    const sources = [...new Set([...previousSources, input.source])];
    const previousSource = current.discovery?.source;
    const family = input.family ?? current.discovery?.family;
    const parameterSize = input.parameterSize ?? current.discovery?.parameterSize;
    const quantization = input.quantization ?? current.discovery?.quantization;
    current.discovery = {
      source:
        previousSource === undefined || metadataSourceRank(input.source) >= metadataSourceRank(previousSource)
          ? input.source
          : previousSource,
      sources,
      discoveredAt: discoveredAt.toISOString(),
      ...(family === undefined ? {} : { family }),
      ...(parameterSize === undefined ? {} : { parameterSize }),
      ...(quantization === undefined ? {} : { quantization }),
    };
    return cloneModel(current);
  }

  snapshot(): RegisteredLlmModel[] {
    return this.listModels();
  }

  private requireModel(id: string): RegisteredLlmModel {
    const model = this.models.get(id);
    if (!model) throw new Error(`LLM model is not registered: ${id}`);
    return model;
  }
}

function mergeCapabilities(
  provider: LlmProvider,
  catalog: Partial<LlmProviderCapabilities> | undefined,
  declared: Partial<LlmProviderCapabilities> | undefined,
): LlmProviderCapabilities {
  return {
    ...UNKNOWN_LLM_CAPABILITIES,
    chat: 'supported',
    streaming: provider.stream ? 'supported' : 'unsupported',
    embeddings: provider.embed ? 'unknown' : 'unsupported',
    rerank: provider.rerank ? 'unknown' : 'unsupported',
    ...provider.capabilities,
    ...catalog,
    ...declared,
  };
}

function deploymentFromMode(mode: LlmProviderMode): LlmDataPolicy['deployment'] {
  if (mode === 'private') return 'private';
  return 'public-cloud';
}

function normalizePricing(pricing: LlmModelPricing): LlmModelPricing {
  for (const [name, value] of Object.entries(pricing)) {
    if (name === 'currency') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite number.`);
    }
  }
  return { ...pricing };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nullablePositiveInteger(value: number | null, name: string): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function metadataSourceRank(source: LlmModelMetadata['source']): number {
  if (source === 'provider-api') return 3;
  if (source === 'models-dev') return 2;
  return 1;
}

function requireIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} cannot be empty.`);
}

function cloneModel(model: RegisteredLlmModel): RegisteredLlmModel {
  return {
    ...model,
    capabilities: { ...model.capabilities },
    generationParameters: { ...model.generationParameters },
    limits: { ...model.limits },
    dataPolicy: { ...model.dataPolicy, regions: [...model.dataPolicy.regions] },
    ...(model.pricing === undefined ? {} : { pricing: { ...model.pricing } }),
    ...(model.tags === undefined ? {} : { tags: [...model.tags] }),
    health: { ...model.health },
    ...(model.discovery === undefined
      ? {}
      : { discovery: { ...model.discovery, sources: [...model.discovery.sources] } }),
  };
}
