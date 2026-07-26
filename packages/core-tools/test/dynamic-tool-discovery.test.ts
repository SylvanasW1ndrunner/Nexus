import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactAgent, ToolRegistry } from '@dbagent/core-agent';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import { registerAgentRuntimeTools, registerWorkspaceTools } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('dynamic tool discovery pipeline', () => {
  it('keeps optional schemas out of the prompt and requires discovery before execution', async () => {
    const project = await temporaryDirectory();
    const usage = new UsageTracker(join(project, 'usage.json'));
    const registry = new ToolRegistry();
    registerAgentRuntimeTools(registry);
    registerWorkspaceTools(registry, { rootPath: project });
    const requests: LlmChatRequest[] = [];
    const responses: LlmChatResponse[] = [
      toolCall('guess', 'workspace_write', {
        path: 'sql/report.sql',
        content: 'SELECT 1;\n',
      }),
      toolCall('discover', 'tool_search', {
        query: 'write a project file',
      }),
      toolCall('write', 'workspace_write', {
        path: 'sql/report.sql',
        content: 'SELECT 1;\n',
      }),
      { text: 'SQL 脚本已保存。', toolCalls: [] },
    ];
    const provider: LlmProvider = {
      id: 'scripted',
      name: 'scripted',
      mode: 'byok',
      chat(request) {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error('No scripted response remains.');
        return Promise.resolve(response);
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const agent = new ReactAgent(new LlmRouter(usage, [provider]), registry, usage, undefined, {
      now: () => '2026-07-25T00:00:00.000Z',
      createSessionId: () => 'dynamic-tools-session',
    });

    const result = await agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: '保存一份查询脚本。',
      mode: 'edit',
      dynamicToolDiscovery: true,
    });

    expect(toolNames(requests[0])).toContain('tool_search');
    expect(toolNames(requests[0])).not.toContain('workspace_write');
    expect(result.toolExecutions[0]).toMatchObject({
      toolName: 'workspace_write',
      status: 'failed',
      failureKind: 'tool_unavailable',
    });
    expect(result.toolExecutions[1]).toMatchObject({
      toolName: 'tool_search',
      status: 'success',
    });
    expect(toolNames(requests[2])).toContain('workspace_write');
    expect(result.toolExecutions[2]).toMatchObject({
      toolName: 'workspace_write',
      status: 'success',
    });
    await expect(readFile(join(project, 'sql', 'report.sql'), 'utf8')).resolves.toBe('SELECT 1;\n');
  });

  it('propagates allowedTools into discovery and never reveals excluded tools', async () => {
    const project = await temporaryDirectory();
    const usage = new UsageTracker(join(project, 'usage.json'));
    const registry = new ToolRegistry();
    registerAgentRuntimeTools(registry);
    registerWorkspaceTools(registry, { rootPath: project });
    const responses: LlmChatResponse[] = [
      toolCall('discover', 'tool_search', {
        query: 'read write project file',
      }),
      { text: 'Discovery complete.', toolCalls: [] },
    ];
    const provider: LlmProvider = {
      id: 'scripted',
      name: 'scripted',
      mode: 'byok',
      chat() {
        const response = responses.shift();
        if (!response) throw new Error('No scripted response remains.');
        return Promise.resolve(response);
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const agent = new ReactAgent(new LlmRouter(usage, [provider]), registry, usage, undefined, {
      now: () => '2026-07-25T00:00:00.000Z',
      createSessionId: () => 'allowed-tools-session',
    });

    const result = await agent.run({
      providerId: 'scripted',
      model: 'test',
      userMessage: 'Discover an allowed project file tool.',
      mode: 'read',
      dynamicToolDiscovery: true,
      allowedTools: ['tool_search', 'tool_describe', 'workspace_read'],
    });

    expect(result.toolExecutions[0]?.resultPreview).toContain('workspace_read');
    expect(result.toolExecutions[0]?.resultPreview).not.toContain('workspace_write');
    expect(result.session.activeTools).toEqual(['workspace_read']);
  });
});

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
  };
}

function toolNames(request: LlmChatRequest | undefined): string[] {
  return request?.tools?.map((tool) => tool.name) ?? [];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-dynamic-tools-'));
  temporaryDirectories.push(directory);
  return directory;
}
