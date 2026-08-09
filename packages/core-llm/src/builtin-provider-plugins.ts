import { AnthropicProvider } from './anthropic-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { OpenAIResponsesProvider } from './openai-responses-provider.js';
import type { LlmConnection } from './llm-connection.js';
import type {
  LlmPassiveJsonResponse,
  LlmProviderDiscovery,
  LlmProviderPlugin,
  LlmProviderPluginManifest,
} from './provider-plugin.js';

const BUILTIN_PLUGIN_VERSION = '1.0.0';

export function createBuiltinLlmProviderPlugins(): LlmProviderPlugin[] {
  return [
    ollamaPlugin(),
    anthropicPlugin(),
    openAIResponsesPlugin(),
    openAICompatiblePlugin(),
  ];
}

function ollamaPlugin(): LlmProviderPlugin {
  const manifest = builtinManifest('ollama-native', 'Ollama native', 'ollama', 90);
  return {
    manifest,
    match: () => ({
      score: 1,
      evidence: [{ source: 'plugin', kind: 'passive-probe', summary: 'Ollama metadata probe is available.' }],
    }),
    discover: async (context) => {
      const response = await context.getJson({ path: '/api/tags' });
      if (!isOllamaTagsResponse(response)) return noDiscovery(response, 'ollama-tags-not-detected');
      return {
        score: 220,
        models: ollamaModels(response.json),
        evidence: [endpointEvidence(response, 'ollama-tags', 'Endpoint returned the Ollama tags contract.')],
      };
    },
    createProvider: ({ connection, resolution, fetch, timeoutMs }) =>
      new OllamaProvider({
        id: resolution.providerId,
        name: connection.name,
        baseUrl: resolution.providerBaseUrl,
        timeoutMs,
        defaultHeaders: { ...connection.headers },
        fetch,
      }),
  };
}

function anthropicPlugin(): LlmProviderPlugin {
  const manifest = builtinManifest('anthropic-messages', 'Anthropic Messages', 'anthropic', 80);
  return {
    manifest,
    match: (connection) => {
      const host = new URL(connection.endpoint).hostname.toLocaleLowerCase();
      const official = host === 'api.anthropic.com';
      const named = host.includes('anthropic') || connection.name.toLocaleLowerCase().includes('anthropic');
      return {
        score: official ? 190 : named ? 120 : 0,
        evidence: official
          ? [{ source: 'plugin', kind: 'official-host', summary: 'Endpoint is the official Anthropic API host.' }]
          : named
            ? [{ source: 'plugin', kind: 'anthropic-host', summary: 'Endpoint identity indicates Anthropic Messages.' }]
            : [],
      };
    },
    discover: async (context) => {
      const response = await context.getJson({
        path: '/models',
        headers: {
          ...(context.connection.apiKey ? { 'x-api-key': context.connection.apiKey } : {}),
          'anthropic-version': '2023-06-01',
        },
      });
      return openAIShapeDiscovery(response, 'anthropic-models', 20);
    },
    createProvider: ({ connection, resolution, fetch, timeoutMs }) => {
      if (!connection.apiKey) throw new Error('Anthropic Messages requires an API key.');
      return new AnthropicProvider({
        id: resolution.providerId,
        name: connection.name,
        baseUrl: resolution.providerBaseUrl,
        apiKey: connection.apiKey,
        defaultHeaders: { ...connection.headers },
        timeoutMs,
        fetch,
      });
    },
  };
}

function openAIResponsesPlugin(): LlmProviderPlugin {
  const manifest = builtinManifest('openai-responses', 'OpenAI Responses', 'openai-responses', 70);
  return {
    manifest,
    match: (connection) => {
      const official = new URL(connection.endpoint).hostname.toLocaleLowerCase() === 'api.openai.com';
      return {
        score: official ? 200 : 2,
        evidence: official
          ? [{ source: 'plugin', kind: 'official-host', summary: 'Endpoint is the official OpenAI API host.' }]
          : [],
      };
    },
    discover: async (context) => {
      const response = await context.getJson({
        path: '/models',
        headers: bearerHeaders(context.connection),
      });
      return openAIShapeDiscovery(response, 'openai-models', 20);
    },
    createProvider: ({ connection, resolution, fetch, timeoutMs }) =>
      new OpenAIResponsesProvider({
        id: resolution.providerId,
        name: connection.name,
        baseUrl: resolution.providerBaseUrl,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        allowUnauthenticated: !connection.apiKey,
        defaultHeaders: { ...connection.headers },
        timeoutMs,
        fetch,
      }),
  };
}

function openAICompatiblePlugin(): LlmProviderPlugin {
  const manifest = builtinManifest('openai-compatible', 'OpenAI compatible', 'openai-chat', 10);
  return {
    manifest,
    match: (connection) => ({
      score: new URL(connection.endpoint).hostname.toLocaleLowerCase() === 'api.openai.com' ? 50 : 10,
      evidence: [{
        source: 'plugin',
        kind: 'compatible-fallback',
        summary: 'OpenAI Chat compatibility is the fallback for an otherwise unknown endpoint.',
      }],
    }),
    discover: async (context) => {
      const response = await context.getJson({
        path: '/models',
        headers: bearerHeaders(context.connection),
      });
      return openAIShapeDiscovery(response, 'openai-compatible-models', 120);
    },
    createProvider: ({ connection, resolution, fetch, timeoutMs }) =>
      new OpenAICompatibleProvider({
        id: resolution.providerId,
        name: connection.name,
        baseUrl: resolution.providerBaseUrl,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        allowUnauthenticated: !connection.apiKey,
        defaultHeaders: { ...connection.headers },
        metadataSource: 'openai-compatible',
        timeoutMs,
        fetch,
      }),
  };
}

function builtinManifest(
  id: string,
  name: string,
  protocol: string,
  priority: number,
): LlmProviderPluginManifest {
  return { id, name, version: BUILTIN_PLUGIN_VERSION, protocol, priority };
}

function bearerHeaders(connection: LlmConnection): Record<string, string> {
  return connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {};
}

function isOllamaTagsResponse(response: LlmPassiveJsonResponse): boolean {
  return response.ok && isRecord(response.json) && Array.isArray(response.json.models) &&
    response.json.models.every(
      (model) => isRecord(model) && (typeof model.name === 'string' || typeof model.model === 'string'),
    );
}

function ollamaModels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models
    .map((model) => isRecord(model) ? model.model ?? model.name : undefined)
    .filter((model): model is string => typeof model === 'string' && Boolean(model.trim()));
}

function openAIShapeDiscovery(
  response: LlmPassiveJsonResponse,
  kind: string,
  score: number,
): LlmProviderDiscovery {
  if (!response.ok || !isRecord(response.json) || !Array.isArray(response.json.data)) {
    return noDiscovery(response, `${kind}-not-detected`);
  }
  const validShape = response.json.data.every(
    (model) => isRecord(model) && typeof model.id === 'string',
  );
  if (!validShape) return noDiscovery(response, `${kind}-not-detected`);
  return {
    score,
    models: response.json.data.map((model) => (model as Record<string, unknown>).id as string),
    evidence: [endpointEvidence(response, kind, 'Endpoint returned an OpenAI-compatible model catalog.')],
  };
}

function noDiscovery(response: LlmPassiveJsonResponse, kind: string): LlmProviderDiscovery {
  return {
    score: 0,
    evidence: [endpointEvidence(response, kind, `Metadata endpoint returned HTTP ${response.status}.`)],
  };
}

function endpointEvidence(
  response: LlmPassiveJsonResponse,
  kind: string,
  summary: string,
) {
  return {
    source: 'endpoint' as const,
    kind,
    summary,
    statusCode: response.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
