export const SILICONFLOW_OPENAI_COMPATIBLE_ENDPOINT = 'https://api.siliconflow.cn/v1';
export const SILICONFLOW_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

/**
 * Reads only the live-test process environment. The returned key is for the
 * Provider connection and must never be copied into reports or CLI arguments.
 */
export function resolveSiliconFlowLiveConfiguration(environment = process.env) {
  const endpoint = normalizeLiveEndpoint(
    environment.TEST_SILICONFLOW_BASE_URL ?? SILICONFLOW_OPENAI_COMPATIBLE_ENDPOINT,
  );
  const model = normalizeLiveModel(
    environment.TEST_SILICONFLOW_MODEL ?? SILICONFLOW_DEFAULT_MODEL,
  );
  const apiKey = environment.TEST_SILICONFLOW_API_KEY;
  return Object.freeze({
    endpoint,
    model,
    ...(typeof apiKey === 'string' && apiKey.length > 0 ? { apiKey } : {}),
  });
}

export function liveConfigurationNotRunReason(configuration) {
  return configuration.apiKey === undefined
    ? 'TEST_SILICONFLOW_API_KEY is required in the current process environment.'
    : undefined;
}

export function publicLiveEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
}

export function normalizeLiveMaxOutputTokens(value) {
  if (value === undefined || value === '') return 4_096;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 128 || parsed > 65_536) {
    throw new Error('TEST_LLM_MAX_OUTPUT_TOKENS must be an integer from 128 through 65536.');
  }
  return parsed;
}

function normalizeLiveEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('TEST_SILICONFLOW_BASE_URL must be a non-empty HTTP(S) URL.');
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('TEST_SILICONFLOW_BASE_URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('TEST_SILICONFLOW_BASE_URL must use HTTP(S).');
  }
  return endpoint.toString().replace(/\/$/u, '');
}

function normalizeLiveModel(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new Error('TEST_SILICONFLOW_MODEL must be a non-empty string of at most 512 characters.');
  }
  return value.trim();
}

export function boundedLiveMaxOutputTokens(requested, discoveredMetadata) {
  const discovered = discoveredMetadata?.value;
  return Number.isSafeInteger(discovered) && discovered > 0
    ? Math.min(requested, discovered)
    : requested;
}
