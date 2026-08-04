import {
  UNKNOWN_LLM_CAPABILITIES,
  type LlmCapabilityName,
  type LlmCapabilityStatus,
  type LlmModelMetadata,
  type LlmProvider,
  type LlmProviderCapabilities,
  type LlmProviderMode,
} from './types.js';

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
  /** Provider-declared total input plus output context capacity. */
  contextTokens: number;
  /** Runtime-selected working window, never larger than contextTokens after discovery. */
  effectiveContextTokens?: number;
  /** Prompt-token threshold that triggers automatic context compaction. */
  autoCompactTokenLimit?: number;
  /** Provider-declared maximum tokens that one response may generate. */
  maxOutputTokens: number;
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
  limits: LlmModelLimits;
  dataPolicy: LlmDataPolicy;
  quality: LlmModelQuality;
  pricing?: LlmModelPricing;
  tags?: string[];
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
  'id' | 'displayName' | 'enabled' | 'mode' | 'protocol' | 'capabilities' | 'limits' | 'dataPolicy' | 'quality'
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
};

const DEFAULT_LIMITS: LlmModelLimits = {
  contextTokens: 32_768,
  maxOutputTokens: 4_096,
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
  private readonly configuredOperationalLimits = new Map<
    string,
    Pick<LlmModelLimits, 'effectiveContextTokens' | 'autoCompactTokenLimit'>
  >();

  registerProvider(provider: LlmProvider): void {
    requireIdentifier(provider.id, 'provider.id');
    this.providers.set(provider.id, provider);
  }

  removeProvider(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    for (const [id, model] of this.models) {
      if (model.providerId === providerId) {
        this.models.delete(id);
        this.configuredOperationalLimits.delete(id);
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
    const previous = this.models.get(id);
    const previousModel =
      previous?.providerId === input.providerId && previous.model === input.model.trim()
        ? previous
        : undefined;

    const capabilities = mergeCapabilities(provider, input.capabilities);
    const limits: LlmModelLimits = input.limits === undefined && previousModel
      ? { ...previousModel.limits }
      : {
          contextTokens: positiveInteger(
            input.limits?.contextTokens ?? DEFAULT_LIMITS.contextTokens,
            'contextTokens',
          ),
          maxOutputTokens: positiveInteger(
            input.limits?.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens,
            'maxOutputTokens',
          ),
          ...(input.limits?.requestsPerMinute === undefined
            ? {}
            : {
                requestsPerMinute: positiveInteger(
                  input.limits.requestsPerMinute,
                  'requestsPerMinute',
                ),
              }),
          ...(input.limits?.tokensPerMinute === undefined
            ? {}
            : {
                tokensPerMinute: positiveInteger(
                  input.limits.tokensPerMinute,
                  'tokensPerMinute',
                ),
              }),
          ...(input.limits?.maxConcurrency === undefined
            ? {}
            : {
                maxConcurrency: positiveInteger(
                  input.limits.maxConcurrency,
                  'maxConcurrency',
                ),
              }),
        };
    const configuredOperationalLimits =
      input.limits === undefined && previousModel
        ? this.configuredOperationalLimits.get(id)
        : selectOperationalLimits(input.limits);
    applyEffectiveContextLimits(limits, configuredOperationalLimits, true);
    const dataPolicy: LlmDataPolicy = {
      deployment: input.dataPolicy?.deployment ?? deploymentFromMode(input.mode ?? provider.mode),
      regions: [...(input.dataPolicy?.regions ?? DEFAULT_DATA_POLICY.regions)],
      retainsPrompts: input.dataPolicy?.retainsPrompts ?? DEFAULT_DATA_POLICY.retainsPrompts,
      allowsSensitiveData: input.dataPolicy?.allowsSensitiveData ?? DEFAULT_DATA_POLICY.allowsSensitiveData,
    };
    const profile: RegisteredLlmModel = {
      id,
      providerId: input.providerId,
      model: input.model.trim(),
      displayName: input.displayName?.trim() || input.model.trim(),
      enabled: input.enabled ?? true,
      mode: input.mode ?? provider.mode,
      protocol: input.protocol?.trim() || provider.protocol || 'custom',
      capabilities,
      limits,
      dataPolicy,
      quality: input.quality ?? 'balanced',
      ...(input.pricing === undefined ? {} : { pricing: normalizePricing(input.pricing) }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
      health: previousModel?.health ?? { state: 'unknown', consecutiveFailures: 0 },
      ...(previousModel?.discovery === undefined
        ? {}
        : { discovery: { ...previousModel.discovery } }),
    };
    this.models.set(id, profile);
    if (configuredOperationalLimits === undefined) {
      this.configuredOperationalLimits.delete(id);
    } else {
      this.configuredOperationalLimits.set(id, configuredOperationalLimits);
    }
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
    current.limits = {
      ...current.limits,
      ...(input.contextTokens === undefined
        ? {}
        : { contextTokens: positiveInteger(input.contextTokens, 'contextTokens') }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: positiveInteger(input.maxOutputTokens, 'maxOutputTokens') }),
    };
    applyEffectiveContextLimits(
      current.limits,
      this.configuredOperationalLimits.get(id),
      true,
    );
    current.discovery = {
      source: input.source,
      discoveredAt: discoveredAt.toISOString(),
      ...(input.family === undefined ? {} : { family: input.family }),
      ...(input.parameterSize === undefined ? {} : { parameterSize: input.parameterSize }),
      ...(input.quantization === undefined ? {} : { quantization: input.quantization }),
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

function selectOperationalLimits(
  limits: Partial<LlmModelLimits> | undefined,
): Pick<LlmModelLimits, 'effectiveContextTokens' | 'autoCompactTokenLimit'> | undefined {
  if (
    limits?.effectiveContextTokens === undefined &&
    limits?.autoCompactTokenLimit === undefined
  ) {
    return undefined;
  }
  return {
    ...(limits.effectiveContextTokens === undefined
      ? {}
      : { effectiveContextTokens: limits.effectiveContextTokens }),
    ...(limits.autoCompactTokenLimit === undefined
      ? {}
      : { autoCompactTokenLimit: limits.autoCompactTokenLimit }),
  };
}

function applyEffectiveContextLimits(
  target: LlmModelLimits,
  input:
    | Pick<LlmModelLimits, 'effectiveContextTokens' | 'autoCompactTokenLimit'>
    | undefined,
  clampToPhysicalContext: boolean,
): void {
  const requestedEffective =
    input?.effectiveContextTokens ?? target.effectiveContextTokens;
  if (requestedEffective !== undefined) {
    const normalizedEffective = positiveInteger(
      requestedEffective,
      'effectiveContextTokens',
    );
    target.effectiveContextTokens = clampToPhysicalContext
      ? Math.min(target.contextTokens, normalizedEffective)
      : normalizedEffective;
  }
  const effectiveContextTokens = target.effectiveContextTokens ?? target.contextTokens;
  const requestedAutoCompact =
    input?.autoCompactTokenLimit ?? target.autoCompactTokenLimit;
  if (requestedAutoCompact !== undefined) {
    const normalizedAutoCompact = positiveInteger(
      requestedAutoCompact,
      'autoCompactTokenLimit',
    );
    target.autoCompactTokenLimit =
      clampToPhysicalContext || target.effectiveContextTokens !== undefined
        ? Math.min(effectiveContextTokens, normalizedAutoCompact)
        : normalizedAutoCompact;
  }
}

function mergeCapabilities(
  provider: LlmProvider,
  declared: Partial<LlmProviderCapabilities> | undefined,
): LlmProviderCapabilities {
  return {
    ...UNKNOWN_LLM_CAPABILITIES,
    chat: 'supported',
    streaming: provider.stream ? 'supported' : 'unsupported',
    embeddings: provider.embed ? 'unknown' : 'unsupported',
    rerank: provider.rerank ? 'unknown' : 'unsupported',
    ...provider.capabilities,
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

function requireIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} cannot be empty.`);
}

function cloneModel(model: RegisteredLlmModel): RegisteredLlmModel {
  return {
    ...model,
    capabilities: { ...model.capabilities },
    limits: { ...model.limits },
    dataPolicy: { ...model.dataPolicy, regions: [...model.dataPolicy.regions] },
    ...(model.pricing === undefined ? {} : { pricing: { ...model.pricing } }),
    ...(model.tags === undefined ? {} : { tags: [...model.tags] }),
    health: { ...model.health },
    ...(model.discovery === undefined ? {} : { discovery: { ...model.discovery } }),
  };
}
