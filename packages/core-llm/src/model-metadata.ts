import type { ModelCatalogEntry, ModelCatalogSnapshot } from './model-catalog.js';
import {
  UNKNOWN_LLM_CAPABILITIES,
  UNKNOWN_LLM_GENERATION_PARAMETERS,
  type LlmCapabilityName,
  type LlmCapabilityStatus,
  type LlmGenerationParameterName,
  type LlmGenerationParameterSupport,
  type OpenAIChatMaxOutputTokensWireKey,
  type LlmProviderCapabilities,
} from './types.js';

export type LlmMetadataSource =
  | 'endpoint'
  | 'endpoint-cache'
  | 'provider-plugin'
  | 'models-dev'
  | 'unknown';

export type LlmMetadataValue<T> = {
  value: T | null;
  source: LlmMetadataSource;
  observedAt?: string;
};

export type LlmModelRole = 'generation' | 'embedding' | 'rerank' | 'vision';

export type LlmModelMetadataCandidate = {
  source: LlmMetadataSource;
  observedAt?: string;
  displayName?: string | null;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  contextTokens?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  openAIChatMaxOutputTokensWireKey?: OpenAIChatMaxOutputTokensWireKey | null;
  roles?: Partial<Record<LlmModelRole, boolean | null>>;
  capabilities?: Partial<LlmProviderCapabilities>;
  generationParameters?: Partial<LlmGenerationParameterSupport>;
  pricing?: {
    currency: 'USD' | 'CNY';
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    cachedInputPerMillionTokens?: number;
  } | null;
};

export type LlmCatalogModel = {
  id: string;
  connectionId: string;
  modelId: string;
  displayName: LlmMetadataValue<string>;
  family: LlmMetadataValue<string>;
  parameterSize: LlmMetadataValue<string>;
  quantization: LlmMetadataValue<string>;
  contextTokens: LlmMetadataValue<number>;
  maxInputTokens: LlmMetadataValue<number>;
  maxOutputTokens: LlmMetadataValue<number>;
  openAIChatMaxOutputTokensWireKey: LlmMetadataValue<OpenAIChatMaxOutputTokensWireKey>;
  roles: Record<LlmModelRole, LlmMetadataValue<boolean>>;
  capabilities: Record<LlmCapabilityName, LlmMetadataValue<LlmCapabilityStatus>>;
  generationParameters: Record<
    LlmGenerationParameterName,
    LlmMetadataValue<LlmCapabilityStatus>
  >;
  pricing: LlmMetadataValue<NonNullable<LlmModelMetadataCandidate['pricing']>>;
};

export type ModelsDevResolution = LlmModelMetadataCandidate & {
  source: 'models-dev';
  roles: Record<LlmModelRole, boolean>;
};

const SOURCE_PRIORITY: Record<LlmMetadataSource, number> = {
  endpoint: 5,
  'endpoint-cache': 4,
  'provider-plugin': 3,
  'models-dev': 2,
  unknown: 1,
};

const CAPABILITY_NAMES = Object.keys(UNKNOWN_LLM_CAPABILITIES) as LlmCapabilityName[];
const PARAMETER_NAMES = Object.keys(
  UNKNOWN_LLM_GENERATION_PARAMETERS,
) as LlmGenerationParameterName[];
const MODEL_ROLES: LlmModelRole[] = ['generation', 'embedding', 'rerank', 'vision'];

export function mergeLlmCatalogModel(input: {
  connectionId: string;
  modelId: string;
  candidates: readonly LlmModelMetadataCandidate[];
}): LlmCatalogModel {
  const candidates = [...input.candidates].sort(
    (left, right) => SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source],
  );
  const roles = Object.fromEntries(
    MODEL_ROLES.map((role) => [
      role,
      selectMetadataValue(candidates, (candidate) => candidate.roles?.[role], isBoolean),
    ]),
  ) as Record<LlmModelRole, LlmMetadataValue<boolean>>;
  const capabilities = Object.fromEntries(
    CAPABILITY_NAMES.map((capability) => [
      capability,
      selectMetadataValue(
        candidates,
        (candidate) => candidate.capabilities?.[capability],
        isKnownCapability,
      ),
    ]),
  ) as Record<LlmCapabilityName, LlmMetadataValue<LlmCapabilityStatus>>;
  const generationParameters = Object.fromEntries(
    PARAMETER_NAMES.map((parameter) => [
      parameter,
      selectMetadataValue(
        candidates,
        (candidate) => candidate.generationParameters?.[parameter],
        isKnownCapability,
      ),
    ]),
  ) as Record<LlmGenerationParameterName, LlmMetadataValue<LlmCapabilityStatus>>;
  return {
    id: `${input.connectionId}:${input.modelId}`,
    connectionId: input.connectionId,
    modelId: input.modelId,
    displayName: selectMetadataValue(candidates, (candidate) => candidate.displayName, nonEmptyString),
    family: selectMetadataValue(candidates, (candidate) => candidate.family, nonEmptyString),
    parameterSize: selectMetadataValue(
      candidates,
      (candidate) => candidate.parameterSize,
      nonEmptyString,
    ),
    quantization: selectMetadataValue(
      candidates,
      (candidate) => candidate.quantization,
      nonEmptyString,
    ),
    contextTokens: selectMetadataValue(
      candidates,
      (candidate) => candidate.contextTokens,
      positiveInteger,
    ),
    maxInputTokens: selectMetadataValue(
      candidates,
      (candidate) => candidate.maxInputTokens,
      positiveInteger,
    ),
    maxOutputTokens: selectMetadataValue(
      candidates,
      (candidate) => candidate.maxOutputTokens,
      positiveInteger,
    ),
    openAIChatMaxOutputTokensWireKey: selectMetadataValue(
      candidates,
      (candidate) => candidate.openAIChatMaxOutputTokensWireKey,
      isOpenAIChatMaxOutputTokensWireKey,
    ),
    roles,
    capabilities,
    generationParameters,
    pricing: selectMetadataValue(candidates, (candidate) => candidate.pricing, validPricing),
  };
}

function isOpenAIChatMaxOutputTokensWireKey(
  value: unknown,
): value is OpenAIChatMaxOutputTokensWireKey {
  return value === 'max_tokens' ||
    value === 'max_completion_tokens' ||
    value === 'max_output_tokens' ||
    value === 'max_new_tokens';
}

export class LlmModelsDevIndex {
  private readonly providers = new Map<string, Map<string, IndexedCatalogEntry>>();
  private readonly exact = new Map<string, IndexedCatalogEntry[]>();
  private readonly base = new Map<string, IndexedCatalogEntry[]>();
  private readonly baseModelsExact = new Map<string, IndexedCatalogEntry[]>();
  private readonly baseModelsByName = new Map<string, IndexedCatalogEntry[]>();
  private readonly endpoints = new Map<string, string[]>();

  constructor(private readonly catalog: ModelCatalogSnapshot) {
    for (const [catalogModelKey, entry] of Object.entries(catalog.models)) {
      const indexed = { catalogModelKey, modelId: catalogModelKey, entry };
      addIndex(this.baseModelsExact, catalogModelKey, indexed);
      addIndex(this.baseModelsByName, baseModelId(catalogModelKey), indexed);
    }
    for (const [providerId, provider] of Object.entries(catalog.providers)) {
      if (provider.api) addIndex(this.endpoints, normalizeCatalogEndpoint(provider.api), providerId);
      const providerModels = new Map<string, IndexedCatalogEntry>();
      for (const [modelId, entry] of Object.entries(provider.models)) {
        const indexed = { catalogModelKey: `${providerId}/${modelId}`, modelId, entry };
        providerModels.set(modelId.toLocaleLowerCase(), indexed);
        addIndex(this.exact, modelId, indexed);
        addIndex(this.base, baseModelId(modelId), indexed);
      }
      this.providers.set(providerId.toLocaleLowerCase(), providerModels);
    }
  }

  providerForEndpoint(endpoint: string): string | undefined {
    let normalized: string;
    try {
      normalized = normalizeCatalogEndpoint(endpoint);
    } catch {
      return undefined;
    }
    return unique(this.endpoints.get(normalized));
  }

  resolve(modelId: string, providerHint?: string): ModelsDevResolution | undefined {
    const normalizedModel = modelId.trim();
    if (!normalizedModel) return undefined;
    const hinted = providerHint?.trim().toLocaleLowerCase();
    const hintedEntry = hinted
      ? this.providers.get(hinted)?.get(normalizedModel.toLocaleLowerCase())
      : undefined;
    const match =
      hintedEntry ??
      unique(this.exact.get(normalizedModel.toLocaleLowerCase())) ??
      unique(this.baseModelsExact.get(normalizedModel.toLocaleLowerCase())) ??
      unique(this.baseModelsByName.get(baseModelId(normalizedModel).toLocaleLowerCase())) ??
      unique(this.base.get(baseModelId(normalizedModel).toLocaleLowerCase()));
    if (!match) return undefined;
    return catalogEntryToCandidate(match, this.catalog.source.generatedAt);
  }
}

export function classifyLlmModelRoles(modelId: string, family?: string): Record<LlmModelRole, boolean> {
  const identity = `${modelId} ${family ?? ''}`.toLocaleLowerCase();
  const rerank = /rerank|reranker|re-rank/.test(identity);
  const embedding = !rerank && /embed|embedding|e5(?:[-_.]|$)|bge-m3/.test(identity);
  const vision = /vision|multimodal|(?:^|[-_.\s])vl(?:[-_.\s]|$)/.test(identity);
  return {
    generation: !embedding && !rerank,
    embedding,
    rerank,
    vision,
  };
}

type IndexedCatalogEntry = {
  catalogModelKey: string;
  modelId: string;
  entry: ModelCatalogEntry;
};

function catalogEntryToCandidate(
  match: IndexedCatalogEntry,
  observedAt: string,
): ModelsDevResolution {
  const entry = match.entry;
  const roles = classifyLlmModelRoles(match.modelId, entry.family);
  const capabilities: Partial<LlmProviderCapabilities> = {
    chat: roles.generation ? 'supported' : 'unsupported',
    ...(entry.capabilities?.toolCalling === undefined
      ? {}
      : { toolCalling: booleanCapability(entry.capabilities.toolCalling) }),
    ...(entry.capabilities?.reasoning === undefined
      ? {}
      : { reasoning: booleanCapability(entry.capabilities.reasoning) }),
    ...(entry.capabilities?.structuredOutput === undefined
      ? {}
      : { structuredOutput: booleanCapability(entry.capabilities.structuredOutput) }),
    ...(roles.vision ? { vision: 'supported' as const } : {}),
  };
  return {
    source: 'models-dev',
    observedAt,
    displayName: entry.name,
    ...(entry.family ? { family: entry.family } : {}),
    ...(entry.limits?.context === undefined ? {} : { contextTokens: entry.limits.context }),
    ...(entry.limits?.input === undefined ? {} : { maxInputTokens: entry.limits.input }),
    ...(entry.limits?.output === undefined ? {} : { maxOutputTokens: entry.limits.output }),
    roles,
    capabilities,
    ...(entry.capabilities?.temperature === undefined
      ? {}
      : {
          generationParameters: {
            temperature: booleanCapability(entry.capabilities.temperature),
          },
        }),
    ...(entry.cost?.input === undefined || entry.cost.output === undefined
      ? {}
      : {
          pricing: {
            currency: 'USD',
            inputPerMillionTokens: entry.cost.input,
            outputPerMillionTokens: entry.cost.output,
            ...(entry.cost.cacheRead === undefined
              ? {}
              : { cachedInputPerMillionTokens: entry.cost.cacheRead }),
          },
        }),
  };
}

function selectMetadataValue<T>(
  candidates: readonly LlmModelMetadataCandidate[],
  read: (candidate: LlmModelMetadataCandidate) => T | null | undefined,
  known: (value: unknown) => value is T,
): LlmMetadataValue<T> {
  for (const candidate of candidates) {
    const value = read(candidate);
    if (!known(value)) continue;
    return {
      value,
      source: candidate.source,
      ...(candidate.observedAt === undefined ? {} : { observedAt: candidate.observedAt }),
    };
  }
  return { value: null, source: 'unknown' };
}

function addIndex<T>(
  index: Map<string, T[]>,
  key: string,
  value: T,
): void {
  const normalized = key.toLocaleLowerCase();
  const values = index.get(normalized) ?? [];
  values.push(value);
  index.set(normalized, values);
}

function unique<T>(values?: readonly T[]): T | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function normalizeCatalogEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Catalog endpoint must use HTTP or HTTPS.');
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function baseModelId(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf('/') + 1);
}

function booleanCapability(value: boolean): LlmCapabilityStatus {
  return value ? 'supported' : 'unsupported';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isKnownCapability(value: unknown): value is LlmCapabilityStatus {
  return value === 'supported' || value === 'unsupported';
}

function validPricing(value: unknown): value is NonNullable<LlmModelMetadataCandidate['pricing']> {
  if (!value || typeof value !== 'object') return false;
  const pricing = value as Record<string, unknown>;
  return (
    (pricing.currency === 'USD' || pricing.currency === 'CNY') &&
    nonNegativeNumber(pricing.inputPerMillionTokens) &&
    nonNegativeNumber(pricing.outputPerMillionTokens) &&
    (pricing.cachedInputPerMillionTokens === undefined ||
      nonNegativeNumber(pricing.cachedInputPerMillionTokens))
  );
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
