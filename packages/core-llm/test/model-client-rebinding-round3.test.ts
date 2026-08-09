import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import type {
  ModelClient,
  ModelSession,
  PersistedModelSessionDescriptor,
  LlmProvider,
  LlmProviderPlugin,
} from '../src/index.js';

type RebindingApi = {
  getModelClientBindingCapability(session: ModelSession): unknown;
  rehydrateModelSession(input: {
    descriptor: PersistedModelSessionDescriptor;
    expectedRouteDigest: string;
    expectedSessionDigest: string;
    expectedCodecRevision: string;
    capability?: unknown;
    client?: ModelClient;
  }): ModelSession;
};

const rebinding = core as typeof core & RebindingApi;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('Task 2 round-three authenticated client rebinding', () => {
  it('rehydrates with a fresh capability prepared for the exact same route and config', async () => {
    const manager = await createManager('first-secret');
    const selection = selectionFor(manager);
    const original = await manager.prepareModelSession(selection, { client: client('original') });
    const fresh = await manager.prepareModelSession(selection, { client: client('fresh') });
    const descriptor = core.describeModelSession(original);
    const capability = rebinding.getModelClientBindingCapability(fresh);

    const rebound = rebinding.rehydrateModelSession({
      descriptor,
      expectedRouteDigest: original.route.metadata.digest,
      expectedSessionDigest: original.bindingDigest,
      expectedCodecRevision: 'openai-chat@1',
      capability,
    });
    const result = await new core.ModelExecutionGateway().executeAttempt(rebound, {
      model: selection.modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'fresh' }]);
    expect(JSON.stringify(descriptor)).not.toContain('first-secret');
  });

  it('rejects a capability prepared for another model route', async () => {
    const manager = await createManager('secret');
    const original = await manager.prepareModelSession(selectionFor(manager), { client: client('a') });
    const other = await manager.prepareModelSession(
      { ...selectionFor(manager), modelId: 'model-b' },
      { client: client('b') },
    );
    const descriptor = core.describeModelSession(original);

    expectErrorCode(
      () => rehydrate(original, descriptor, rebinding.getModelClientBindingCapability(other)),
      'MODEL_CLIENT_BINDING_MISMATCH',
    );
  });

  it('rejects endpoint credential/config drift even when connection and route ids are stable', async () => {
    const oldManager = await createManager('old-secret');
    const newManager = await createManager('new-secret');
    const original = await oldManager.prepareModelSession(selectionFor(oldManager), { client: client('old') });
    const drifted = await newManager.prepareModelSession(selectionFor(newManager), { client: client('new') });
    const descriptor = core.describeModelSession(original);

    expectErrorCode(
      () => rehydrate(original, descriptor, rebinding.getModelClientBindingCapability(drifted)),
      'MODEL_CLIENT_BINDING_MISMATCH',
    );
  });

  it('rejects a tampered route even with a genuine capability', async () => {
    const manager = await createManager('secret');
    const original = await manager.prepareModelSession(selectionFor(manager), { client: client('a') });
    const descriptor = core.describeModelSession(original);
    const capability = rebinding.getModelClientBindingCapability(original);
    const tampered = {
      ...descriptor,
      route: { ...descriptor.route, providerId: 'forged-provider' },
    };

    expectErrorCode(
      () => rehydrate(original, tampered, capability),
      'MODEL_CLIENT_BINDING_MISMATCH',
    );
  });

  it('rejects missing, forged, and raw-client handles with a typed binding-required error', async () => {
    const manager = await createManager('secret');
    const original = await manager.prepareModelSession(selectionFor(manager), { client: client('a') });
    const descriptor = core.describeModelSession(original);
    const base = {
      descriptor,
      expectedRouteDigest: original.route.metadata.digest,
      expectedSessionDigest: original.bindingDigest,
      expectedCodecRevision: 'openai-chat@1',
    };

    expectErrorCode(
      () => rebinding.rehydrateModelSession(base),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
    expectErrorCode(
      () => rebinding.rehydrateModelSession({ ...base, capability: {} }),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
    expectErrorCode(
      () => rebinding.rehydrateModelSession({ ...base, client: client('raw') }),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
  });

  it('reports a missing bundle capability binding with the same typed error', async () => {
    const manager = await createManager('secret');
    const session = await manager.prepareModelSession(selectionFor(manager), { client: client('a') });
    const bundle = core.createModelSessionBundle({
      primary: session,
      fallbacks: [],
      policy: { allowCrossConnection: false, allowCrossModel: false },
    });
    const descriptor = core.describeModelSessionBundle(bundle);

    expectErrorCode(
      () => core.rehydrateModelSessionBundle({
        descriptor,
        expectedBundleDigest: bundle.bindingDigest,
        bindings: {},
      }),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
  });
});

function expectErrorCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error & { readonly code?: unknown }).code).toBe(code);
}

function rehydrate(
  original: ModelSession,
  descriptor: PersistedModelSessionDescriptor,
  capability: unknown,
): ModelSession {
  return rebinding.rehydrateModelSession({
    descriptor,
    expectedRouteDigest: original.route.metadata.digest,
    expectedSessionDigest: original.bindingDigest,
    expectedCodecRevision: 'openai-chat@1',
    capability,
  });
}

async function createManager(apiKey: string): Promise<core.LlmConnectionManager> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'core-llm-rebind-'));
  directories.push(cacheDirectory);
  const manager = new core.LlmConnectionManager({
    cacheDirectory,
    plugins: [formalPlugin()],
  });
  manager.replaceConnections([{
    name: 'stable',
    endpoint: 'http://127.0.0.1:8999',
    apiKey,
  }]);
  await manager.discover(manager.connections()[0]!.id);
  return manager;
}

function selectionFor(manager: core.LlmConnectionManager) {
  return { connectionId: manager.connections()[0]!.id, modelId: 'model-a' };
}

function client(text: string): ModelClient {
  return {
    execute: () => Promise.resolve({
      kind: 'json',
      response: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
    }),
  };
}

function formalPlugin(): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'placeholder',
    name: 'formal',
    mode: 'private',
    protocol: 'openai-chat',
    chat: () => Promise.resolve({ text: 'provider', toolCalls: [] }),
    listModels: () => Promise.resolve(['model-a', 'model-b']),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      capabilities: { chat: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'formal-test', name: 'formal', version: '1.0.0', protocol: 'openai-chat', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({
      score: 100,
      models: ['model-a', 'model-b'],
      evidence: [],
    }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
