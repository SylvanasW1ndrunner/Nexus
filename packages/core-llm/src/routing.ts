import { LlmProviderError, type LlmCapabilityName } from './types.js';
import type { LlmModelRegistry, RegisteredLlmModel } from './model-registry.js';

export type LlmTaskRequirements = {
  capabilities?: LlmCapabilityName[];
  minContextTokens?: number;
  minOutputTokens?: number;
  allowedDeployments?: Array<RegisteredLlmModel['dataPolicy']['deployment']>;
  allowedRegions?: string[];
  sensitiveData?: boolean;
  requiredModelIds?: string[];
};

export type LlmTaskPreferences = {
  preferredModelIds?: string[];
  preferredProviderIds?: string[];
  quality?: RegisteredLlmModel['quality'];
  optimizeFor?: 'quality' | 'latency' | 'cost' | 'balanced';
};

export type LlmTaskProfile = {
  taskType: string;
  requirements?: LlmTaskRequirements;
  preferences?: LlmTaskPreferences;
};

export type LlmPolicy = {
  allowedProviderIds?: string[];
  deniedProviderIds?: string[];
  allowedModelIds?: string[];
  deniedModelIds?: string[];
  allowedRegions?: string[];
  allowPublicCloud?: boolean;
  allowUnknownRetention?: boolean;
  maxEstimatedCost?: number;
  preferredModelIds?: string[];
};

export type LlmPolicyLayers = {
  platform?: LlmPolicy;
  organization?: LlmPolicy;
  user?: LlmPolicy;
};

export type EffectiveLlmPolicy = Omit<LlmPolicy, 'allowedProviderIds' | 'allowedModelIds' | 'allowedRegions'> & {
  allowedProviderIds?: string[];
  allowedModelIds?: string[];
  allowedRegions?: string[];
  trace: string[];
};

export type LlmRouteCandidate = {
  model: RegisteredLlmModel;
  score: number;
  reasons: string[];
};

export type LlmRouteExclusion = {
  modelId: string;
  reasons: string[];
};

export type LlmRouteDecision = {
  selected: LlmRouteCandidate;
  fallbacks: LlmRouteCandidate[];
  excluded: LlmRouteExclusion[];
  effectivePolicy: EffectiveLlmPolicy;
  decidedAt: string;
};

export type LlmRouteInput = {
  task: LlmTaskProfile;
  policies?: LlmPolicyLayers;
  estimatedInputTokens?: number;
  requestedOutputTokens?: number;
};

export class LlmTaskRouter {
  constructor(
    private readonly registry: LlmModelRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  route(input: LlmRouteInput): LlmRouteDecision {
    const effectivePolicy = mergeLlmPolicies(input.policies);
    const candidates: LlmRouteCandidate[] = [];
    const excluded: LlmRouteExclusion[] = [];
    for (const model of this.registry.listModels({ enabledOnly: true })) {
      const reasons = exclusionReasons(model, input, effectivePolicy);
      if (reasons.length > 0) {
        excluded.push({ modelId: model.id, reasons });
        continue;
      }
      candidates.push({
        model,
        score: scoreModel(model, input.task.preferences, effectivePolicy),
        reasons: selectionReasons(model, input.task.preferences, effectivePolicy),
      });
    }
    candidates.sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id));
    const selected = candidates[0];
    if (!selected) {
      throw new LlmProviderError('LLM_NO_ROUTE', 'No enabled model satisfies the task and policy requirements.', false, undefined, {
        excluded,
        taskType: input.task.taskType,
      });
    }
    return {
      selected,
      fallbacks: candidates.slice(1),
      excluded,
      effectivePolicy,
      decidedAt: this.now().toISOString(),
    };
  }
}

export function mergeLlmPolicies(layers: LlmPolicyLayers = {}): EffectiveLlmPolicy {
  const ordered: Array<[string, LlmPolicy | undefined]> = [
    ['platform', layers.platform],
    ['organization', layers.organization],
    ['user', layers.user],
  ];
  let allowedProviderIds: string[] | undefined;
  let allowedModelIds: string[] | undefined;
  let allowedRegions: string[] | undefined;
  const deniedProviderIds = new Set<string>();
  const deniedModelIds = new Set<string>();
  const preferredModelIds: string[] = [];
  let allowPublicCloud = true;
  let allowUnknownRetention = true;
  let maxEstimatedCost: number | undefined;
  const trace: string[] = [];

  for (const [name, policy] of ordered) {
    if (!policy) continue;
    allowedProviderIds = intersectOptional(allowedProviderIds, policy.allowedProviderIds);
    allowedModelIds = intersectOptional(allowedModelIds, policy.allowedModelIds);
    allowedRegions = intersectOptional(allowedRegions, policy.allowedRegions);
    for (const id of policy.deniedProviderIds ?? []) deniedProviderIds.add(id);
    for (const id of policy.deniedModelIds ?? []) deniedModelIds.add(id);
    for (const id of policy.preferredModelIds ?? []) if (!preferredModelIds.includes(id)) preferredModelIds.push(id);
    if (policy.allowPublicCloud === false) allowPublicCloud = false;
    if (policy.allowUnknownRetention === false) allowUnknownRetention = false;
    if (policy.maxEstimatedCost !== undefined) {
      if (!Number.isFinite(policy.maxEstimatedCost) || policy.maxEstimatedCost < 0) {
        throw new LlmProviderError('LLM_POLICY_VIOLATION', `${name} maxEstimatedCost is invalid.`, false);
      }
      maxEstimatedCost = Math.min(maxEstimatedCost ?? Number.POSITIVE_INFINITY, policy.maxEstimatedCost);
    }
    trace.push(`${name} policy applied`);
  }

  return {
    ...(allowedProviderIds === undefined ? {} : { allowedProviderIds }),
    ...(allowedModelIds === undefined ? {} : { allowedModelIds }),
    ...(allowedRegions === undefined ? {} : { allowedRegions }),
    deniedProviderIds: [...deniedProviderIds],
    deniedModelIds: [...deniedModelIds],
    allowPublicCloud,
    allowUnknownRetention,
    ...(maxEstimatedCost === undefined ? {} : { maxEstimatedCost }),
    preferredModelIds,
    trace,
  };
}

function exclusionReasons(model: RegisteredLlmModel, input: LlmRouteInput, policy: EffectiveLlmPolicy): string[] {
  const requirements = input.task.requirements ?? {};
  const reasons: string[] = [];
  if (model.health.state === 'unavailable') reasons.push('model is unavailable');
  if (policy.allowedProviderIds && !policy.allowedProviderIds.includes(model.providerId)) reasons.push('provider is not allowed');
  if (policy.deniedProviderIds?.includes(model.providerId)) reasons.push('provider is denied');
  if (policy.allowedModelIds && !policy.allowedModelIds.includes(model.id)) reasons.push('model is not allowed');
  if (policy.deniedModelIds?.includes(model.id)) reasons.push('model is denied');
  if (requirements.requiredModelIds && !requirements.requiredModelIds.includes(model.id)) reasons.push('model is not required');
  if (!policy.allowPublicCloud && model.dataPolicy.deployment === 'public-cloud') reasons.push('public cloud is forbidden');
  if (!policy.allowUnknownRetention && model.dataPolicy.retainsPrompts === 'unknown') reasons.push('retention policy is unknown');
  if (requirements.allowedDeployments && !requirements.allowedDeployments.includes(model.dataPolicy.deployment)) {
    reasons.push('deployment does not satisfy task');
  }
  if (!regionsOverlap(model.dataPolicy.regions, policy.allowedRegions)) reasons.push('region is not allowed by policy');
  if (!regionsOverlap(model.dataPolicy.regions, requirements.allowedRegions)) reasons.push('region does not satisfy task');
  if (requirements.sensitiveData && model.dataPolicy.allowsSensitiveData !== true) reasons.push('sensitive data is not allowed');
  if ((requirements.minContextTokens ?? 0) > model.limits.contextTokens) reasons.push('context limit is too small');
  if ((requirements.minOutputTokens ?? 0) > model.limits.maxOutputTokens) reasons.push('output limit is too small');
  for (const capability of requirements.capabilities ?? []) {
    if (model.capabilities[capability] !== 'supported') reasons.push(`${capability} is not confirmed supported`);
  }
  const cost = estimateModelCost(model, input.estimatedInputTokens ?? 0, input.requestedOutputTokens ?? 0);
  if (policy.maxEstimatedCost !== undefined && cost !== undefined && cost > policy.maxEstimatedCost) {
    reasons.push('estimated cost exceeds policy');
  }
  if (policy.maxEstimatedCost !== undefined && cost === undefined) reasons.push('pricing is unknown');
  return reasons;
}

function scoreModel(
  model: RegisteredLlmModel,
  preferences: LlmTaskPreferences | undefined,
  policy: EffectiveLlmPolicy,
): number {
  const optimizeFor = preferences?.optimizeFor ?? 'balanced';
  let score = model.quality === 'advanced' ? 70 : model.quality === 'balanced' ? 50 : 30;
  if (model.health.state === 'healthy') score += 20;
  if (model.health.state === 'degraded') score -= 15;
  if (preferences?.quality && model.quality === preferences.quality) score += 20;
  if (preferences?.preferredModelIds?.includes(model.id)) score += 60;
  if (preferences?.preferredProviderIds?.includes(model.providerId)) score += 30;
  if (policy.preferredModelIds?.includes(model.id)) score += 40;
  const price = model.pricing
    ? model.pricing.inputPerMillionTokens + model.pricing.outputPerMillionTokens
    : Number.POSITIVE_INFINITY;
  if (optimizeFor === 'cost') score += Number.isFinite(price) ? Math.max(0, 50 - price) : -20;
  if (optimizeFor === 'latency') score += model.health.latencyMs === undefined ? -10 : Math.max(0, 50 - model.health.latencyMs / 20);
  if (optimizeFor === 'quality' && model.quality === 'advanced') score += 40;
  return score;
}

function selectionReasons(
  model: RegisteredLlmModel,
  preferences: LlmTaskPreferences | undefined,
  policy: EffectiveLlmPolicy,
): string[] {
  const reasons = ['all hard requirements satisfied'];
  if (model.health.state === 'healthy') reasons.push('health check is healthy');
  if (preferences?.preferredModelIds?.includes(model.id)) reasons.push('task-preferred model');
  if (policy.preferredModelIds?.includes(model.id)) reasons.push('policy-preferred model');
  reasons.push(`optimization=${preferences?.optimizeFor ?? 'balanced'}`);
  return reasons;
}

export function estimateModelCost(
  model: RegisteredLlmModel,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (!model.pricing) return undefined;
  return (
    (Math.max(0, inputTokens) * model.pricing.inputPerMillionTokens +
      Math.max(0, outputTokens) * model.pricing.outputPerMillionTokens) /
    1_000_000
  );
}

function regionsOverlap(modelRegions: string[], allowedRegions: string[] | undefined): boolean {
  if (allowedRegions === undefined) return true;
  if (allowedRegions.length === 0) return false;
  if (modelRegions.length === 0) return false;
  return modelRegions.some((region) => allowedRegions.includes(region));
}

function intersectOptional(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (next === undefined) return current;
  const uniqueNext = [...new Set(next)];
  if (current === undefined) return uniqueNext;
  return current.filter((value) => uniqueNext.includes(value));
}
