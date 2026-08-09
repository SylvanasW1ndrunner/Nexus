import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { legacyProviderCodec } from '../src/legacy-model-compatibility.js';
import type {
  CanonicalModelRequest,
  ModelClient,
  ModelRouteSnapshotInput,
  LlmProvider,
  LlmProviderPlugin,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('Task 2 round-three normalized legacy boundary', () => {
  it.each([
    {
      name: 'reasoning summaries',
      messages: [{ role: 'assistant', content: [{ type: 'reasoning-summary', text: 'hidden' }] }],
    },
    {
      name: 'developer roles',
      messages: [{ role: 'developer', content: [{ type: 'text', text: 'policy' }] }],
    },
    {
      name: 'scalar Tool Call arguments',
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', callId: 'c1', name: 'run', arguments: 'scalar' }] }],
    },
    {
      name: 'Tool Results mixed with other blocks',
      messages: [{ role: 'tool', content: [
        { type: 'tool-result', callId: 'c1', output: {}, isError: false },
        { type: 'text', text: 'extra' },
      ] }],
    },
    {
      name: 'Tool Calls interleaved before text',
      messages: [{ role: 'assistant', content: [
        { type: 'tool-call', callId: 'c1', name: 'run', arguments: {} },
        { type: 'text', text: 'after' },
      ] }],
    },
    {
      name: 'multiple Text blocks that would be merged',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ] }],
    },
    {
      name: 'empty Text blocks that would be dropped',
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    },
  ] as const)('rejects unrepresentable $name', async ({ messages }) => {
    const session = core.createModelSession({
      route: legacyRoute(),
      generation: {},
      codec: legacyProviderCodec,
      client: legacyClient(),
    });
    const request = { model: 'model-1', messages } as unknown as CanonicalModelRequest;

    await expect(new core.ModelExecutionGateway().executeAttempt(session, request, { maxRetries: 0 }))
      .rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED' });
  });

  it('reports legacy Sessions as typed non-persistable instead of emitting a dead descriptor', () => {
    const session = core.createModelSession({
      route: legacyRoute(),
      generation: {},
      codec: legacyProviderCodec,
      client: legacyClient(),
    });

    expectErrorCode(
      () => core.describeModelSession(session),
      'MODEL_SESSION_NOT_PERSISTABLE',
    );
  });

  it('preserves unknown codec failure as a permanent public binding/config error', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'core-llm-unknown-codec-'));
    directories.push(cacheDirectory);
    const manager = new core.LlmConnectionManager({ cacheDirectory, plugins: [unknownPlugin()] });
    const [connection] = manager.replaceConnections([{ endpoint: 'http://127.0.0.1:8999' }]);

    await expect(manager.executeChat({
      selection: { connectionId: connection!.id, modelId: 'model-1' },
      request: { messages: [{ role: 'user', content: 'hello' }] },
      context: { tenantId: 'tenant', taskType: 'review' },
    })).rejects.toMatchObject({
      code: 'LLM_MODEL_BINDING_INVALID',
      retryable: false,
      detail: { modelGatewayCode: 'MODEL_CODEC_UNAVAILABLE' },
    });
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

function legacyRoute(): ModelRouteSnapshotInput {
  return {
    routeId: 'legacy-route',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    protocol: 'legacy-normalized',
    codecRevision: 'legacy-normalized@1',
    capabilities: { chat: 'supported', toolCalling: 'supported' },
    generationParameters: {},
    contextTokens: 8_192,
    maxInputTokens: 4_096,
    maxOutputTokens: 1_024,
    metadata: { source: 'fixture', revision: 'legacy-v1', digest: 'computed' },
  };
}

function legacyClient(): ModelClient {
  return {
    execute: () => Promise.resolve({
      kind: 'json',
      response: { text: 'should not execute', toolCalls: [] },
    }),
  };
}

function unknownPlugin(): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'placeholder',
    name: 'unknown',
    mode: 'private',
    protocol: 'unknown-wire',
    chat: () => Promise.resolve({ text: 'no', toolCalls: [] }),
    listModels: () => Promise.resolve(['model-1']),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      capabilities: { chat: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'unknown-test', name: 'unknown', version: '1.0.0', protocol: 'unknown-wire', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: ['model-1'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
