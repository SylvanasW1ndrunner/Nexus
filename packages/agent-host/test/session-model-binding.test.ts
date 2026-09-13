import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
  type LlmProviderPlugin,
  type LlmTrustedModelClientFactory,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Session model binding', () => {
  it('keeps model choice and parameters isolated across durable Sessions', async () => {
    const fixture = await createFixture();
    const runtime = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
    });

    try {
      const first = await runtime.runAgent({
        message: 'First Session',
        model: { connectionId: fixture.connectionId, modelId: 'model-a' },
        sessionParameters: { temperature: 0.2 },
        generation: { temperature: 0.7 },
      });
      const second = await runtime.runAgent({
        message: 'Second Session',
        model: { connectionId: fixture.connectionId, modelId: 'model-b' },
        sessionParameters: { temperature: 0.4 },
      });
      await runtime.runAgent({ message: 'Resume first', sessionId: first.sessionId });

      expect(fixture.provider.requests.map((request) => request.model)).toEqual([
        'model-a',
        'model-b',
        'model-a',
      ]);
      expect(fixture.provider.requests.map((request) => request.temperature)).toEqual([
        0.7,
        0.4,
        0.2,
      ]);
      expect((await runtime.getAgentSession(first.sessionId))?.model).toMatchObject({
        connectionId: fixture.connectionId,
        modelId: 'model-a',
        parameters: { temperature: 0.2 },
      });
      expect((await runtime.getAgentSession(second.sessionId))?.model).toMatchObject({
        connectionId: fixture.connectionId,
        modelId: 'model-b',
        parameters: { temperature: 0.4 },
      });
    } finally {
      await runtime.close();
    }

    const restored = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
    });
    try {
      const sessions = await restored.listAgentSessions();
      const firstSession = sessions.items.find((session) => session.title === 'First Session');
      const view = await restored.getAgentSession(firstSession!.sessionId);
      expect(view?.model).toEqual({
        connectionId: fixture.connectionId,
        modelId: 'model-a',
        parameters: { temperature: 0.2 },
      });
    } finally {
      await restored.close();
    }
  });

  it('switches one durable Session without changing another Session', async () => {
    const fixture = await createFixture();
    const runtime = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
      newSessionModel: { connectionId: fixture.connectionId, modelId: 'model-a' },
    });
    try {
      const first = await runtime.runAgent({ message: 'First Session' });
      const second = await runtime.runAgent({ message: 'Second Session' });

      await runtime.selectSessionModel({
        sessionId: first.sessionId,
        model: { connectionId: fixture.connectionId, modelId: 'model-b' },
        parameters: { topP: 0.6 },
      });
      await runtime.runAgent({ message: 'Resume first', sessionId: first.sessionId });
      await runtime.runAgent({ message: 'Resume second', sessionId: second.sessionId });

      expect(fixture.provider.requests.slice(-2).map((request) => request.model)).toEqual([
        'model-b',
        'model-a',
      ]);
      expect((await runtime.getAgentSession(first.sessionId))?.model).toMatchObject({
        modelId: 'model-b',
        parameters: { topP: 0.6 },
      });
      expect((await runtime.getAgentSession(second.sessionId))?.model).toMatchObject({
        modelId: 'model-a',
      });
    } finally {
      await runtime.close();
    }
  });

  it('requires a model only when creating a Session with no host selection', async () => {
    const fixture = await createFixture();
    const runtime = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
    });
    try {
      await expect(runtime.runAgent({ message: 'No selection' })).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    } finally {
      await runtime.close();
    }
  });

  it('rejects unsupported or oversized request parameters before creating a Run', async () => {
    const fixture = await createFixture();
    const runtime = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
      newSessionModel: { connectionId: fixture.connectionId, modelId: 'model-a' },
    });
    try {
      await expect(runtime.startAgentRun({
        message: 'Unsupported temperature request.',
        sessionId: 'unsupported-generation',
        clientRequestId: 'unsupported-generation',
        generation: { seed: 42 },
      })).rejects.toMatchObject({ code: 'LLM_PARAMETER_UNSUPPORTED' });
      await expect(runtime.startAgentRun({
        message: 'Oversized output request.',
        sessionId: 'oversized-generation',
        clientRequestId: 'oversized-generation',
        generation: { maxOutputTokens: 257 },
      })).rejects.toMatchObject({ code: 'LLM_PARAMETER_UNSUPPORTED' });
      expect(fixture.provider.requests).toHaveLength(0);
      expect((await runtime.getAgentSession('unsupported-generation'))?.runCount).toBe(0);
      expect((await runtime.getAgentSession('oversized-generation'))?.runCount).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('preserves a result materialization initialization failure during close', async () => {
    const fixture = await createFixture();
    const materializedRoot = join(
      fixture.projectDirectory,
      '.schemanaut',
      'runtime',
      'materialized',
    );
    await mkdir(join(fixture.projectDirectory, '.schemanaut', 'runtime'), { recursive: true });
    await writeFile(materializedRoot, 'not a directory', 'utf8');
    const runtime = new AgentRuntime({
      projectDirectory: fixture.projectDirectory,
      stateDatabasePath: fixture.stateDatabasePath,
      llmManager: fixture.manager,
      globalConfigStore: fixture.globalConfigStore,
    });

    try {
      let closeError: unknown;
      try {
        await runtime.close();
      } catch (error) {
        closeError = error;
      }
      expect(closeError).toBeInstanceOf(AggregateError);
      const failures = (closeError as AggregateError).errors;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        message: 'Runtime materialization directories cannot be symbolic links, junctions, or files.',
      });
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});

class SessionProvider implements LlmProvider {
  id = 'session-fixture';
  readonly name = 'Session fixture';
  readonly mode = 'private' as const;
  readonly protocol = 'openai-responses';
  readonly capabilities = {
    chat: 'supported' as const,
    toolCalling: 'supported' as const,
    streaming: 'supported' as const,
  };
  readonly generationParameters = {
    temperature: 'supported' as const,
    topP: 'supported' as const,
    maxOutputTokens: 'supported' as const,
    seed: 'unsupported' as const,
  };
  readonly requests: LlmChatRequest[] = [];

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ text: `Completed with ${request.model}.`, toolCalls: [] });
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(['model-a', 'model-b']);
  }

  getModelMetadata(model: string) {
    return Promise.resolve({
      model,
      source: 'provider-api' as const,
      contextTokens: 4_096,
      maxOutputTokens: 256,
      capabilities: { chat: 'supported' as const, toolCalling: 'supported' as const },
      generationParameters: this.generationParameters,
    });
  }

  isAvailable() {
    return Promise.resolve({ available: true });
  }
}

async function createFixture() {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-session-model-'));
  temporaryDirectories.push(projectDirectory);
  const provider = new SessionProvider();
  const plugin: LlmProviderPlugin = {
    manifest: {
      id: 'session-fixture',
      name: 'Session fixture',
      version: '1.0.0',
      protocol: 'openai-responses',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: ['model-a', 'model-b'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
  const trustedModelClientFactory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: {
      execute: (request) => {
        const wire = request.wireRequest as LlmChatRequest;
        provider.requests.push(structuredClone(wire));
        return Promise.resolve({
          kind: 'json' as const,
          response: {
            id: `response-${provider.requests.length}`,
            model: wire.model,
            status: 'completed',
            output: [{
              id: `message-${provider.requests.length}`,
              type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text: `Completed with ${wire.model}.` }],
            }],
          },
        });
      },
    },
    bindingEvidence: {
      connectionResolutionRevision: resolution.revision,
      connectionConfigurationRevision: connection.connectionConfigurationRevision,
      credentialRevision: connection.credentialRevision,
    },
  });
  const manager = new LlmConnectionManager({
    cacheDirectory: join(projectDirectory, '.cache'),
    plugins: [plugin],
    globalParameters: { temperature: 0.1 },
    trustedModelClientFactory,
  });
  const [connection] = manager.replaceConnections([{ endpoint: 'http://fixture.local/v1' }]);
  return {
    projectDirectory,
    stateDatabasePath: join(projectDirectory, '.schemanaut', 'sessions.db'),
    globalConfigStore: new GlobalConfigStore({ path: join(projectDirectory, '.schemanaut', 'config.toml') }),
    provider,
    manager,
    connectionId: connection!.id,
  };
}
