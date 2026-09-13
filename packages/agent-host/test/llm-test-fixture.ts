import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  deriveLlmConnectionId,
  type LlmGenerationConfig,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmMessage,
  type LlmModelSelection,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClientResponse,
} from '@dbagent/core-llm';
import { afterAll } from 'vitest';
import { GlobalConfigStore } from '../src/global-config.js';
import { type AgentRuntimeOptions } from '../src/types.js';

const FIXTURE_CONNECTION = {
  name: 'Agent host test endpoint',
  endpoint: 'https://agent-host-test-endpoint.invalid/v1',
} as const;
const cacheDirectories = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...cacheDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  cacheDirectories.clear();
});

export function testModelSelection(modelId = 'test-model'): LlmModelSelection {
  return {
    connectionId: deriveLlmConnectionId(FIXTURE_CONNECTION),
    modelId,
  };
}

export function testLlmRuntimeOptions(
  provider: LlmProvider,
  modelId = 'test-model',
  options: {
    parameters?: LlmGenerationConfig;
    models?: readonly string[];
  } = {},
): Pick<AgentRuntimeOptions, 'llmManager' | 'newSessionModel' | 'globalConfigStore'> {
  const cacheDirectory = join(tmpdir(), `schemanaut-host-llm-fixture-${randomUUID()}`);
  cacheDirectories.add(cacheDirectory);
  const manager = new LlmConnectionManager({
    cacheDirectory,
    plugins: [testProviderPlugin(provider, options.models ?? [modelId])],
    trustedModelClientFactory: testTrustedModelClientFactory(provider),
    ...(options.parameters === undefined ? {} : { globalParameters: options.parameters }),
  });
  const [connection] = manager.replaceConnections([FIXTURE_CONNECTION]);
  if (!connection) throw new Error('The host test LLM connection was not created.');
  const selection = testModelSelection(modelId);
  if (connection.id !== selection.connectionId) {
    throw new Error('The host test LLM connection identity is not deterministic.');
  }
  return {
    llmManager: manager,
    newSessionModel: selection,
    globalConfigStore: new GlobalConfigStore({ path: join(cacheDirectory, 'config.toml') }),
  };
}

function testProviderPlugin(provider: LlmProvider, models: readonly string[]): LlmProviderPlugin {
  return {
    manifest: {
      id: `host-test-${provider.id}-${randomUUID()}`,
      name: `host test ${provider.name}`,
      version: '1',
      protocol: 'openai-chat',
      priority: 10_000,
    },
    match: () => ({ score: 10_000, evidence: [] }),
    discover: () =>
      Promise.resolve({
        score: 10_000,
        models: [...models],
        evidence: [{ source: 'endpoint', kind: 'test-fixture', summary: 'Injected test Provider.' }],
      }),
    // Provider Plugins own the route identity. Production plugins construct a
    // fresh provider with this id; the fixture mirrors that contract while
    // retaining the test double's observable state and allowing one double to
    // back multiple isolated connection runtimes.
    createProvider: ({ resolution }) => providerWithRouteId(provider, resolution.providerId),
    ...(provider.generationParameters === undefined
      ? {}
      : { parameters: { support: provider.generationParameters } }),
  };
}

function testTrustedModelClientFactory(provider: LlmProvider): LlmTrustedModelClientFactory {
  return ({ connection, resolution }) => ({
    client: {
      execute: async (request): Promise<ModelClientResponse> => ({
        kind: 'json',
        response: toOpenAIChatResponse(
          await provider.chat(fromOpenAIChatRequest(request.wireRequest)),
          request.route.modelId,
        ),
      }),
    },
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
}

function fromOpenAIChatRequest(input: unknown): LlmChatRequest {
  const wire = input as {
    model: string;
    messages: Array<{
      role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: unknown;
      tool_call_id?: string;
    }>;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    stop?: string[];
    seed?: number;
  };
  const maxTokens = wire.max_completion_tokens ?? wire.max_tokens;
  const messages: LlmMessage[] = wire.messages.map((message) => ({
    // The legacy observable Provider double has no developer role. Preserve
    // canonical instruction semantics by projecting developer text as system
    // only at this test edge.
    role: message.role === 'developer' ? 'system' : message.role,
    content: openAiMessageText(message.content),
    ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }),
  }));
  return {
    model: wire.model,
    messages,
    ...(wire.tools === undefined ? {} : {
      tools: wire.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? '',
        inputSchema: tool.function.parameters,
      })),
    }),
    ...(wire.temperature === undefined ? {} : { temperature: wire.temperature }),
    ...(wire.top_p === undefined ? {} : { topP: wire.top_p }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(wire.stop === undefined ? {} : { stop: [...wire.stop] }),
    ...(wire.seed === undefined ? {} : { seed: wire.seed }),
  };
}

function openAiMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function toOpenAIChatResponse(response: LlmChatResponse, model: string): unknown {
  return {
    id: response.providerResponseId ?? `fixture-${randomUUID()}`,
    model: response.model ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response.text,
        ...(response.toolCalls.length === 0 ? {} : {
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }),
      },
      finish_reason: response.finishReason ?? (response.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    ...(response.usage === undefined ? {} : {
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
      },
    }),
  };
}

function providerWithRouteId(provider: LlmProvider, providerId: string): LlmProvider {
  const stream = provider.stream?.bind(provider);
  const embed = provider.embed?.bind(provider);
  const rerank = provider.rerank?.bind(provider);
  const listModels = provider.listModels?.bind(provider);
  const getModelMetadata = provider.getModelMetadata?.bind(provider);
  return {
    id: providerId,
    name: provider.name,
    mode: provider.mode,
    ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
    ...(provider.capabilities === undefined ? {} : { capabilities: provider.capabilities }),
    ...(provider.generationParameters === undefined
      ? {}
      : { generationParameters: provider.generationParameters }),
    ...(provider.protocolProfile === undefined
      ? {}
      : { protocolProfile: provider.protocolProfile }),
    chat: async (request) => await provider.chat(request),
    ...(stream === undefined ? {} : { stream: (request) => stream(request) }),
    ...(embed === undefined ? {} : { embed: async (request) => await embed(request) }),
    ...(rerank === undefined ? {} : { rerank: async (request) => await rerank(request) }),
    ...(listModels === undefined
      ? {}
      : { listModels: async (signal) => await listModels(signal) }),
    ...(getModelMetadata === undefined
      ? {}
      : { getModelMetadata: async (model, signal) => await getModelMetadata(model, signal) }),
    isAvailable: async (model, signal) => await provider.isAvailable(model, signal),
  };
}
