import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  LlmConnectionResolver,
  LlmProviderPluginRegistry,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  createBuiltinLlmProviderPlugins,
  createLlmConnection,
  type LlmFetch,
  type LlmProviderPlugin,
} from '../src/index.js';

describe('LlmConnectionResolver', () => {
  it('detects the exact Ollama tags shape on any port without a port heuristic', async () => {
    const fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:39281/api/tags') {
        return Promise.resolve(
          Response.json({ models: [{ name: 'qwen2.5:14b', model: 'qwen2.5:14b' }] }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const resolver = builtinResolver(fetch);
    const connection = createLlmConnection({ endpoint: 'http://127.0.0.1:39281' });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('ollama-native');
    expect(resolution.protocol).toBe('ollama-chat');
    expect(resolution.models).toEqual(['qwen2.5:14b']);
    expect(resolver.createProvider(connection, resolution)).toBeInstanceOf(OllamaProvider);
  });

  it('recognizes official Anthropic endpoints without sending a model prompt', async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json({ data: [{ id: 'claude-sonnet' }] })));
    const resolver = builtinResolver(fetch);
    const connection = createLlmConnection({
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-secret',
    });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('anthropic-messages');
    expect(resolution.protocol).toBe('anthropic-messages');
    expect(resolver.createProvider(connection, resolution)).toBeInstanceOf(AnthropicProvider);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('prefers Responses for the official OpenAI endpoint', async () => {
    const resolver = builtinResolver(() =>
      Promise.resolve(Response.json({ data: [{ id: 'gpt-5' }] })),
    );
    const connection = createLlmConnection({
      endpoint: 'https://api.openai.com/v1/',
      apiKey: 'openai-secret',
    });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('openai-responses');
    expect(resolver.createProvider(connection, resolution)).toBeInstanceOf(OpenAIResponsesProvider);
  });

  it('resolves generic OpenAI-compatible and vLLM endpoints from /models', async () => {
    const resolver = builtinResolver((input) => {
      if (String(input) === 'http://10.0.0.8:8000/v1/models') {
        return Promise.resolve(Response.json({ data: [{ id: 'Qwen/Qwen3-32B' }] }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const connection = createLlmConnection({ endpoint: 'http://10.0.0.8:8000/v1' });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('openai-compatible');
    expect(resolution.models).toEqual(['Qwen/Qwen3-32B']);
    expect(resolver.createProvider(connection, resolution)).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('preserves arbitrary endpoint path prefixes during discovery', async () => {
    const seen: string[] = [];
    const resolver = builtinResolver((input) => {
      seen.push(String(input));
      if (String(input).endsWith('/tenant/gateway/v1/models')) {
        return Promise.resolve(Response.json({ data: [{ id: 'relay-model' }] }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const connection = createLlmConnection({
      endpoint: 'https://relay.example/tenant/gateway/v1/',
      apiKey: 'secret',
    });

    const resolution = await resolver.resolve(connection);

    expect(seen).toContain('https://relay.example/tenant/gateway/v1/models');
    expect(resolution.models).toEqual(['relay-model']);
  });

  it('allows an unauthenticated local OpenAI-compatible endpoint', async () => {
    const resolver = builtinResolver(() =>
      Promise.resolve(Response.json({ data: [{ id: 'local-model' }] })),
    );
    const connection = createLlmConnection({ endpoint: 'http://localhost:8080/v1' });

    const resolution = await resolver.resolve(connection);
    const provider = resolver.createProvider(connection, resolution);

    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('falls back to OpenAI Chat for an unknown relay without replaying a model request', async () => {
    const fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const resolver = builtinResolver(fetch);
    const connection = createLlmConnection({
      endpoint: 'https://unknown-relay.example/custom/v1',
      apiKey: 'never-log-this',
      headers: { 'X-Tenant': 'tenant-a' },
    });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('openai-compatible');
    expect(resolution.models).toEqual([]);
    expect(JSON.stringify(resolution)).not.toContain('never-log-this');
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('isolates discovery failures and enforces a bounded timeout', async () => {
    const slow: LlmProviderPlugin = {
      manifest: {
        id: 'slow',
        name: 'Slow',
        version: '1',
        protocol: 'slow',
        priority: 100,
      },
      match: () => ({ score: 90, evidence: [] }),
      discover: async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fixture discovery aborted')), {
            once: true,
          });
        }),
      createProvider: () => {
        throw new Error('unused');
      },
    };
    const fallback = createBuiltinLlmProviderPlugins().find(
      (plugin) => plugin.manifest.id === 'openai-compatible',
    )!;
    const resolver = new LlmConnectionResolver({
      registry: new LlmProviderPluginRegistry([slow, fallback]),
      discoveryTimeoutMs: 20,
      fetch: () => Promise.resolve(new Response('not found', { status: 404 })),
    });
    const connection = createLlmConnection({
      endpoint: 'https://relay.example/v1',
      apiKey: 'timeout-secret',
    });

    const resolution = await resolver.resolve(connection);

    expect(resolution.pluginId).toBe('openai-compatible');
    expect(resolution.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'runtime', kind: 'plugin-discovery-error' }),
      ]),
    );
    expect(JSON.stringify(resolution)).not.toContain('timeout-secret');
  });

  it('derives stable connection identity separately from credential scope', () => {
    const first = createLlmConnection({
      name: 'team',
      endpoint: 'HTTPS://Relay.Example:443/v1/',
      apiKey: 'key-one',
      connectionConfigurationRevision: 'config-v1',
      credentialRevision: 'credential-v1',
    });
    const rotated = createLlmConnection({
      name: 'team',
      endpoint: 'https://relay.example/v1',
      apiKey: 'key-two',
      connectionConfigurationRevision: 'config-v1',
      credentialRevision: 'credential-v2',
    });

    expect(first.id).toBe(rotated.id);
    expect(first.credentialScope).not.toBe(rotated.credentialScope);
    expect(first.credentialScope).toBe(first.credentialRevision);
    expect(first.endpoint).toBe('https://relay.example/v1');
  });

  it('rejects a Provider Plugin that violates the resolved route identity contract', async () => {
    const plugin: LlmProviderPlugin = {
      manifest: {
        id: 'broken-provider-id',
        name: 'Broken provider id',
        version: '1',
        protocol: 'broken',
        priority: 100,
      },
      match: () => ({ score: 100, evidence: [] }),
      discover: () => Promise.resolve({ score: 100, models: ['model'], evidence: [] }),
      createProvider: () => ({
        id: 'wrong-id',
        name: 'wrong',
        mode: 'private',
        capabilities: { chat: 'supported' },
        chat: () => Promise.resolve({ text: 'unused', toolCalls: [] }),
        isAvailable: () => Promise.resolve({ available: true }),
      }),
    };
    const resolver = new LlmConnectionResolver({
      registry: new LlmProviderPluginRegistry([plugin]),
      fetch: () => Promise.resolve(new Response('not found', { status: 404 })),
    });
    const connection = createLlmConnection({ endpoint: 'https://broken.example/v1' });
    const resolution = await resolver.resolve(connection);

    expect(() => resolver.createProvider(connection, resolution)).toThrow(
      /must use resolved provider id/i,
    );
  });
});

function builtinResolver(fetch: LlmFetch): LlmConnectionResolver {
  return new LlmConnectionResolver({
    registry: new LlmProviderPluginRegistry(createBuiltinLlmProviderPlugins()),
    fetch,
    discoveryTimeoutMs: 100,
  });
}
