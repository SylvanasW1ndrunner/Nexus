import bundledCatalog from './model_prices_and_context_window.json' with { type: 'json' };
import type {
  LlmGenerationParameterSupport,
  LlmModelMetadata,
  LlmProviderCapabilities,
} from './types.js';

export type LlmModelPricing = {
  currency: 'CNY' | 'USD';
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
};

export type ModelCatalogBooleanCapabilities = {
  toolCalling?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
};

export type ModelCatalogEntry = {
  name: string;
  family?: string;
  limits?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: ModelCatalogBooleanCapabilities;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
  };
};

export type ModelCatalogSnapshot = {
  schemaVersion: 1;
  source: {
    name: 'models.dev';
    url: string;
    generatedAt: string;
  };
  models: Record<string, ModelCatalogEntry>;
  providers: Record<
    string,
    {
      api?: string;
      models: Record<string, ModelCatalogEntry>;
    }
  >;
};

export type ResolvedModelCatalogMetadata = {
  generatedAt: string;
  metadata: LlmModelMetadata;
  pricing?: LlmModelPricing;
};

export const DEFAULT_MODEL_CATALOG = validateModelCatalogSnapshot(
  bundledCatalog,
);

export function resolveModelCatalogMetadata(input: {
  catalog?: ModelCatalogSnapshot;
  providerId: string;
  model: string;
}): ResolvedModelCatalogMetadata | undefined {
  const catalog = input.catalog ?? DEFAULT_MODEL_CATALOG;
  let target = { providerId: input.providerId.trim(), model: input.model.trim() };
  let entry = catalog.providers[target.providerId]?.models[target.model];
  if (!entry) {
    const matches = Object.entries(catalog.providers)
      .filter(([, provider]) => provider.models[input.model.trim()] !== undefined)
      .map(([providerId, provider]) => ({
        providerId,
        model: input.model.trim(),
        entry: provider.models[input.model.trim()]!,
      }));
    if (matches.length === 1) {
      const match = matches[0]!;
      target = { providerId: match.providerId, model: match.model };
      entry = match.entry;
    }
  }
  if (!entry) return undefined;

  const capabilities: Partial<LlmProviderCapabilities> = {};
  const generationParameters: Partial<LlmGenerationParameterSupport> = {};
  const toolCalling = booleanCapability(entry.capabilities?.toolCalling);
  const reasoning = booleanCapability(entry.capabilities?.reasoning);
  const structuredOutput = booleanCapability(entry.capabilities?.structuredOutput);
  const temperature = booleanCapability(entry.capabilities?.temperature);
  if (toolCalling !== undefined) capabilities.toolCalling = toolCalling;
  if (reasoning !== undefined) capabilities.reasoning = reasoning;
  if (structuredOutput !== undefined) capabilities.structuredOutput = structuredOutput;
  if (temperature !== undefined) generationParameters.temperature = temperature;

  const metadata: LlmModelMetadata = {
    model: input.model.trim(),
    source: 'models-dev',
    capabilities,
    ...(entry.limits?.context === undefined
      ? {}
      : { contextTokens: positiveInteger(entry.limits.context, 'limit.context') }),
    ...(entry.limits?.input === undefined
      ? {}
      : { maxInputTokens: positiveInteger(entry.limits.input, 'limit.input') }),
    ...(entry.limits?.output === undefined
      ? {}
      : { maxOutputTokens: positiveInteger(entry.limits.output, 'limit.output') }),
    ...(Object.keys(generationParameters).length === 0
      ? {}
      : { generationParameters }),
    ...(entry.family?.trim() ? { family: entry.family.trim() } : {}),
  };
  const pricing = catalogPricing(entry.cost);
  return {
    generatedAt: catalog.source.generatedAt,
    metadata,
    ...(pricing === undefined ? {} : { pricing }),
  };
}

export function validateModelCatalogSnapshot(value: unknown): ModelCatalogSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source)) {
    throw new Error('Invalid models.dev catalog snapshot header.');
  }
  if (
    value.source.name !== 'models.dev' ||
    typeof value.source.url !== 'string' ||
    typeof value.source.generatedAt !== 'string' ||
    !isRecord(value.models) ||
    !isRecord(value.providers)
  ) {
    throw new Error('Invalid models.dev catalog snapshot source.');
  }
  validateCatalogModels(value.models, 'base');
  for (const [providerId, provider] of Object.entries(value.providers)) {
    if (!providerId || !isRecord(provider) || !isRecord(provider.models)) {
      throw new Error(`Invalid models.dev provider entry: ${providerId || '<empty>'}.`);
    }
    if (provider.api !== undefined) validateCatalogApi(provider.api, providerId);
    validateCatalogModels(provider.models, providerId);
  }
  return structuredClone(value) as ModelCatalogSnapshot;
}

function validateCatalogModels(models: Record<string, unknown>, namespace: string): void {
  for (const [modelId, entry] of Object.entries(models)) {
    if (!modelId || !isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`Invalid models.dev model entry: ${namespace}/${modelId || '<empty>'}.`);
    }
  }
}

function validateCatalogApi(value: unknown, providerId: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid models.dev provider API: ${providerId}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid models.dev provider API: ${providerId}.`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid models.dev provider API: ${providerId}.`);
  }
}

function booleanCapability(
  value: boolean | undefined,
): 'supported' | 'unsupported' | undefined {
  return value === undefined ? undefined : value ? 'supported' : 'unsupported';
}

function catalogPricing(cost: ModelCatalogEntry['cost']): LlmModelPricing | undefined {
  if (cost?.input === undefined || cost.output === undefined) return undefined;
  return {
    currency: 'USD',
    inputPerMillionTokens: nonNegativeNumber(cost.input, 'cost.input'),
    outputPerMillionTokens: nonNegativeNumber(cost.output, 'cost.output'),
    ...(cost.cacheRead === undefined
      ? {}
      : { cachedInputPerMillionTokens: nonNegativeNumber(cost.cacheRead, 'cost.cacheRead') }),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
