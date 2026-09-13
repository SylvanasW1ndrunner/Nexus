import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  type LlmConnection,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
  type ModelClient,
  type ModelClientRequest,
  type ModelSession,
} from '@dbagent/core-llm';

export type TestModelSessionOptions = Readonly<{
  connectionId?: string;
  modelId?: string;
  outputText?: string;
  onExecute?: (request: ModelClientRequest) => void;
  execute?: ModelClient['execute'];
}>;

/**
 * Creates the same authenticated, persistable ModelSession that production obtains
 * from LlmConnectionManager. Tests must not forge persisted Model descriptors.
 */
export async function createTestModelSession(
  options: TestModelSessionOptions = {},
): Promise<ModelSession> {
  const connectionId = options.connectionId ?? 'connection-test';
  const modelId = options.modelId ?? 'model-test';
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'core-agent-model-session-'));
  try {
    const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
      client: modelClient(modelId, options),
      bindingEvidence: {
        connectionResolutionRevision: resolution.revision,
        connectionConfigurationRevision: connection.connectionConfigurationRevision,
        credentialRevision: connection.credentialRevision,
      },
    });
    const manager = new LlmConnectionManager({
      cacheDirectory,
      plugins: [providerPlugin(modelId)],
      trustedModelClientFactory,
    });
    const connection: LlmConnection = {
      id: connectionId,
      name: connectionId,
      endpoint: 'http://127.0.0.1:8999',
      apiKey: 'test-only',
      headers: Object.freeze({}),
      connectionConfigurationRevision: `config-${connectionId}`,
      credentialRevision: `credential-${connectionId}`,
    };
    manager.replaceConnections([connection]);
    await manager.discover(connectionId);
    return await manager.prepareModelSession({ connectionId, modelId }, {
      generation: { temperature: 0, maxOutputTokens: 4_096 },
    });
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

function modelClient(modelId: string, options: TestModelSessionOptions): ModelClient {
  return {
    execute: (request) => {
      if (options.execute !== undefined) return options.execute(request);
      options.onExecute?.(request);
      return Promise.resolve({
        kind: 'json',
        response: {
          id: `response-${modelId}`,
          model: modelId,
          status: 'completed',
          output: [{
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: options.outputText ?? 'completed' }],
          }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      });
    },
  };
}

function providerPlugin(modelId: string): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'test-provider',
    name: 'test-provider',
    mode: 'private',
    protocol: 'openai-responses',
    chat: () => Promise.resolve({ text: 'completed', toolCalls: [] }),
    listModels: () => Promise.resolve([modelId]),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      contextTokens: 131_072,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      generationParameters: { temperature: 'supported', maxOutputTokens: 'supported' },
    }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: `test-${modelId}`,
      name: 'test-provider',
      version: '1.0.0',
      protocol: 'openai-responses',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
