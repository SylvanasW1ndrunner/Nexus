import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCheckpointStore,
  AgentSessionStore,
  AgentSubagentPool,
  ReactAgent,
  ToolRegistry,
  createAgentSession,
  type AgentRunResult,
} from '@dbagent/core-agent';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { SkillRegistry } from '@dbagent/core-skills';
import { UsageTracker } from '@dbagent/core-usage';
import {
  registerSkillTools,
  registerSubagentTools,
  registerWebTools,
  type AgentWebAdapter,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('host-provided web tools', () => {
  it('forwards cancellation and bounds search snippets and fetched text', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter: AgentWebAdapter = {
      search(input) {
        calls.push({ type: 'search', ...input });
        return Promise.resolve([
          {
            title: 'PostgreSQL documentation',
            url: 'https://www.postgresql.org/docs/',
            snippet: 'x'.repeat(2_000),
          },
          {
            title: 'Ignored overflow result',
            url: 'https://example.com/overflow',
          },
        ]);
      },
      fetch(input) {
        calls.push({ type: 'fetch', ...input });
        return Promise.resolve({
          url: input.url,
          title: 'Reference',
          contentType: 'text/plain',
          text: 'abcdef',
        });
      },
    };
    const registry = new ToolRegistry();
    registerWebTools(registry, adapter);
    const controller = new AbortController();
    const context = {
      session: session(),
      signal: controller.signal,
    };

    const search = (await registry
      .get('web_search')!
      .handler({ query: 'PostgreSQL JSON operators', limit: 1 }, context)) as {
      results: Array<{ snippet?: string }>;
    };
    const fetched = (await registry
      .get('web_fetch')!
      .handler({ url: 'https://example.com/path', maxChars: 4 }, context)) as {
      text: string;
      truncated: boolean;
    };

    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.snippet).toHaveLength(1_000);
    expect(fetched).toMatchObject({ text: 'abcd', truncated: true });
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    await expect(
      registry.get('web_fetch')!.handler({ url: 'file:///etc/passwd' }, context),
    ).rejects.toThrow('only HTTP and HTTPS');
  });
});

describe('progressive Skill tools', () => {
  it('keeps discovery metadata-only, activates instructions, and bounds resources to the Skill', async () => {
    const root = await temporaryDirectory();
    const skillRoot = join(root, 'skills');
    const bundle = join(skillRoot, 'clean-events');
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, 'SKILL.md'),
      [
        '---',
        'name: clean-events',
        'description: Clean Kafka JSON event payloads.',
        'allowed-tools: sql_execute',
        '---',
        '',
        'Inspect JSON shape, then generate SQL that performs cleaning in the database.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(bundle, 'patterns.md'), 'Use jsonb_to_record for stable objects.', 'utf8');
    await writeFile(join(root, 'outside.md'), 'must not be read', 'utf8');
    const skills = new SkillRegistry({
      sources: [{ scope: 'project', path: skillRoot }],
    });
    await skills.refresh();
    const registry = new ToolRegistry();
    registerSkillTools(registry, skills);
    const context = { session: session() };

    const found = (await registry
      .get('skill_search')!
      .handler({ query: 'Kafka JSON cleaning' }, context)) as {
      skills: Array<Record<string, unknown>>;
    };
    expect(found.skills).toEqual([
      {
        name: 'clean-events',
        description: 'Clean Kafka JSON event payloads.',
        scope: 'project',
      },
    ]);
    expect(JSON.stringify(found)).not.toMatch(/sourcePath|bundleRoot|instructions|score|hash/i);

    await expect(
      registry
        .get('skill_resource_read')!
        .handler({ name: 'clean-events', path: 'patterns.md' }, context),
    ).rejects.toThrow('must be activated with skill_load');

    const loaded = (await registry
      .get('skill_load')!
      .handler({ name: 'clean-events' }, context)) as { instructions: string };
    expect(loaded.instructions).toContain('performs cleaning in the database');
    expect(context.session.activeSkills).toMatchObject([
      {
        name: 'clean-events',
        scope: 'project',
      },
    ]);

    await expect(
      registry
        .get('skill_resource_read')!
        .handler({ name: 'clean-events', path: 'patterns.md' }, context),
    ).resolves.toMatchObject({
      name: 'clean-events',
      content: 'Use jsonb_to_record for stable objects.',
    });
    await expect(
      registry
        .get('skill_resource_read')!
        .handler({ name: 'clean-events', path: '../../outside.md' }, context),
    ).rejects.toThrow();
  });
});

describe('subagent tools', () => {
  it('delegates one bounded task with an independent child Session and returns a concise projection', async () => {
    const childCalls: string[] = [];
    const childDepths: Array<number | undefined> = [];
    const pool = new AgentSubagentPool((options) => {
      childCalls.push(options.userMessage);
      childDepths.push(options.subagentDepth);
      return Promise.resolve(runResult(options.userMessage));
    });
    const registry = new ToolRegistry();
    registerSubagentTools(registry, {
      pool,
      buildRunOptions: (task) => ({
        providerId: 'test-provider',
        model: 'test-model',
        userMessage: task,
        mode: 'read',
      }),
    });
    const context = { session: session() };

    const spawned = (await registry
      .get('subagent_spawn')!
      .handler({ task: 'Inspect the traffic event schema' }, context)) as {
      id: string;
      status: string;
    };
    const completed = (await registry
      .get('subagent_wait')!
      .handler({ id: spawned.id, timeoutMs: 2_000 }, context)) as Record<string, unknown>;
    const listed = (await registry.get('subagent_list')!.handler({}, context)) as {
      subagents: Array<Record<string, unknown>>;
    };

    expect(spawned.status).toBe('running');
    expect(completed).toMatchObject({
      task: 'Inspect the traffic event schema',
      status: 'completed',
      summary: 'child: Inspect the traffic event schema',
    });
    expect(listed.subagents).toHaveLength(1);
    expect(childCalls).toEqual(['Inspect the traffic event schema']);
    expect(childDepths).toEqual([1]);
    expect(JSON.stringify(completed)).not.toMatch(
      /parentSessionId|childSessionId|providerId|model/i,
    );
    const foreignContext = { session: session() };
    foreignContext.session.id = 'session-foreign';
    await expect(
      registry.get('subagent_wait')!.handler({ id: spawned.id, timeoutMs: 10 }, foreignContext),
    ).rejects.toThrow('current Session');
    expect(() =>
      registry.get('subagent_stop')!.handler({ id: spawned.id }, foreignContext),
    ).toThrow('current Session');

    const nestedContext = { session: session() };
    nestedContext.session.subagentDepth = 1;
    await expect(
      registry
        .get('subagent_spawn')!
        .handler({ task: 'Spawn an unnecessary grandchild' }, nestedContext),
    ).rejects.toThrow('depth limit');
  });

  it('keeps a child UUID intact across spawn, model wait, and persistence', async () => {
    const root = await temporaryDirectory();
    const runtimeId = '7fb43a7c-9ba1-4ac5-8f27-2de83079448f';
    const spawnToolCallId = '6fd9cd80-4371-47a0-9df0-c550381e9f9c';
    const waitToolCallId = 'b3904b71-4d12-4194-90bc-dcd8e3d743be';
    const parentSessionId = 'session-parent';
    const hiddenChildSessionId = 'session-child-internal';
    const requests: LlmChatRequest[] = [];
    let waitedWith: string | undefined;
    const provider: LlmProvider = {
      id: 'subagent-chain',
      name: 'Subagent chain',
      mode: 'byok',
      chat(request): Promise<LlmChatResponse> {
        requests.push(structuredClone(request));
        const latest = request.messages.at(-1);
        if (requests.length === 1) {
          return Promise.resolve({
            text: '',
            toolCalls: [
              {
                id: spawnToolCallId,
                name: 'subagent_spawn',
                arguments: { task: 'Inspect one isolated schema concern.' },
              },
            ],
          });
        }
        if (latest?.role === 'tool' && latest.name === 'subagent_spawn') {
          const spawned = JSON.parse(latest.content) as { id: string };
          waitedWith = spawned.id;
          return Promise.resolve({
            text: '',
            toolCalls: [
              {
                id: waitToolCallId,
                name: 'subagent_wait',
                arguments: { id: spawned.id, timeoutMs: 2_000 },
              },
            ],
          });
        }
        if (latest?.role === 'tool' && latest.name === 'subagent_wait') {
          return Promise.resolve({
            text: 'The isolated child task completed.',
            toolCalls: [],
          });
        }
        throw new Error('Unexpected subagent chain state.');
      },
      isAvailable: () => Promise.resolve({ available: true }),
    };
    const pool = new AgentSubagentPool(
      (options) =>
        Promise.resolve({
          ...runResult(options.userMessage),
          session: createAgentSession({
            id: hiddenChildSessionId,
            title: 'Hidden child',
            mode: 'read',
            now: () => '2026-07-25T00:00:00.000Z',
          }),
        }),
      {
        createId: () => runtimeId,
        now: () => '2026-07-25T00:00:00.000Z',
      },
    );
    const registry = new ToolRegistry();
    registerSubagentTools(registry, {
      pool,
      buildRunOptions: (task) => ({
        providerId: provider.id,
        model: 'test-model',
        userMessage: task,
        mode: 'read',
      }),
    });
    const sessionStore = new AgentSessionStore(join(root, 'sessions.db'));
    const checkpointStore = new AgentCheckpointStore(join(root, 'checkpoints.json'));
    const usage = new UsageTracker();
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registry,
      usage,
      undefined,
      {
        createSessionId: () => parentSessionId,
        now: () => '2026-07-25T00:00:00.000Z',
        sessionStore,
        checkpointStore,
      },
    );

    const result = await agent.run({
      providerId: provider.id,
      model: 'test-model',
      userMessage: 'Delegate one isolated inspection and wait for it.',
      mode: 'read',
      maxIterations: 3,
    });

    expect(result.status).toBe('done');
    expect(waitedWith).toBe(runtimeId);
    expect(result.toolExecutions).toMatchObject([
      {
        toolName: 'subagent_spawn',
        status: 'success',
      },
      {
        toolName: 'subagent_wait',
        status: 'success',
      },
    ]);
    expect(result.toolExecutions[0]?.resultPreview).toContain(runtimeId);
    expect(result.toolExecutions[1]?.argumentPreview).toContain(runtimeId);
    expect(result.toolExecutions[1]?.resultPreview).toContain(runtimeId);
    const parentMessages = JSON.stringify(result.session.messages);
    expect(parentMessages).toContain(runtimeId);
    expect(parentMessages).toContain(spawnToolCallId);
    expect(parentMessages).toContain(waitToolCallId);
    expect(parentMessages).not.toContain(hiddenChildSessionId);
    expect(parentMessages).not.toContain('parentSessionId');
    expect(parentMessages).not.toContain('childSessionId');
    expect(JSON.stringify(requests[1]?.messages)).toContain(runtimeId);
    expect(JSON.stringify(requests[2]?.messages)).toContain(runtimeId);
    const persistedAssistantCalls = result.session.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.toolCalls ?? []);
    const persistedToolCallIds = result.session.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId);
    expect(persistedAssistantCalls.map((call) => call.id)).toEqual([
      spawnToolCallId,
      waitToolCallId,
    ]);
    expect(persistedToolCallIds).toEqual([spawnToolCallId, waitToolCallId]);
    expect(JSON.stringify(result.events)).not.toContain(runtimeId);

    const persisted = await sessionStore.load(parentSessionId);
    expect(persisted?.messages.slice(0, 5)).toEqual(result.session.messages.slice(0, 5));
    expect(persisted?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The isolated child task completed.',
    });
    expect(JSON.stringify(persisted)).toContain(runtimeId);
    expect(JSON.stringify(persisted)).not.toContain(hiddenChildSessionId);
    const checkpoints = await checkpointStore.listBySession(parentSessionId);
    expect(JSON.stringify(checkpoints)).toContain(runtimeId);
    expect(JSON.stringify(checkpoints)).not.toContain(hiddenChildSessionId);

    const foreignContext = { session: session() };
    foreignContext.session.id = 'session-foreign';
    await expect(
      registry
        .get('subagent_wait')!
        .handler({ id: runtimeId, timeoutMs: 10 }, foreignContext),
    ).rejects.toThrow('current Session');
  });
});

function session() {
  return createAgentSession({
    id: 'session-extensions',
    title: 'Extensions',
    mode: 'read',
    now: () => '2026-07-25T00:00:00.000Z',
  });
}

function runResult(task: string): AgentRunResult {
  return {
    runId: 'run-extension-child',
    status: 'done',
    session: createAgentSession({
      id: 'child-session',
      title: 'Child',
      mode: 'read',
      now: () => '2026-07-25T00:00:00.000Z',
    }),
    finalText: `child: ${task}`,
    iterations: 1,
    toolExecutions: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-extensions-'));
  temporaryDirectories.push(directory);
  return directory;
}
