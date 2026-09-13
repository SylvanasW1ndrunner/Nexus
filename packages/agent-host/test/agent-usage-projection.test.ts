import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTracker } from '@dbagent/core-usage';
import { AgentRuntime } from '../src/agent-runtime.js';
import { testLlmRuntimeOptions } from './llm-test-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('AgentRuntime usage projection', () => {
  it('projects durable Agent facts once across Runtime readers and releases on close', async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), 'host-agent-usage-'));
    directories.push(projectDirectory);
    const databasePath = join(projectDirectory, '.schemanaut', 'agent.db');
    const usage = new UsageTracker();
    const recordTokens = vi.spyOn(usage, 'recordTokens');
    const provider = new FinalUsageProvider();
    const models = testLlmRuntimeOptions(provider);
    const first = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: databasePath,
      usageTracker: usage,
      ...models,
    });
    let restarted: AgentRuntime | undefined;
    let concurrent: AgentRuntime | undefined;
    try {
      const handle = await first.startAgentRun({
        message: 'Answer from durable usage facts.',
        sessionId: 'usage-session',
        clientRequestId: 'usage-run',
      });
      await handle.result();
      await expect(usage.current('byok')).resolves.toMatchObject({
        promptTokens: 8,
        completionTokens: 4,
        totalTokens: 12,
      });
      expect(recordTokens).not.toHaveBeenCalled();

      await first.close();
      await expect(usage.current('byok')).resolves.toMatchObject({ totalTokens: 0 });

      // A restarted Runtime reconstructs its absolute source from Journal facts.
      restarted = new AgentRuntime({
        projectDirectory,
        stateDatabasePath: databasePath,
        usageTracker: usage,
        ...models,
      });
      await expect(usage.current('byok')).resolves.toMatchObject({ totalTokens: 12 });

      concurrent = new AgentRuntime({
        projectDirectory,
        stateDatabasePath: databasePath,
        usageTracker: usage,
        ...models,
      });

      // The concurrent Runtime attaches a second reader to the same absolute source,
      // not a second delta contribution.
      await expect(usage.currentAll()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: 'byok', totalTokens: 12 }),
      ]));
      await restarted.close();
      await expect(usage.current('byok')).resolves.toMatchObject({ totalTokens: 12 });
    } finally {
      await first.close();
      await restarted?.close();
      await concurrent?.close();
    }
    await expect(usage.current('byok')).resolves.toMatchObject({ totalTokens: 0 });
  });
});

class FinalUsageProvider implements LlmProvider {
  readonly id = 'agent-usage';
  readonly name = 'Agent usage fixture';
  readonly mode = 'byok' as const;

  chat(_request: LlmChatRequest): Promise<LlmChatResponse> {
    void _request;
    return Promise.resolve({
      text: 'Durable projection answer.',
      toolCalls: [],
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}
