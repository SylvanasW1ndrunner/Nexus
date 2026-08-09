import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmConnectionManager,
  LlmProviderError,
  type LlmModelMetadata,
  type LlmProvider,
  type LlmProviderPlugin,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LlmConnectionManager', () => {
  it('discovers and isolates multiple user connections before a model is selected', async () => {
    const manager = await createManager({
      fetch: (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/models')) {
          return Promise.resolve(Response.json({ data: [{ id: `${url.hostname}-chat` }] }));
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
    });
    const connections = manager.replaceConnections([
      { name: 'first', endpoint: 'https://first.example/v1', apiKey: 'first-secret' },
      { name: 'second', endpoint: 'https://second.example/v1', apiKey: 'second-secret' },
    ]);

    await Promise.all(connections.map((connection) => manager.discover(connection.id)));

    expect(manager.models({ connectionId: connections[0]!.id }).map((model) => model.modelId))
      .toEqual(['first.example-chat']);
    expect(manager.models({ connectionId: connections[1]!.id }).map((model) => model.modelId))
      .toEqual(['second.example-chat']);
  });

  it('merges request, session and project parameters with explicit source attribution', async () => {
    const manager = await createManager({
      projectParameters: { temperature: 0.1, topP: 0.8, maxOutputTokens: 2_048 },
      plugins: [capabilityPlugin()],
    });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id);
    const selection = { connectionId: connection!.id, modelId: 'chat-model' };

    const effective = manager.effectiveParameters(selection, {
      session: { temperature: 0.2, seed: 9 },
      request: { temperature: 0.3, stop: ['END'] },
    });

    expect(effective.values).toEqual({
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 2_048,
      seed: 9,
      stop: ['END'],
    });
    expect(effective.sources).toMatchObject({
      temperature: 'request',
      topP: 'project',
      seed: 'session',
      stop: 'request',
    });
  });

  it('fails before a request for a known unsupported parameter and passes unknown support through', async () => {
    const provider = new CapabilityProvider();
    const manager = await createManager({ plugins: [capabilityPlugin(provider)] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id);

    expectProviderError(() =>
      manager.effectiveParameters(
        { connectionId: connection!.id, modelId: 'chat-model' },
        { request: { reasoningEffort: 'high' } },
      ),
      'LLM_PARAMETER_UNSUPPORTED',
    );

    const result = await manager.executeChat({
      selection: { connectionId: connection!.id, modelId: 'chat-model' },
      request: { messages: [{ role: 'user', content: 'hello' }] },
      parameters: { temperature: 0.42 },
      context: { tenantId: 'tenant', taskType: 'agent' },
    });
    expect(provider.lastTemperature).toBe(0.42);
    expect(result.response.text).toBe('ok');
  });

  it('applies Provider Plugin parameter support and normalization at the wire boundary', async () => {
    const provider = new CapabilityProvider();
    const plugin: LlmProviderPlugin = {
      ...capabilityPlugin(provider),
      parameters: {
        support: { seed: 'unsupported' },
        normalize: (config) => ({
          ...config,
          ...(config.temperature === undefined
            ? {}
            : { temperature: config.temperature * 2 }),
        }),
      },
    };
    const manager = await createManager({ plugins: [plugin] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id);
    const selection = { connectionId: connection!.id, modelId: 'chat-model' };

    expectProviderError(
      () => manager.effectiveParameters(selection, { request: { seed: 7 } }),
      'LLM_PARAMETER_UNSUPPORTED',
    );
    await manager.chat({
      selection,
      request: { messages: [{ role: 'user', content: 'hello' }] },
      parameters: { temperature: 0.2 },
      context: { tenantId: 'tenant', taskType: 'agent' },
    });
    expect(provider.lastTemperature).toBe(0.4);
  });

  it('normalizes unknown transport failures through the selected Provider Plugin classifier', async () => {
    const provider = new CapabilityProvider();
    provider.chat = () => Promise.reject(new Error('relay-overloaded'));
    const plugin: LlmProviderPlugin = {
      ...capabilityPlugin(provider),
      errors: {
        classify: (error) =>
          error instanceof Error && error.message === 'relay-overloaded'
            ? new LlmProviderError('LLM_RATE_LIMITED', 'The relay is overloaded.', true, 429)
            : undefined,
      },
    };
    const manager = await createManager({ plugins: [plugin] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);

    await expect(
      manager.chat({
        selection: { connectionId: connection!.id, modelId: 'chat-model' },
        request: { messages: [{ role: 'user', content: 'hello' }] },
        context: { tenantId: 'tenant', taskType: 'agent' },
      }),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED', statusCode: 429, retryable: true });
  });

  it('validates maxOutputTokens against discovered model limits', async () => {
    const provider = new CapabilityProvider();
    provider.metadata = {
      model: 'chat-model',
      source: 'provider-api',
      capabilities: { chat: 'supported' },
      contextTokens: 8_192,
      maxOutputTokens: 1_024,
    };
    const manager = await createManager({ plugins: [capabilityPlugin(provider)] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id, { inspectModelIds: ['chat-model'] });

    expectProviderError(() =>
      manager.effectiveParameters(
        { connectionId: connection!.id, modelId: 'chat-model' },
        { request: { maxOutputTokens: 2_048 } },
      ),
      'LLM_PARAMETER_UNSUPPORTED',
    );
  });

  it('dispatches embedding and rerank through the selected capability route', async () => {
    const provider = new CapabilityProvider();
    const manager = await createManager({ plugins: [capabilityPlugin(provider)] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id);

    const embedding = await manager.embed({
      selection: { connectionId: connection!.id, modelId: 'embedding-model' },
      input: ['hello'],
      context: { tenantId: 'tenant', taskType: 'embedding' },
    });
    const reranked = await manager.rerank({
      selection: { connectionId: connection!.id, modelId: 'rerank-model' },
      query: 'q',
      documents: ['a', 'b'],
      context: { tenantId: 'tenant', taskType: 'rerank' },
    });

    expect(embedding.embeddings).toEqual([[1, 0]]);
    expect(reranked.results[0]).toMatchObject({ index: 1, score: 0.9 });
  });

  it('classifies and annotates embedding and rerank failures at the plugin boundary', async () => {
    const provider = new CapabilityProvider();
    provider.embed = () => Promise.reject(new Error('fixture-capacity'));
    provider.rerank = () => Promise.reject(new Error('fixture-capacity'));
    const plugin: LlmProviderPlugin = {
      ...capabilityPlugin(provider),
      errors: {
        classify: (error) =>
          error instanceof Error && error.message === 'fixture-capacity'
            ? new LlmProviderError('LLM_RATE_LIMITED', 'Capacity exhausted.', true, 429)
            : undefined,
      },
    };
    const manager = await createManager({ plugins: [plugin] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);

    await expect(
      manager.embed({
        selection: { connectionId: connection!.id, modelId: 'embedding-model' },
        input: ['hello'],
        context: { tenantId: 'tenant', taskType: 'embedding' },
      }),
    ).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
      statusCode: 429,
      detail: {
        connectionId: connection!.id,
        modelId: 'embedding-model',
        pluginId: 'capability-test',
      },
    });
    await expect(
      manager.rerank({
        selection: { connectionId: connection!.id, modelId: 'rerank-model' },
        query: 'q',
        documents: ['a'],
        context: { tenantId: 'tenant', taskType: 'rerank' },
      }),
    ).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
      detail: {
        connectionId: connection!.id,
        modelId: 'rerank-model',
        pluginId: 'capability-test',
      },
    });
  });

  it('coalesces concurrent preparation and keeps the installed catalog executable', async () => {
    const provider = new CapabilityProvider();
    let metadataCalls = 0;
    provider.getModelMetadata = async (model) => {
      metadataCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...provider.metadata, model };
    };
    const manager = await createManager({ plugins: [capabilityPlugin(provider)] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    const selection = { connectionId: connection!.id, modelId: 'chat-model' };

    const [first, second] = await Promise.all([
      manager.prepare(selection),
      manager.prepare(selection),
    ]);

    expect(first.model.modelId).toBe('chat-model');
    expect(second.model.modelId).toBe('chat-model');
    expect(metadataCalls).toBe(1);
    expect(manager.models({ connectionId: connection!.id })).toHaveLength(3);
    await expect(
      manager.chat({
        selection,
        request: { messages: [{ role: 'user', content: 'hello' }] },
        context: { tenantId: 'tenant', taskType: 'agent' },
      }),
    ).resolves.toMatchObject({ text: 'ok' });
  });

  it('keeps an unchanged runtime and catalog across settings reloads', async () => {
    const provider = new CapabilityProvider();
    let modelListCalls = 0;
    provider.listModels = () => {
      modelListCalls += 1;
      return Promise.resolve(['chat-model', 'embedding-model', 'rerank-model']);
    };
    const manager = await createManager({ plugins: [capabilityPlugin(provider)] });
    const input = {
      name: 'local',
      endpoint: 'http://127.0.0.1:8999',
      apiKey: 'first',
      connectionConfigurationRevision: 'config-v1',
      credentialRevision: 'credential-v1',
    };
    const [connection] = manager.replaceConnections([input]);
    await manager.discover(connection!.id);

    manager.replaceConnections([{ ...input }]);
    const prepared = await manager.prepare({ connectionId: connection!.id, modelId: 'chat-model' });

    expect(prepared.model.modelId).toBe('chat-model');
    expect(modelListCalls).toBe(0);
  });

  it('removes connection-bound providers and models on replacement', async () => {
    const manager = await createManager({ plugins: [capabilityPlugin()] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);
    await manager.discover(connection!.id);

    manager.replaceConnections([]);

    expect(manager.connections()).toEqual([]);
    expect(manager.models()).toEqual([]);
    await expect(manager.discover(connection!.id)).rejects.toThrow(/not configured/i);
  });
});

class CapabilityProvider implements LlmProvider {
  readonly id = 'placeholder';
  readonly name = 'Capability provider';
  readonly mode = 'private' as const;
  readonly protocol = 'legacy-normalized';
  readonly capabilities = {
    chat: 'supported' as const,
    streaming: 'supported' as const,
    embeddings: 'supported' as const,
    rerank: 'supported' as const,
    toolCalling: 'supported' as const,
  };
  readonly generationParameters = {
    reasoningEffort: 'unsupported' as const,
    temperature: 'unknown' as const,
  };
  metadata: LlmModelMetadata = {
    model: 'chat-model',
    source: 'provider-api' as const,
    capabilities: { chat: 'supported' as const },
  };
  lastTemperature: number | undefined;

  chat(request: Parameters<LlmProvider['chat']>[0]) {
    this.lastTemperature = request.temperature;
    return Promise.resolve({ text: 'ok', toolCalls: [] });
  }

  async *stream(request: Parameters<NonNullable<LlmProvider['stream']>>[0]) {
    const response = await this.chat(request);
    yield { type: 'text-delta' as const, text: response.text };
    yield { type: 'finish' as const, response };
  }

  listModels() {
    return Promise.resolve(['chat-model', 'embedding-model', 'rerank-model']);
  }

  getModelMetadata(model: string) {
    return Promise.resolve({ ...this.metadata, model });
  }

  embed() {
    return Promise.resolve({ embeddings: [[1, 0]] });
  }

  rerank() {
    return Promise.resolve({ results: [{ index: 1, score: 0.9 }] });
  }

  isAvailable() {
    return Promise.resolve({ available: true });
  }
}

function capabilityPlugin(provider = new CapabilityProvider()): LlmProviderPlugin {
  return {
    manifest: {
      id: 'capability-test',
      name: 'Capability test',
      version: '1.0.0',
      protocol: 'legacy-normalized',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () =>
      Promise.resolve({
        score: 100,
        models: ['chat-model', 'embedding-model', 'rerank-model'],
        evidence: [],
      }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

async function createManager(
  options: Partial<ConstructorParameters<typeof LlmConnectionManager>[0]> = {},
): Promise<LlmConnectionManager> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-connection-manager-'));
  directories.push(cacheDirectory);
  return new LlmConnectionManager({ cacheDirectory, ...options });
}

function expectProviderError(operation: () => unknown, code: LlmProviderError['code']): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LlmProviderError);
  if (!(caught instanceof LlmProviderError)) {
    throw new Error(`Expected LlmProviderError ${code}.`);
  }
  expect(caught.code).toBe(code);
}
