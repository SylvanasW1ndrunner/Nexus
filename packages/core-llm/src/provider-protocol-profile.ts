import {
  UNKNOWN_LLM_PROVIDER_PROTOCOL_CAPABILITIES,
  type LlmCapabilityStatus,
  type LlmProviderProtocolProfile,
  type LlmProviderProtocolProfileInput,
} from './types.js';

const VALID_STATUSES = new Set<LlmCapabilityStatus>([
  'supported',
  'unsupported',
  'unknown',
]);

export function resolveLlmProviderProtocolProfile(
  input?: LlmProviderProtocolProfileInput,
): LlmProviderProtocolProfile {
  const declared = input?.capabilities ?? {};
  for (const [name, status] of Object.entries(declared)) {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(
        `Invalid LLM provider protocol capability status for ${name}: ${String(status)}.`,
      );
    }
  }

  return {
    protocol: input?.protocol.trim() || 'unknown',
    source: input?.source ?? 'default',
    capabilities: {
      ...UNKNOWN_LLM_PROVIDER_PROTOCOL_CAPABILITIES,
      ...declared,
    },
  };
}
