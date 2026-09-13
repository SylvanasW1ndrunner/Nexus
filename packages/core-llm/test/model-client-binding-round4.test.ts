import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import type {
  LlmConnectionInput,
  LlmProvider,
  LlmProviderPlugin,
  LlmTrustedModelClientFactory,
  ModelClient,
  ModelSession,
  PersistedModelSessionDescriptor,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('Task 2 round-four trusted persisted bindings', () => {
  it('does not expose a capability getter or binder from the package root', () => {
    expect(Reflect.has(core, 'getModelClientBindingCapability')).toBe(false);
    expect(Reflect.has(core, 'bindPreparedModelSessionClient')).toBe(false);
    expect(Reflect.has(core, 'bindTrustedModelSessionClient')).toBe(false);
  });

  it('allows a public per-call client to execute but never to persist or rehydrate', async () => {
    const manager = await createManager({ text: 'trusted' });
    const selection = selectionFor(manager);
    const trusted = await manager.prepareModelSession(selection, {});
    const descriptor = core.describeModelSession(trusted);
    const injected = await manager.prepareModelSession(selection, { client: client('injected') });

    const result = await new core.ModelExecutionGateway().executeAttempt(injected, request());
    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'injected' }]);
    expectErrorCode(() => core.describeModelSession(injected), 'MODEL_CLIENT_BINDING_REQUIRED');
    expectErrorCode(
      () => rehydrate(trusted, descriptor, injected),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
  });

  it('persists and rehydrates only clients returned atomically by the trusted host factory', async () => {
    const manager = await createManager({ text: 'trusted-original' });
    const selection = selectionFor(manager);
    const original = await manager.prepareModelSession(selection, {});
    const descriptor = core.describeModelSession(original);

    const freshManager = await createManager({ text: 'trusted-fresh' });
    const fresh = await freshManager.prepareModelSession(selectionFor(freshManager), {});
    const rebound = rehydrate(original, descriptor, fresh);
    const result = await new core.ModelExecutionGateway().executeAttempt(rebound, request());

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'trusted-fresh' }]);
  });

  it('uses opaque persisted revisions and emits no offline secret verifier', async () => {
    const endpoint = 'http://127.0.0.1:8999';
    const apiKey = 'guessable-api-key';
    const headerSecret = 'guessable-header-secret';
    const connectionConfigurationRevision = 'config-revision-7';
    const credentialRevision = 'credential-revision-11';
    const manager = await createManager({
      text: 'trusted',
      endpoint,
      apiKey,
      headers: { 'X-Tenant-Secret': headerSecret },
      connectionConfigurationRevision,
      credentialRevision,
    });
    const [connection] = manager.connections();
    const session = await manager.prepareModelSession(selectionFor(manager), {});
    const descriptorText = JSON.stringify(core.describeModelSession(session));
    const oldVerifier = createHash('sha256')
      .update(endpoint)
      .update('\0')
      .update(apiKey)
      .update('\0')
      .update(`x-tenant-secret:${headerSecret}`)
      .digest('hex');

    expect(connection!.connectionConfigurationRevision).toBe(connectionConfigurationRevision);
    expect(connection!.credentialRevision).toBe(credentialRevision);
    expect(descriptorText).toContain(connectionConfigurationRevision);
    expect(descriptorText).toContain(credentialRevision);
    expect(descriptorText).not.toContain(apiKey);
    expect(descriptorText).not.toContain(headerSecret);
    expect(descriptorText).not.toContain(oldVerifier);
  });

  it('generates opaque credential revisions without deriving them from secret values', () => {
    const first = core.createLlmConnection({
      endpoint: 'https://relay.example/v1',
      apiKey: 'same-secret',
      headers: { 'X-Secret': 'same-header' },
    });
    const second = core.createLlmConnection({
      endpoint: 'https://relay.example/v1',
      apiKey: 'same-secret',
      headers: { 'X-Secret': 'same-header' },
    });

    expect(first.connectionConfigurationRevision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.credentialRevision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.connectionConfigurationRevision).not.toBe(first.connectionConfigurationRevision);
    expect(second.credentialRevision).not.toBe(first.credentialRevision);
  });

  it.each([
    ['connection configuration', 'config-revision-2', 'credential-revision-1'],
    ['credential', 'config-revision-1', 'credential-revision-2'],
  ] as const)('binds %s revision rotation into route and Session digests', async (
    _label,
    connectionConfigurationRevision,
    credentialRevision,
  ) => {
    const originalManager = await createManager({
      text: 'old',
      connectionConfigurationRevision: 'config-revision-1',
      credentialRevision: 'credential-revision-1',
    });
    const rotatedManager = await createManager({
      text: 'rotated',
      connectionConfigurationRevision,
      credentialRevision,
    });
    const original = await originalManager.prepareModelSession(selectionFor(originalManager), {});
    const rotated = await rotatedManager.prepareModelSession(selectionFor(rotatedManager), {});
    const descriptor = core.describeModelSession(original);

    expect(rotated.route.metadata.digest).not.toBe(original.route.metadata.digest);
    expect(rotated.bindingDigest).not.toBe(original.bindingDigest);
    expectErrorCode(
      () => rehydrate(original, descriptor, rotated),
      'MODEL_CLIENT_BINDING_MISMATCH',
    );
  });

  it('validates missing and malformed clientBinding before property access', async () => {
    const manager = await createManager({ text: 'trusted' });
    const original = await manager.prepareModelSession(selectionFor(manager), {});
    const fresh = await manager.prepareModelSession(selectionFor(manager), {});
    const descriptor = core.describeModelSession(original);
    const missing = { ...descriptor } as Record<string, unknown>;
    delete missing.clientBinding;
    const malformed = [
      { ...descriptor, clientBinding: null },
      {
        ...descriptor,
        clientBinding: {
          connectionResolutionRevision: descriptor.clientBinding.connectionResolutionRevision,
          connectionConfigurationRevision:
            descriptor.clientBinding.connectionConfigurationRevision,
        },
      },
      {
        ...descriptor,
        clientBinding: {
          ...descriptor.clientBinding,
          credentialRevision: 7,
        },
      },
    ];

    expectErrorCode(
      () => rehydrateDescriptor(original, missing, fresh),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
    for (const candidate of malformed) {
      expectErrorCode(
        () => rehydrateDescriptor(original, candidate, fresh),
        'MODEL_CLIENT_BINDING_MISMATCH',
      );
    }
  });
});

function rehydrate(
  original: ModelSession,
  descriptor: PersistedModelSessionDescriptor,
  bindingSession: ModelSession,
): ModelSession {
  return core.rehydrateModelSession({
    descriptor,
    expectedRouteDigest: original.route.metadata.digest,
    expectedSessionDigest: original.bindingDigest,
    expectedCodecRevision: 'openai-chat@1',
    bindingSession,
  });
}

function rehydrateDescriptor(
  original: ModelSession,
  descriptor: unknown,
  bindingSession: ModelSession,
): ModelSession {
  return core.rehydrateModelSession({
    descriptor: descriptor as PersistedModelSessionDescriptor,
    expectedRouteDigest: original.route.metadata.digest,
    expectedSessionDigest: original.bindingDigest,
    expectedCodecRevision: 'openai-chat@1',
    bindingSession,
  });
}

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

async function createManager(options: {
  text: string;
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  connectionConfigurationRevision?: string;
  credentialRevision?: string;
}): Promise<core.LlmConnectionManager> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'core-llm-round4-'));
  directories.push(cacheDirectory);
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: client(options.text),
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new core.LlmConnectionManager({
    cacheDirectory,
    plugins: [formalPlugin()],
    trustedModelClientFactory,
  });
  const input: LlmConnectionInput = {
    name: 'stable',
    endpoint: options.endpoint ?? 'http://127.0.0.1:8999',
    apiKey: options.apiKey ?? 'same-secret',
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    connectionConfigurationRevision:
      options.connectionConfigurationRevision ?? 'config-revision-1',
    credentialRevision: options.credentialRevision ?? 'credential-revision-1',
  };
  manager.replaceConnections([input]);
  await manager.discover(manager.connections()[0]!.id);
  return manager;
}

function selectionFor(manager: core.LlmConnectionManager) {
  return { connectionId: manager.connections()[0]!.id, modelId: 'model-a' };
}

function request(): core.CanonicalModelRequest {
  return {
    model: 'model-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
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
    listModels: () => Promise.resolve(['model-a']),
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
    discover: () => Promise.resolve({ score: 100, models: ['model-a'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
