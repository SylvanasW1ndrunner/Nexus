import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
  LlmProviderPlugin,
  LlmTrustedModelClientFactory,
  ModelClientResponse,
} from '@dbagent/core-llm';
import {
  LlmConnectionManager,
  ModelClientError,
  deriveLlmConnectionId,
} from '@dbagent/core-llm';
import {
  SqliteAgentJournal,
  agentProjectStorageIdentity,
  agentProjectReference,
  createAgentProjectContext,
} from '@dbagent/core-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { type AgentRuntimeOptions } from '../src/types.js';
import { testLlmRuntimeOptions } from './llm-test-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe('durable role prompt configuration', () => {
  it('compiles append and replace role prompts without replacing the runtime protocol', async () => {
    const projectDirectory = await temporaryProject();
    const provider = new PromptProvider();
    const runtime = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: join(projectDirectory, '.schemanaut', 'state.db'),
      ...testLlmRuntimeOptions(provider),
      systemPrompt: { mode: 'append', content: 'RUNTIME_ROLE' },
    });

    try {
      const append = await runtime.startAgentRun({
        message: 'append',
        sessionId: 'append-role-prompt',
        clientRequestId: 'append-role-prompt',
        systemPrompt: { mode: 'append', content: 'RUN_APPEND' },
      });
      await append.result();
      const replace = await runtime.startAgentRun({
        message: 'replace',
        sessionId: 'replace-role-prompt',
        clientRequestId: 'replace-role-prompt',
        systemPrompt: { mode: 'replace', content: 'RUN_REPLACE' },
      });
      await replace.result();

      expect(systemText(provider.requests[0]!)).toContain('RUNTIME_ROLE');
      expect(systemText(provider.requests[0]!)).toContain('RUN_APPEND');
      expect(systemText(provider.requests[0]!)).toContain('Use the captured capabilities and tools');
      expect(systemText(provider.requests[0]!)).toContain('Do not finish while a requested action or verification is still pending');
      expect(systemText(provider.requests[1]!)).not.toContain('RUNTIME_ROLE');
      expect(systemText(provider.requests[1]!)).toContain('RUN_REPLACE');
      expect(systemText(provider.requests[1]!)).toContain('Use the captured capabilities and tools');
      expect(systemText(provider.requests[1]!)).toContain('Never use the final answer to announce work you intend to do next');
      const journal = new SqliteAgentJournal({
        filePath: join(projectDirectory, '.schemanaut', 'state.db'),
      });
      const projectId = agentProjectStorageIdentity(
        agentProjectReference(createAgentProjectContext(projectDirectory)),
      ).projectKey;
      await expect(journal.getRunIngressConfiguration({
        projectId, sessionId: append.sessionId, runId: append.runId,
      })).resolves.toMatchObject({
        rolePrompt: {
          default: { mode: 'append', content: 'RUNTIME_ROLE' },
          run: { mode: 'append', content: 'RUN_APPEND' },
        },
      });
      await expect(journal.getRunIngressConfiguration({
        projectId, sessionId: replace.sessionId, runId: replace.runId,
      })).resolves.toMatchObject({
        rolePrompt: {
          default: { mode: 'append', content: 'RUNTIME_ROLE' },
          run: { mode: 'replace', content: 'RUN_REPLACE' },
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it.skip('persists prompt layers through restart, open, and explicit resume', async () => {
    const projectDirectory = await temporaryProject();
    const databasePath = join(projectDirectory, '.schemanaut', 'state.db');
    const globalConfigStore = new GlobalConfigStore({
      path: join(projectDirectory, '.schemanaut', 'config.toml'),
    });
    const requests: Record<string, unknown>[] = [];
    const llmRuntime = interruptedThenRecoveredModel(requests, projectDirectory);
    const first = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: databasePath,
      globalConfigStore,
      ...llmRuntime,
      systemPrompt: { mode: 'append', content: 'PERSISTED_RUNTIME_ROLE' },
    });
    const handle = await first.startAgentRun({
      message: 'resume this durable run',
      sessionId: 'durable-role-prompt',
      clientRequestId: 'durable-role-prompt',
      systemPrompt: { mode: 'append', content: 'PERSISTED_RUN_ROLE' },
    });
    await expect(handle.result()).resolves.toMatchObject({ status: 'interrupted' });
    expect(wireSystemText(requests[0]!)).toContain('PERSISTED_RUNTIME_ROLE');
    expect(wireSystemText(requests[0]!)).toContain('PERSISTED_RUN_ROLE');
    await first.close();

    const restarted = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: databasePath,
      ...llmRuntime,
      globalConfigStore,
      systemPrompt: { mode: 'append', content: 'CHANGED_RUNTIME_ROLE' },
    });
    try {
      await restarted.ready();
      const reopened = await restarted.openAgentRun(handle.runId);
      await expect(reopened.result()).resolves.toMatchObject({ status: 'interrupted' });
      await reopened.resume();
      await expect(reopened.result()).resolves.toMatchObject({ status: 'completed' });
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      const resumed = wireSystemText(requests[2]!);
      expect(resumed).toContain('PERSISTED_RUNTIME_ROLE');
      expect(resumed).toContain('PERSISTED_RUN_ROLE');
      expect(resumed).not.toContain('CHANGED_RUNTIME_ROLE');
      expect(resumed).toContain('Use the captured capabilities and tools');
    } finally {
      await restarted.close();
    }
  });

  it('keeps default/no-prompt behavior and role prompts isolated by Run', async () => {
    const projectDirectory = await temporaryProject();
    const provider = new PromptProvider();
    const runtime = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: join(projectDirectory, '.schemanaut', 'isolation.db'),
      ...testLlmRuntimeOptions(provider),
    });
    try {
      await runtime.runAgent({
        message: 'no role prompt', sessionId: 'no-role-prompt', clientRequestId: 'no-role-prompt',
      });
      await runtime.runAgent({
        message: 'first role prompt', sessionId: 'role-a', clientRequestId: 'role-a',
        systemPrompt: { mode: 'append', content: 'ROLE_A_ONLY' },
      });
      await runtime.runAgent({
        message: 'second role prompt', sessionId: 'role-b', clientRequestId: 'role-b',
        systemPrompt: { mode: 'replace', content: 'ROLE_B_ONLY' },
      });

      expect(systemText(provider.requests[0]!)).not.toContain('ROLE_');
      expect(systemText(provider.requests[1]!)).toContain('ROLE_A_ONLY');
      expect(systemText(provider.requests[1]!)).not.toContain('ROLE_B_ONLY');
      expect(systemText(provider.requests[2]!)).toContain('ROLE_B_ONLY');
      expect(systemText(provider.requests[2]!)).not.toContain('ROLE_A_ONLY');
    } finally {
      await runtime.close();
    }
  });

  it('reopens a legacy Run without ingress configuration without applying a new Runtime role prompt', async () => {
    const projectDirectory = await temporaryProject();
    const databasePath = join(projectDirectory, '.schemanaut', 'legacy-empty-ingress.db');
    const globalConfigStore = new GlobalConfigStore({
      path: join(projectDirectory, '.schemanaut', 'config.toml'),
    });
    const provider = new PromptProvider();
    const llmRuntime = testLlmRuntimeOptions(provider);
    const first = new AgentRuntime({
      projectDirectory, stateDatabasePath: databasePath, ...llmRuntime, globalConfigStore,
    });
    const template = await first.startAgentRun({
      message: 'create a model-bound legacy session',
      sessionId: 'legacy-empty-ingress',
      clientRequestId: 'legacy-empty-ingress-template',
    });
    await template.result();
    const projectId = agentProjectStorageIdentity(
      agentProjectReference(createAgentProjectContext(projectDirectory)),
    ).projectKey;
    const journal = new SqliteAgentJournal({ filePath: databasePath });
    const environment = await journal.getEnvironmentBinding({
      projectId, sessionId: template.sessionId, runId: template.runId,
    });
    if (environment === null) throw new Error('Template Run has no Environment binding.');
    const legacy = await journal.createRun({
      projectId,
      sessionId: template.sessionId,
      clientRequestId: 'legacy-empty-ingress-run',
      input: 'resume a pre-configuration legacy run',
      environment: {
        ...environment.payload,
        environmentBindingId: 'environment_legacy_empty_ingress',
      },
    });
    expect(await journal.getRunIngressConfiguration({
      projectId, sessionId: template.sessionId, runId: legacy.runId,
    })).toBeNull();
    await first.close();

    const restarted = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: databasePath,
      ...llmRuntime,
      globalConfigStore,
      systemPrompt: { mode: 'append', content: 'MUST_NOT_LEAK_TO_LEGACY_RUN' },
    });
    try {
      await restarted.ready();
      const opened = await restarted.openAgentRun(legacy.runId);
      await expect(opened.result()).resolves.toMatchObject({ status: 'completed' });
      expect(provider.requests).toHaveLength(2);
      expect(systemText(provider.requests[1]!)).not.toContain('MUST_NOT_LEAK_TO_LEGACY_RUN');
      expect(systemText(provider.requests[1]!)).toContain('Use the captured capabilities and tools');
    } finally {
      await restarted.close();
    }
  });
});

class PromptProvider implements LlmProvider {
  readonly id = 'prompt-provider';
  readonly name = 'Prompt Provider';
  readonly mode = 'byok' as const;
  readonly requests: LlmChatRequest[] = [];

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ text: 'done', toolCalls: [] });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

function systemText(request: LlmChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

function interruptedThenRecoveredModel(
  requests: Record<string, unknown>[],
  projectDirectory: string,
): Pick<AgentRuntimeOptions, 'llmManager' | 'newSessionModel'> {
  const modelId = 'durable-role-prompt-model';
  const endpoint = 'https://durable-role-prompt.invalid/v1';
  let attempts = 0;
  const provider: LlmProvider = {
    id: 'durable-role-prompt-provider', name: 'Durable role prompt provider', mode: 'byok',
    chat: () => Promise.resolve({ text: 'unused', toolCalls: [] }),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  const plugin: LlmProviderPlugin = {
    manifest: {
      id: 'durable-role-prompt-plugin', name: 'Durable role prompt plugin', version: '1',
      protocol: 'openai-chat', priority: 10_000,
    },
    match: () => ({ score: 10_000, evidence: [] }),
    discover: () => Promise.resolve({ score: 10_000, models: [modelId], evidence: [] }),
    createProvider: ({ resolution }) => ({ ...provider, id: resolution.providerId }),
  };
  const factory: LlmTrustedModelClientFactory = ({ connection, resolution }) => ({
    client: {
      execute: (request): Promise<ModelClientResponse> => {
        requests.push(structuredClone(request.wireRequest) as Record<string, unknown>);
        if (attempts++ < 2) {
          return Promise.reject(new ModelClientError(
            'STREAM_DISCONNECTED', 'planned retryable interruption', { retryable: true },
          ));
        }
        return Promise.resolve({
          kind: 'json',
          response: {
            id: 'durable-role-prompt-recovered', model: modelId,
            choices: [{
              index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop',
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
    cacheDirectory: join(projectDirectory, '.cache'), plugins: [plugin], trustedModelClientFactory: factory,
  });
  const [connection] = manager.replaceConnections([{
    name: 'Durable role prompt endpoint', endpoint, apiKey: 'fixture',
    connectionConfigurationRevision: 'config-v1', credentialRevision: 'credential-v1',
  }]);
  if (connection === undefined) throw new Error('Missing durable role prompt connection.');
  return {
    llmManager: manager,
    newSessionModel: { connectionId: deriveLlmConnectionId({ name: 'Durable role prompt endpoint', endpoint }), modelId },
  };
}

function wireSystemText(request: Record<string, unknown>): string {
  const messages = (request.messages ?? []) as Array<{ role?: unknown; content?: unknown }>;
  return messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => wireContentText(message.content))
    .join('\n');
}

function wireContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-role-prompt-'));
  temporaryDirectories.push(directory);
  return directory;
}
