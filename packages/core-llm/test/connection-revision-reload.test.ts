import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmConnectionManager,
  ModelExecutionGateway,
  describeModelSession,
  rehydrateModelSession,
  type CanonicalModelRequest,
  type LlmConnectionInput,
  type LlmProvider,
  type LlmProviderPlugin,
  type ModelClient,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('opaque connection revision reload compatibility', () => {
  it('reuses revisions and the discovered runtime for an identical legacy input', async () => {
    const discoveries = { count: 0 };
    const manager = await createManager('trusted', discoveries);
    const input = legacyInput();
    const [first] = manager.replaceConnections([input]);
    await manager.discover(first!.id);

    const [reloaded] = manager.replaceConnections([{ ...input }]);
    await manager.prepare({ connectionId: reloaded!.id, modelId: 'model-a' });

    expect(reloaded!.connectionConfigurationRevision)
      .toBe(first!.connectionConfigurationRevision);
    expect(reloaded!.credentialRevision).toBe(first!.credentialRevision);
    expect(discoveries.count).toBe(1);
  });

  it.each([
    {
      name: 'API key',
      first: legacyInput({ apiKey: 'key-one' }),
      next: legacyInput({ apiKey: 'key-two' }),
    },
    {
      name: 'header',
      first: legacyInput({ headers: { 'X-Secret': 'one' } }),
      next: legacyInput({ headers: { 'X-Secret': 'two' } }),
    },
  ])('rotates only credentialRevision when the $name changes', async ({ first, next }) => {
    const manager = await createManager('trusted');
    const [original] = manager.replaceConnections([first]);

    const [rotated] = manager.replaceConnections([next]);

    expect(rotated!.connectionConfigurationRevision)
      .toBe(original!.connectionConfigurationRevision);
    expect(rotated!.credentialRevision).not.toBe(original!.credentialRevision);
    expect(rotated!.credentialScope).toBe(rotated!.credentialRevision);
  });

  it('gives each explicit revision priority while reusing the omitted unchanged revision', async () => {
    const manager = await createManager('trusted');
    const input = legacyInput();
    const [initial] = manager.replaceConnections([input]);

    const [explicitConfiguration] = manager.replaceConnections([{
      ...input,
      connectionConfigurationRevision: 'explicit-config-v2',
    }]);
    const [explicitCredential] = manager.replaceConnections([{
      ...input,
      credentialRevision: 'explicit-credential-v2',
    }]);

    expect(explicitConfiguration!.connectionConfigurationRevision).toBe('explicit-config-v2');
    expect(explicitConfiguration!.credentialRevision).toBe(initial!.credentialRevision);
    expect(explicitCredential!.connectionConfigurationRevision).toBe('explicit-config-v2');
    expect(explicitCredential!.credentialRevision).toBe('explicit-credential-v2');
  });

  it('preserves resolved revisions in a new manager for trusted rehydration', async () => {
    const originalManager = await createManager('original');
    const [resolved] = originalManager.replaceConnections([legacyInput()]);
    await originalManager.discover(resolved!.id);
    const original = await originalManager.prepareModelSession(
      { connectionId: resolved!.id, modelId: 'model-a' },
      {},
    );
    const descriptor = describeModelSession(original);

    const freshManager = await createManager('fresh');
    freshManager.replaceConnections([resolved!]);
    await freshManager.discover(resolved!.id);
    const fresh = await freshManager.prepareModelSession(
      { connectionId: resolved!.id, modelId: 'model-a' },
      {},
    );
    const rebound = rehydrateModelSession({
      descriptor,
      expectedRouteDigest: original.route.metadata.digest,
      expectedSessionDigest: original.bindingDigest,
      expectedCodecRevision: 'openai-chat@1',
      bindingSession: fresh,
    });

    const result = await new ModelExecutionGateway().executeAttempt(rebound, request());
    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'fresh' }]);
  });
});

function legacyInput(overrides: Partial<LlmConnectionInput> = {}): LlmConnectionInput {
  return {
    name: 'stable',
    endpoint: 'http://127.0.0.1:8999',
    apiKey: 'same-secret',
    headers: { 'X-Tenant': 'same-header' },
    ...overrides,
  };
}

async function createManager(
  text: string,
  discoveries: { count: number } = { count: 0 },
): Promise<LlmConnectionManager> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'core-llm-revision-reload-'));
  directories.push(cacheDirectory);
  return new LlmConnectionManager({
    cacheDirectory,
    plugins: [formalPlugin(discoveries)],
    trustedModelClientFactory: ({ connection, resolution }) => ({
      client: client(text),
      bindingEvidence: {
        connectionResolutionRevision: resolution.revision,
        connectionConfigurationRevision: connection.connectionConfigurationRevision,
        credentialRevision: connection.credentialRevision,
      },
    }),
  });
}

function request(): CanonicalModelRequest {
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

function formalPlugin(discoveries: { count: number }): LlmProviderPlugin {
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
      id: 'reload-test', name: 'reload', version: '1.0.0', protocol: 'openai-chat', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => {
      discoveries.count += 1;
      return Promise.resolve({ score: 100, models: ['model-a'], evidence: [] });
    },
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
