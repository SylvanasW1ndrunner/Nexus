import { describe, expect, it, vi } from 'vitest';
import {
  ToolExecutionRouter,
  ToolRegistry,
  createAgentSession,
  type AgentToolExecutionHook,
} from '../src/index.js';
import type { LlmToolCall } from '@dbagent/core-llm';

const now = () => '2026-08-01T00:00:00.000Z';

describe('ToolExecutionRouter', () => {
  it('validates arguments and applies allowed/visible boundaries before a handler can run', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(() => ({ ok: true }));
    registry.register(
      {
        name: 'read_file',
        description: 'Read file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: true,
      },
      handler,
    );
    registry.register(
      {
        name: 'hidden_file',
        description: 'Hidden file reader',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: true,
      },
      handler,
    );
    const router = new ToolExecutionRouter(registry);

    const outcomes = await router.execute({
      calls: [
        call('invalid', 'read_file', {}),
        call('hidden', 'hidden_file', { path: 'README.md' }),
        call('missing', 'not_registered', {}),
      ],
      context: { session: session() },
      allowedTools: ['read_file', 'hidden_file', 'not_registered'],
      visibleTools: ['read_file', 'not_registered'],
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(outcomes[0]?.error).toContain('Tool arguments are invalid');
    expect(outcomes[1]?.error).toContain('not active');
    expect(outcomes[2]?.error).toContain('not registered');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs a contiguous read group concurrently while serializing mutations in call order', async () => {
    const registry = new ToolRegistry();
    const readStarted: string[] = [];
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    for (const name of ['read_a', 'read_b']) {
      registry.register(readDefinition(name), async () => {
        readStarted.push(name);
        await readGate;
        return name;
      });
    }
    const writes: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    for (const name of ['write_a', 'write_b']) {
      registry.register(writeDefinition(name), async () => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        writes.push(name);
        await delay(15);
        activeWrites -= 1;
        return name;
      });
    }

    const execution = new ToolExecutionRouter(registry).execute({
      calls: [
        call('r1', 'read_a'),
        call('r2', 'read_b'),
        call('w1', 'write_a'),
        call('w2', 'write_b'),
      ],
      context: { session: session() },
    });
    await waitUntil(() => readStarted.length === 2);
    expect(readStarted.sort()).toEqual(['read_a', 'read_b']);
    expect(writes).toEqual([]);
    releaseReads?.();

    const outcomes = await execution;
    expect(outcomes.map((outcome) => outcome.result)).toEqual([
      'read_a',
      'read_b',
      'write_a',
      'write_b',
    ]);
    expect(writes).toEqual(['write_a', 'write_b']);
    expect(maxActiveWrites).toBe(1);
  });

  it('runs hooks around authorization and preserves a completed external action when a post-hook fails', async () => {
    const registry = new ToolRegistry();
    let externalWrites = 0;
    registry.register(writeDefinition('write_external'), (args) => {
      externalWrites += 1;
      return { saved: args.value };
    });
    const order: string[] = [];
    const hooks: AgentToolExecutionHook[] = [
      {
        before(input) {
          order.push(`before:${String(input.arguments.value)}`);
          return { arguments: { value: 'normalized' } };
        },
        after(input) {
          order.push(`after:${JSON.stringify(input.result)}`);
          throw new Error('projection hook failed');
        },
      },
    ];
    const authorize = vi.fn(() => {
      order.push('authorize');
      return Promise.resolve({ decision: 'allow' as const, metadata: { source: 'test' } });
    });

    const [outcome] = await new ToolExecutionRouter(registry, { hooks }).execute({
      calls: [call('write', 'write_external', { value: 'raw' })],
      context: { session: session() },
      authorize,
    });

    expect(order).toEqual([
      'before:raw',
      'authorize',
      'after:{"saved":"normalized"}',
    ]);
    expect(externalWrites).toBe(1);
    expect(outcome).toMatchObject({
      status: 'success',
      handlerCompleted: true,
      result: { saved: 'normalized' },
      hookWarnings: ['projection hook failed'],
      authorizationMetadata: { source: 'test' },
    });
  });

  it('aborts a timed-out handler through the per-call signal', async () => {
    const registry = new ToolRegistry();
    let observedAbort = false;
    registry.register(
      {
        ...readDefinition('slow_read'),
        execution: { concurrency: 'read', timeoutMs: 20 },
      },
      async (_args, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new Error('handler cancelled'));
            },
            { once: true },
          );
        });
      },
    );

    const [outcome] = await new ToolExecutionRouter(registry).execute({
      calls: [call('slow', 'slow_read')],
      context: { session: session() },
      defaultTimeoutMs: 1_000,
    });

    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('timed out');
    expect(observedAbort).toBe(true);
  });
});

function call(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown> = {},
): LlmToolCall {
  return { id, name, arguments: argumentsValue };
}

function readDefinition(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', additionalProperties: true },
    dangerLevel: 'safe' as const,
    readonly: true,
    execution: { concurrency: 'read' as const },
  };
}

function writeDefinition(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', additionalProperties: true },
    dangerLevel: 'medium' as const,
    readonly: false,
    requiredPermission: 'edit' as const,
    execution: { concurrency: 'write' as const },
  };
}

function session() {
  return createAgentSession({ id: 'router-session', title: 'Router', mode: 'full', now });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent reads.');
    await delay(2);
  }
}
