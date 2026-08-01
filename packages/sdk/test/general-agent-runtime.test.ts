import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('general Agent runtime composition', () => {
  it('runs a project task without requiring a database connection or Schema index', async () => {
    const projectDirectory = await temporaryProject();
    await writeFile(
      join(projectDirectory, 'AGENTS.md'),
      'Project rule: verify TypeScript changes with the package test command.\n',
      'utf8',
    );
    await writeFile(join(projectDirectory, 'package.json'), '{"packageManager":"pnpm@10"}\n', 'utf8');
    await writeFile(join(projectDirectory, 'index.ts'), 'export const ready = true;\n', 'utf8');
    const provider = new CapturingProvider('The project context is ready.');
    const runtime = new DatabaseAgentRuntime({
      projectDirectory,
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
      systemPrompt: { mode: 'append', content: 'Prefer compact engineering answers.' },
      capabilityInstructions: ['Use project tools for code and file tasks.'],
    });

    try {
      const run = await runtime.runAgent({ message: 'Inspect this project.' });

      expect(run.result.status).toBe('done');
      expect(run.queryResults).toEqual([]);
      const systemContext = provider.requests[0]?.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(systemContext).toContain('Project rule: verify TypeScript changes');
      expect(systemContext).toContain('typescript');
      expect(systemContext).toContain('Prefer compact engineering answers.');
      expect(systemContext).toContain('Use project tools for code and file tasks.');
      expect(systemContext).not.toMatch(/catalogRootHash|fingerprint|API_KEY/);
      expect(systemContext).not.toContain('query-and-answer');
      expect(
        run.result.events?.find((event) => event.type === 'goal-understood')?.message,
      ).toBe('已理解本次请求，正在结合当前项目与可用能力处理。');
    } finally {
      await runtime.close();
    }
  });

  it('registers the shared process runtime only when host process tools are enabled', async () => {
    const projectDirectory = await temporaryProject();
    const provider = new CapturingProvider('Ready.');
    const disabled = new DatabaseAgentRuntime({
      projectDirectory,
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
    });
    expect(disabled.tools.has('process_exec')).toBe(false);
    await disabled.close();

    const enabled = new DatabaseAgentRuntime({
      projectDirectory,
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
      enableProcessTools: true,
    });
    try {
      expect(enabled.tools.has('process_exec')).toBe(true);
      expect(enabled.tools.has('process_poll')).toBe(true);
      expect(enabled.tools.has('process_write')).toBe(true);
      expect(enabled.tools.has('process_terminate')).toBe(true);
    } finally {
      await enabled.close();
    }
  });

  it('applies run-scoped system instructions and tool exposure without replacing runtime protocol', async () => {
    const projectDirectory = await temporaryProject();
    const provider = new CapturingProvider('Custom run complete.');
    const runtime = new DatabaseAgentRuntime({
      projectDirectory,
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
    });

    try {
      await runtime.runAgent({
        message: 'Perform a focused task.',
        systemPrompt: { mode: 'replace', content: 'You are a data platform maintainer.' },
        allowedTools: ['workspace_read'],
        pinnedTools: ['workspace_read'],
      });

      const request = provider.requests[0];
      expect(request?.tools?.map((tool) => tool.name)).toEqual(['workspace_read']);
      const systemContext = request?.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(systemContext).toContain('You are a data platform maintainer.');
      expect(systemContext).toContain('Use the provider tool-calling protocol');
      expect(systemContext).not.toContain('You are SchemaNaut, a general-purpose agent');
    } finally {
      await runtime.close();
    }
  });

  it('propagates a parent run tool allowlist into delegated child Agents', async () => {
    const projectDirectory = await temporaryProject();
    const provider = new DelegationBoundaryProvider();
    const runtime = new DatabaseAgentRuntime({
      projectDirectory,
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
      dynamicToolDiscovery: false,
    });

    try {
      const run = await runtime.runAgent({
        message: 'Delegate one bounded check.',
        allowedTools: ['subagent_spawn', 'subagent_wait'],
      });

      expect(run.result.status).toBe('done');
      expect(provider.childRequests).toHaveLength(1);
      expect(provider.childRequests[0]?.tools?.map((tool) => tool.name)).toEqual([
        'subagent_spawn',
        'subagent_wait',
      ]);
      expect(provider.childRequests[0]?.tools?.map((tool) => tool.name)).not.toContain(
        'workspace_read',
      );
    } finally {
      await runtime.close();
    }
  });
});

class CapturingProvider implements LlmProvider {
  readonly id = 'capturing';
  readonly name = 'Capturing Provider';
  readonly mode = 'byok' as const;
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly responseText: string) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      text: this.responseText,
      toolCalls: [],
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class DelegationBoundaryProvider implements LlmProvider {
  readonly id = 'delegation-boundary';
  readonly name = 'Delegation Boundary Provider';
  readonly mode = 'byok' as const;
  readonly childRequests: LlmChatRequest[] = [];
  private sequence = 0;

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const latest = request.messages.at(-1);
    if (latest?.role === 'user' && latest.content === 'Delegate one bounded check.') {
      return Promise.resolve(this.toolCall('spawn', 'subagent_spawn', {
        task: 'Inspect only the delegated scope.',
      }));
    }
    if (latest?.role === 'user' && latest.content === 'Inspect only the delegated scope.') {
      this.childRequests.push(structuredClone(request));
      return Promise.resolve({ text: 'The delegated scope is valid.', toolCalls: [] });
    }
    if (latest?.role === 'tool' && latest.toolCallId?.startsWith('spawn-')) {
      const result = JSON.parse(latest.content) as { id: string };
      return Promise.resolve(
        this.toolCall('wait', 'subagent_wait', { id: result.id, timeoutMs: 5_000 }),
      );
    }
    if (latest?.role === 'tool' && latest.toolCallId?.startsWith('wait-')) {
      return Promise.resolve({ text: 'Delegated check completed.', toolCalls: [] });
    }
    throw new Error(`Unexpected delegation request: ${latest?.role ?? 'none'}.`);
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }

  private toolCall(
    prefix: string,
    name: string,
    args: Record<string, unknown>,
  ): LlmChatResponse {
    this.sequence += 1;
    return {
      text: '',
      toolCalls: [{ id: `${prefix}-${this.sequence}`, name, arguments: args }],
    };
  }
}

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-general-runtime-'));
  temporaryDirectories.push(path);
  return path;
}
