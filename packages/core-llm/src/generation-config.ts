import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmGenerationConfig,
  type LlmGenerationParameterName,
  type LlmGenerationParameterSupport,
} from './types.js';

const PARAMETER_LABELS: Record<LlmGenerationParameterName, string> = {
  temperature: 'temperature',
  topP: 'topP',
  maxOutputTokens: 'maxOutputTokens',
  seed: 'seed',
  stop: 'stop',
  reasoningEffort: 'reasoningEffort',
};

const DEFAULT_OUTPUT_RESERVATION_TOKENS = 8_192;
const DEFAULT_OUTPUT_RESERVATION_RATIO = 0.25;

/**
 * Returns the bounded output reservation used for context planning and routing.
 * This is not a user-configurable context window and is not sent to the endpoint
 * unless the caller explicitly configured maxOutputTokens.
 */
export function resolveLlmOutputReservation(
  contextTokens: number | null,
  advertisedMaxOutputTokens: number | null,
  configuredMaxOutputTokens?: number,
): number | null {
  if (configuredMaxOutputTokens !== undefined) return configuredMaxOutputTokens;
  if (contextTokens === null && advertisedMaxOutputTokens === null) return null;

  const contextReservation =
    contextTokens === null
      ? DEFAULT_OUTPUT_RESERVATION_TOKENS
      : Math.max(1, Math.floor(contextTokens * DEFAULT_OUTPUT_RESERVATION_RATIO));
  return Math.min(
    DEFAULT_OUTPUT_RESERVATION_TOKENS,
    contextReservation,
    advertisedMaxOutputTokens ?? DEFAULT_OUTPUT_RESERVATION_TOKENS,
  );
}

export function generationConfigFromRequest(request: LlmChatRequest): LlmGenerationConfig {
  return {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.stop === undefined ? {} : { stop: [...request.stop] }),
    ...(request.reasoning?.effort === undefined
      ? {}
      : { reasoningEffort: request.reasoning.effort }),
  };
}

export function mergeLlmGenerationConfig(
  defaults?: LlmGenerationConfig,
  overrides?: LlmGenerationConfig,
): LlmGenerationConfig {
  return validateLlmGenerationConfig({ ...defaults, ...overrides });
}

export function validateLlmGenerationConfig(input: LlmGenerationConfig): LlmGenerationConfig {
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0)) {
    throw new Error('temperature must be a finite non-negative number.');
  }
  if (
    input.topP !== undefined &&
    (!Number.isFinite(input.topP) || input.topP < 0 || input.topP > 1)
  ) {
    throw new Error('topP must be a finite number between 0 and 1.');
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)
  ) {
    throw new Error('maxOutputTokens must be a positive safe integer.');
  }
  if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) {
    throw new Error('seed must be a safe integer.');
  }
  if (
    input.stop !== undefined &&
    (!Array.isArray(input.stop) || input.stop.some((value) => typeof value !== 'string' || !value))
  ) {
    throw new Error('stop must contain non-empty strings.');
  }
  return {
    ...input,
    ...(input.stop === undefined ? {} : { stop: [...input.stop] }),
  };
}

export function assertGenerationParametersSupported(
  support: LlmGenerationParameterSupport,
  config: LlmGenerationConfig,
): void {
  const configured = Object.keys(config) as LlmGenerationParameterName[];
  for (const parameter of configured) {
    if (config[parameter] === undefined || support[parameter] !== 'unsupported') continue;
    throw new LlmProviderError(
      'LLM_PARAMETER_UNSUPPORTED',
      `The selected model does not support the configured ${PARAMETER_LABELS[parameter]} parameter. Remove it or select a compatible model.`,
      false,
      undefined,
      { parameter },
    );
  }
}
