import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleProvider,
  UNKNOWN_LLM_PROVIDER_PROTOCOL_CAPABILITIES,
  resolveLlmProviderProtocolProfile,
} from '../src/index.js';

describe('provider protocol profiles', () => {
  it('keeps model intelligence separate from transport protocol features', () => {
    const profile = resolveLlmProviderProtocolProfile({
      protocol: 'openai-compatible',
      source: 'provider-declaration',
      capabilities: {
        namespaceTools: 'supported',
        parallelToolCalls: 'supported',
      },
    });

    expect(profile.capabilities.namespaceTools).toBe('supported');
    expect(profile.capabilities.parallelToolCalls).toBe('supported');
    expect(profile.capabilities.toolReferences).toBe('unknown');
  });

  it('defaults every advanced transport capability to unknown for undeclared endpoints', () => {
    expect(resolveLlmProviderProtocolProfile()).toEqual({
      protocol: 'unknown',
      source: 'default',
      capabilities: UNKNOWN_LLM_PROVIDER_PROTOCOL_CAPABILITIES,
    });
  });

  it('does not allow a declaration to silently invent unsupported capability values', () => {
    expect(() =>
      resolveLlmProviderProtocolProfile({
        protocol: 'custom-proxy',
        source: 'user-declaration',
        capabilities: { toolReferences: 'yes' as never },
      }),
    ).toThrow('Invalid LLM provider protocol capability status');
  });

  it('keeps custom OpenAI-compatible endpoints on conservative protocol defaults', () => {
    const provider = new OpenAICompatibleProvider({
      id: 'proxy',
      name: 'Proxy',
      apiKey: 'test-only',
      baseUrl: 'https://proxy.invalid/v1',
    });

    expect(provider.protocolProfile.capabilities.namespaceTools).toBe('unknown');
    expect(provider.protocolProfile.capabilities.toolReferences).toBe('unknown');
  });

  it('accepts explicit protocol capabilities without inferring adjacent features', () => {
    const provider = new OpenAICompatibleProvider({
      id: 'declared',
      name: 'Declared',
      apiKey: 'test-only',
      baseUrl: 'https://provider.invalid/v1',
      protocolProfile: {
        protocol: 'openai-responses-compatible',
        source: 'user-declaration',
        capabilities: { structuredToolResults: 'supported' },
      },
    });

    expect(provider.protocolProfile.capabilities.structuredToolResults).toBe('supported');
    expect(provider.protocolProfile.capabilities.namespaceTools).toBe('unknown');
  });
});
