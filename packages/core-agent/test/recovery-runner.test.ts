import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
} from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import {
  AgentCheckpointStore,
  AgentRecoveryService,
  ReactAgent,
  ToolRegistry,
  type AgentRecoveryRunner,
  type AgentRunOptions,
  type AgentSession,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Agent recovery continuation runner', () => {
  it('continues a running checkpoint through ReactAgent and stops prompting after success', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const recovery = new AgentRecoveryService(checkpointStore);
    const session = interruptedSession('session_resume_success');
    await checkpointStore.save({
      session,
      iteration: 2,
      status: 'running',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 18,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
      ],
      now: '2026-06-24T10:03:00.000Z',
    });
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'Recovery completed from the saved order-count result.',
        toolCalls: [],
        usage: { promptTokens: 15, completionTokens: 9, totalTokens: 24 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const continued = await recovery.continue('session_resume_success', agent, {
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 1,
      now: '2026-06-24T10:05:00.000Z',
    });

    expect(continued.result.status).toBe('done');
    expect(continued.result.finalText).toBe(
      'Recovery completed from the saved order-count result.',
    );
    expect(continued.abandonedCheckpointCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.map((message) => message.content)).toEqual([
      'Analyze the weekly GMV drop.',
      'I already queried order volume and will continue with refund analysis.',
      '{"rows":[{"order_count":42}]}',
      continued.plan.resumePrompt,
    ]);
    await expect(recovery.listRecoverablePlans()).resolves.toEqual([]);
    await expect(checkpointStore.listBySession('session_resume_success')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ iteration: 2, status: 'abandoned' }),
        expect.objectContaining({ iteration: 3, status: 'done' }),
      ]),
    );
  });

  it('keeps the old running checkpoint recoverable when continuation execution fails', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const recovery = new AgentRecoveryService(checkpointStore);
    const session = interruptedSession('session_resume_failure');
    await checkpointStore.save({
      session,
      iteration: 3,
      status: 'running',
      toolExecutions: [
        {
          toolCallId: 'call_refunds',
          toolName: 'query_database',
          status: 'failed',
          durationMs: 12,
          resultPreview: 'database connection reset',
        },
      ],
      now: '2026-06-24T10:04:00.000Z',
    });
    const [plan] = await recovery.listRecoverablePlans();
    let capturedOptions: AgentRunOptions | undefined;
    const failingRunner: AgentRecoveryRunner = {
      run(options) {
        capturedOptions = options;
        return Promise.reject(new Error('provider failed during recovery continuation'));
      },
    };

    await expect(
      recovery.continue('session_resume_failure', failingRunner, {
        providerId: 'fake',
        model: 'fake-model',
        maxIterations: 1,
      }),
    ).rejects.toThrow('provider failed during recovery continuation');

    expect(capturedOptions?.providerId).toBe('fake');
    expect(capturedOptions?.model).toBe('fake-model');
    expect(capturedOptions?.maxIterations).toBe(1);
    expect(capturedOptions?.userMessage).toBe(plan?.resumePrompt);
    expect(capturedOptions?.initialSession?.id).toBe('session_resume_failure');
    expect(capturedOptions?.initialIteration).toBe(3);
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      { sessionId: 'session_resume_failure', interruptedIteration: 3 },
    ]);
    await expect(checkpointStore.listBySession('session_resume_failure')).resolves.toMatchObject([
      { iteration: 3, status: 'running' },
    ]);
  });

  it('keeps the original checkpoint recoverable when ReactAgent returns a failed continuation status', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const recovery = new AgentRecoveryService(checkpointStore);
    const session = interruptedSession('session_resume_tool_failed');
    await checkpointStore.save({
      session,
      iteration: 3,
      status: 'running',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 18,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
      ],
      now: '2026-06-24T10:04:00.000Z',
    });
    const failingRegistry = new ToolRegistry();
    failingRegistry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => {
        throw new Error('database connection reset during recovery');
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProviderWithCalls([
          {
            text: '',
            toolCalls: [
              {
                id: 'call_retry',
                name: 'query_database',
                arguments: { sql: 'select count(*) from refunds' },
              },
            ],
          },
        ]).provider,
      ]),
      failingRegistry,
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const continued = await recovery.continue('session_resume_tool_failed', agent, {
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 3,
      maxConsecutiveToolFailures: 1,
      now: '2026-06-24T10:06:00.000Z',
    });

    expect(continued.result.status).toBe('tool_failed');
    expect(continued.abandonedCheckpointCount).toBe(0);
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      { sessionId: 'session_resume_tool_failed', interruptedIteration: 3 },
    ]);
    await expect(checkpointStore.listBySession('session_resume_tool_failed')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          iteration: 3,
          status: 'running',
          updatedAt: '2026-06-24T10:06:00.000Z',
        }),
        expect.objectContaining({ iteration: 4, status: 'failed' }),
      ]),
    );
  });

  it('restarts a running checkpoint without injecting the old session history', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const recovery = new AgentRecoveryService(checkpointStore);
    const session = interruptedSession('session_restart_success');
    await checkpointStore.save({
      session,
      iteration: 2,
      status: 'running',
      toolExecutions: [
        {
          toolCallId: 'call_orders',
          toolName: 'query_database',
          status: 'success',
          durationMs: 18,
          resultPreview: '{"rows":[{"order_count":42}]}',
        },
      ],
      now: '2026-06-24T10:03:00.000Z',
    });
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'Restarted Agent task from a clean session.',
        toolCalls: [],
        usage: { promptTokens: 14, completionTokens: 8, totalTokens: 22 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      {
        now: () => '2026-06-24T10:06:00.000Z',
        createSessionId: () => 'session_restart_new',
        checkpointStore,
      },
    );

    const restarted = await recovery.restart('session_restart_success', agent, {
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 1,
      now: '2026-06-24T10:07:00.000Z',
    });

    expect(restarted.result.status).toBe('done');
    expect(restarted.result.session.id).toBe('session_restart_new');
    expect(restarted.result.finalText).toBe('Restarted Agent task from a clean session.');
    expect(restarted.abandonedCheckpointCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.map((message) => message.content)).toEqual([
      restarted.result.session.messages[0]?.content,
    ]);
    expect(calls[0]?.messages[0]?.content).toContain(
      'Restart the interrupted Agent task from the beginning.',
    );
    expect(calls[0]?.messages[0]?.content).toContain('Analyze the weekly GMV drop.');
    await expect(recovery.listRecoverablePlans()).resolves.toEqual([]);
    await expect(checkpointStore.listBySession('session_restart_success')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ iteration: 2, status: 'abandoned' })]),
    );
    await expect(checkpointStore.listBySession('session_restart_new')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ iteration: 1, status: 'done' })]),
    );
  });

  it('keeps the original checkpoint recoverable when restart returns a failed status', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const recovery = new AgentRecoveryService(checkpointStore);
    await checkpointStore.save({
      session: interruptedSession('session_restart_failed'),
      iteration: 2,
      status: 'running',
      toolExecutions: [],
      now: '2026-06-24T10:03:00.000Z',
    });
    const usage = new UsageTracker(await usagePath());
    const failingRegistry = new ToolRegistry();
    failingRegistry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => {
        throw new Error('database unavailable during restart');
      },
    );
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProviderWithCalls([
          {
            text: '',
            toolCalls: [
              {
                id: 'call_restart_query',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
          },
        ]).provider,
      ]),
      failingRegistry,
      usage,
      undefined,
      {
        now: () => '2026-06-24T10:06:00.000Z',
        createSessionId: () => 'session_restart_failed_new',
        checkpointStore,
      },
    );

    const restarted = await recovery.restart('session_restart_failed', agent, {
      providerId: 'fake',
      model: 'fake-model',
      maxIterations: 3,
      maxConsecutiveToolFailures: 1,
      now: '2026-06-24T10:07:00.000Z',
    });

    expect(restarted.result.status).toBe('tool_failed');
    expect(restarted.abandonedCheckpointCount).toBe(0);
    await expect(recovery.listRecoverablePlans()).resolves.toMatchObject([
      { sessionId: 'session_restart_failed', interruptedIteration: 2 },
    ]);
    await expect(checkpointStore.listBySession('session_restart_failed')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          iteration: 2,
          status: 'running',
          updatedAt: '2026-06-24T10:07:00.000Z',
        }),
      ]),
    );
    await expect(checkpointStore.listBySession('session_restart_failed_new')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ iteration: 1, status: 'failed' })]),
    );
  });

  it('preserves initialSession history and appends the recovery prompt for the next model call', async () => {
    const usage = new UsageTracker(await usagePath());
    const initialSession = interruptedSession('session_initial_context');
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'Continued using prior context.',
        toolCalls: [],
        usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Resume from the saved checkpoint without rerunning the order query.',
      initialSession,
      maxIterations: 1,
    });

    expect(result.status).toBe('done');
    expect(initialSession.messages).toHaveLength(3);
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'Analyze the weekly GMV drop.',
      'I already queried order volume and will continue with refund analysis.',
      '{"rows":[{"order_count":42}]}',
      'Resume from the saved checkpoint without rerunning the order query.',
      'Continued using prior context.',
    ]);
    expect(calls[0]?.messages).toMatchObject([
      { role: 'user', content: 'Analyze the weekly GMV drop.' },
      {
        role: 'assistant',
        content: 'I already queried order volume and will continue with refund analysis.',
      },
      {
        role: 'tool',
        toolCallId: 'call_orders',
        content: '{"rows":[{"order_count":42}]}',
      },
      {
        role: 'user',
        content: 'Resume from the saved checkpoint without rerunning the order query.',
      },
    ]);
  });
});

function registryWithQueryTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'query_database',
      description: 'Execute readonly SQL',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    () => ({ rows: [{ order_count: 42 }] }),
  );
  return registry;
}

function scriptedProviderWithCalls(script: LlmChatResponse[]): {
  provider: LlmProvider;
  calls: LlmChatRequest[];
} {
  const calls: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat(request) {
      calls.push(request);
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return Promise.resolve(next);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
  return { provider, calls };
}

function interruptedSession(id: string): AgentSession {
  return {
    id,
    title: 'Analyze weekly GMV drop',
    mode: 'readonly',
    strategy: 'react',
    messages: [
      {
        role: 'user',
        content: 'Analyze the weekly GMV drop.',
        createdAt: '2026-06-24T10:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'I already queried order volume and will continue with refund analysis.',
        toolCalls: [
          {
            id: 'call_orders',
            name: 'query_database',
            arguments: { sql: 'select count(*) as order_count from orders' },
          },
        ],
        createdAt: '2026-06-24T10:01:00.000Z',
      },
      {
        role: 'tool',
        toolCallId: 'call_orders',
        toolName: 'query_database',
        content: '{"rows":[{"order_count":42}]}',
        createdAt: '2026-06-24T10:02:00.000Z',
      },
    ],
    tokenUsage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
    aborted: false,
  };
}

async function checkpointPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-recovery-runner-'));
  tempDirs.push(dir);
  return join(dir, 'agent-checkpoints.json');
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-recovery-usage-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

function fixedDependencies() {
  return {
    now: () => '2026-06-24T10:05:00.000Z',
    createSessionId: () => 'session_should_not_be_used',
  };
}
