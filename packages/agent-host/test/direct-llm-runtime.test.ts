import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmConnectionManager,
  ModelClientError,
  LlmProviderError,
  type ModelClient,
  type LlmChatRequest,
  type LlmProvider,
  type LlmProviderPlugin,
} from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeError } from '../src/errors.js';
import { DirectLlmRuntime } from '../src/direct-llm-runtime.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DirectLlmRuntime', () => {
  it('routes two explicit model selections without installing a mutable route delegate', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();

    await runtime.chat(message('alpha'), {
      model: { connectionId: fixture.first.id, modelId: 'model-a' },
    });
    await runtime.chat(message('beta'), {
      model: { connectionId: fixture.second.id, modelId: 'model-b' },
    });

    expect(fixture.calls.map(({ endpoint, model }) => ({ endpoint, model }))).toEqual([
      { endpoint: 'https://first.invalid/v1', model: 'model-a' },
      { endpoint: 'https://second.invalid/v1', model: 'model-b' },
    ]);
    await runtime.close();
  });

  it('executes through the canonical session gateway without calling manager chat orchestration', async () => {
    const fixture = await createFixture();
    const managerWithLegacyHooks = fixture.manager as unknown as {
      executeChat: () => Promise<never>;
      stream: () => AsyncIterable<never>;
    };
    managerWithLegacyHooks.executeChat = () =>
      Promise.reject(new Error('legacy manager chat path must not execute'));
    managerWithLegacyHooks.stream = async function* () {
      yield await Promise.reject(new Error('legacy manager stream path must not execute'));
    };
    const runtime = fixture.runtime();
    const model = { connectionId: fixture.first.id, modelId: 'model-a' };

    await expect(runtime.chat(message('canonical-chat'), { model })).resolves.toMatchObject({
      text: 'first:model-a:canonical-chat',
    });
    const events = [];
    for await (const event of runtime.stream(message('canonical-stream'), { model })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      response: { text: 'first:model-a:canonical-stream' },
    });
    await runtime.close();
  });

  it('lets the connection manager merge global, session, and request generation parameters', async () => {
    const fixture = await createFixture({
      globalParameters: { temperature: 0.1, topP: 0.8, maxOutputTokens: 2_048 },
    });
    const runtime = fixture.runtime();

    await runtime.chat(
      {
        ...message('parameters'),
        temperature: 0.3,
      },
      {
        model: { connectionId: fixture.first.id, modelId: 'model-a' },
        sessionParameters: { temperature: 0.2, maxOutputTokens: 1_024, stop: ['DONE'] },
      },
    );

    expect(fixture.calls[0]?.request).toMatchObject({
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 1_024,
      stop: ['DONE'],
    });
    expect(fixture.calls[0]?.wireRequest).toMatchObject({ max_tokens: 1_024 });
    expect(fixture.calls[0]?.wireRequest).not.toHaveProperty('max_completion_tokens');
    await runtime.close();
  });

  it('records direct chat usage and runtime metrics once', async () => {
    const fixture = await createFixture();
    const usage = new UsageTracker();
    const runtime = fixture.runtime({ usageTracker: usage });

    const response = await runtime.chat(message('usage'), {
      model: { connectionId: fixture.first.id, modelId: 'model-a' },
    });

    expect(response.usage).toEqual({
      promptTokens: 11,
      completionTokens: 5,
      totalTokens: 16,
    });
    expect(runtime.metrics()).toMatchObject({
      requests: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      totalPromptTokens: 11,
      totalCompletionTokens: 5,
    });
    await expect(usage.current()).resolves.toMatchObject({
      mode: 'byok',
      promptTokens: 11,
      completionTokens: 5,
      totalTokens: 16,
    });
    await runtime.close();
  });

  it('forwards stream events and aborts the operation when the consumer returns early', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();
    const iterator = runtime.stream(message('stream'), {
      model: { connectionId: fixture.first.id, modelId: 'model-a' },
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', text: 'first:model-a:stream' },
    });
    await iterator.return?.();

    expect(runtime.metrics()).toMatchObject({ requests: 1, completed: 0, cancelled: 1 });
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('records one successful stream usage and metric even when finish is the last consumed event', async () => {
    const fixture = await createFixture();
    const usage = new UsageTracker();
    const runtime = fixture.runtime({ usageTracker: usage });
    const events = [];

    for await (const event of runtime.stream(message('complete-stream'), {
      model: { connectionId: fixture.first.id, modelId: 'model-a' },
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text-delta', 'usage', 'finish']);
    expect(runtime.metrics()).toMatchObject({
      requests: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      totalPromptTokens: 11,
      totalCompletionTokens: 5,
    });
    await expect(usage.current()).resolves.toMatchObject({ totalTokens: 16 });
    await runtime.close();
  });

  it('propagates caller abort and leaves no operation that can delay close', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();
    const controller = new AbortController();
    const call = runtime.chat(
      { ...message('slow'), signal: controller.signal },
      { model: { connectionId: fixture.first.id, modelId: 'model-a' } },
    );
    await fixture.waitUntilStarted();

    controller.abort('user cancelled');

    await expect(call).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.metrics()).toMatchObject({ requests: 1, cancelled: 1 });
  });

  it('runs bounded-concurrency batches, isolates owners, and cancels a running job', async () => {
    const fixture = await createFixture({ delayMs: 20 });
    const firstRuntime = fixture.runtime({ ownerId: 'first-owner' });
    const secondRuntime = fixture.runtime({ ownerId: 'second-owner' });
    const selection = { connectionId: fixture.first.id, modelId: 'model-a' };

    const completed = firstRuntime.submitBatch(
      [
        { request: { ...message('one'), temperature: 0.1 }, options: { model: selection } },
        {
          request: { ...message('two'), temperature: 0.7 },
          options: {
            model: { connectionId: fixture.second.id, modelId: 'model-b' },
          },
        },
        { request: message('three'), options: { model: selection } },
      ],
      { concurrency: 2 },
    );
    const completedSnapshot = await waitForJob(firstRuntime, completed.id);

    expect(completedSnapshot).toMatchObject({ status: 'completed', completed: 3, failed: 0 });
    expect(fixture.maxActive).toBe(2);
    expect(fixture.calls.find((call) => call.request.messages.at(-1)?.content === 'one')).toMatchObject({
      endpoint: 'https://first.invalid/v1',
      model: 'model-a',
      request: { temperature: 0.1 },
    });
    expect(fixture.calls.find((call) => call.request.messages.at(-1)?.content === 'two')).toMatchObject({
      endpoint: 'https://second.invalid/v1',
      model: 'model-b',
      request: { temperature: 0.7 },
    });
    expect(secondRuntime.getJob(completed.id)).toBeUndefined();
    expect(firstRuntime.listJobs().map((job) => job.id)).toContain(completed.id);

    const running = secondRuntime.submitBatch([
      { request: message('slow'), options: { model: selection } },
    ]);
    await fixture.waitUntilStarted('slow');
    expect(firstRuntime.cancelJob(running.id)).toBeUndefined();
    expect(secondRuntime.cancelJob(running.id)?.id).toBe(running.id);
    await expect(waitForJob(secondRuntime, running.id)).resolves.toMatchObject({
      status: 'cancelled',
      cancelled: 1,
    });

    await Promise.all([firstRuntime.close(), secondRuntime.close()]);
  });

  it('closes during an active stream and batch job, and close is concurrent-idempotent', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();
    const selection = { connectionId: fixture.first.id, modelId: 'model-a' };
    const streamIterator = runtime.stream(message('slow'), { model: selection })[Symbol.asyncIterator]();
    const pendingStream = streamIterator.next().catch((error: unknown) => error);
    const job = runtime.submitBatch([{ request: message('slow-job'), options: { model: selection } }]);
    await fixture.waitUntilStarted('slow-job');

    const firstClose = runtime.close();
    const secondClose = runtime.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await pendingStream;
    expect(runtime.getJob(job.id)).toMatchObject({ status: 'cancelled' });
    await expect(runtime.chat(message('after-close'), { model: selection })).rejects.toBeInstanceOf(
      AgentRuntimeError,
    );

    // DirectLlmRuntime borrows the manager; shutting down the wrapper must not close it.
    await expect(fixture.manager.prepare(selection)).resolves.toMatchObject({
      selection,
      route: { modelId: 'model-a' },
    });
  });

  it('does not count a never-consumed lazy stream as a model request', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();

    runtime.stream(message('never-consumed'), {
      model: { connectionId: fixture.first.id, modelId: 'model-a' },
    });
    await runtime.close();

    expect(runtime.metrics()).toMatchObject({ requests: 0, completed: 0, cancelled: 0 });
    expect(fixture.calls).toHaveLength(0);
  });

  it('preserves typed provider errors without exposing the configured credential', async () => {
    const fixture = await createFixture({ apiKey: 'fixture-secret-that-must-not-leak' });
    const runtime = fixture.runtime();
    const error = await runtime
      .chat(message('provider-error'), {
        model: { connectionId: fixture.first.id, modelId: 'model-a' },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({ code: 'LLM_RATE_LIMITED', retryable: true, statusCode: 429 });
    expect(JSON.stringify(error)).not.toContain('fixture-secret-that-must-not-leak');
    expect(runtime.metrics()).toMatchObject({ requests: 1, failed: 1 });
    await runtime.close();
  });

  it('passes canonical timeout and retry controls to the connection manager', async () => {
    const fixture = await createFixture();
    const runtime = fixture.runtime();
    const model = { connectionId: fixture.first.id, modelId: 'model-a' };

    await expect(runtime.chat(message('retry-once'), { model, maxRetries: 1 })).resolves.toMatchObject({
      text: 'first:model-a:retry-once',
    });
    expect(
      fixture.calls.filter((call) => call.request.messages.at(-1)?.content === 'retry-once'),
    ).toHaveLength(2);

    await expect(runtime.chat(message('timeout'), { model, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
      retryable: true,
    });
    await runtime.close();
  });

  it('does not finish close while successful usage recording is still in flight', async () => {
    const fixture = await createFixture();
    const usage = new SlowUsageTracker();
    const runtime = fixture.runtime({ usageTracker: usage });
    const selection = { connectionId: fixture.first.id, modelId: 'model-a' };
    const call = runtime.chat(message('usage-delay'), { model: selection });
    await usage.started;

    let closeSettled = false;
    const closing = runtime.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closeSettled).toBe(false);

    usage.release();
    await expect(call).resolves.toMatchObject({ text: 'first:model-a:usage-delay' });
    await closing;
    expect(closeSettled).toBe(true);
  });

  it('does not depend on the retired mutable routing surface', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/direct-llm-runtime.ts'), 'utf8');

    expect(source).not.toMatch(/LlmRouter|registerRouteDelegate|managed provider/i);
  });
});

type ProviderCall = {
  endpoint: string;
  model: string;
  request: LlmChatRequest;
  wireRequest: Record<string, unknown>;
  signal: AbortSignal;
};

function outputTokenLimit(input: {
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  max_new_tokens?: number;
}): number | undefined {
  const values = [
    input.max_tokens,
    input.max_completion_tokens,
    input.max_output_tokens,
    input.max_new_tokens,
  ].filter((value): value is number => value !== undefined);
  if (values.length > 1) {
    throw new Error('OpenAI Chat requests must encode maxOutputTokens with exactly one wire key.');
  }
  return values[0];
}

async function createFixture(options: {
  globalParameters?: ConstructorParameters<typeof LlmConnectionManager>[0]['globalParameters'];
  apiKey?: string;
  delayMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-direct-llm-'));
  tempDirectories.push(directory);
  const calls: ProviderCall[] = [];
  const starts: string[] = [];
  const attempts = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const plugin: LlmProviderPlugin = {
    manifest: {
      id: 'direct-runtime-test',
      name: 'Direct runtime test',
      version: '1',
      protocol: 'openai-chat',
      priority: 10_000,
    },
    match: () => ({ score: 10_000, evidence: [] }),
    discover: () =>
      Promise.resolve({ score: 10_000, models: ['model-a', 'model-b'], evidence: [] }),
    createProvider: ({ connection, resolution }): LlmProvider => ({
      id: resolution.providerId,
      name: connection.name,
      mode: 'byok',
      protocol: 'openai-chat',
      capabilities: { chat: 'supported', streaming: 'supported' },
      generationParameters: {
        temperature: 'supported',
        topP: 'supported',
        maxOutputTokens: 'supported',
        seed: 'supported',
        stop: 'supported',
      },
      chat: () => Promise.reject(new Error('The legacy Provider chat surface must not execute.')),
      isAvailable: () => Promise.resolve({ available: true }),
    }),
  };
  const manager = new LlmConnectionManager({
    cacheDirectory: directory,
    plugins: [plugin],
    trustedModelClientFactory: ({ connection, resolution }): ReturnType<NonNullable<ConstructorParameters<typeof LlmConnectionManager>[0]['trustedModelClientFactory']>> => ({
      client: {
        async execute(input) {
          const wire = input.wireRequest as {
            model: string;
            messages: Array<{ role: LlmChatRequest['messages'][number]['role']; content: string }>;
            temperature?: number;
            top_p?: number;
            max_tokens?: number;
            max_completion_tokens?: number;
            max_output_tokens?: number;
            max_new_tokens?: number;
            stop?: string[];
          };
          const signal = input.signal;
          const wireContent = wire.messages.at(-1)?.content ?? '';
          const content = typeof wireContent === 'string'
            ? wireContent
            : (wireContent as unknown as Array<{ type?: string; text?: string }>)
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('');
          const maxTokens = outputTokenLimit(wire);
          const request: LlmChatRequest = {
            model: wire.model,
            messages: wire.messages.map((message) => ({
              ...message,
              content: typeof message.content === 'string'
                ? message.content
                : (message.content as unknown as Array<{ type?: string; text?: string }>)
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text ?? '')
                    .join(''),
            })),
            signal,
            ...(wire.temperature === undefined ? {} : { temperature: wire.temperature }),
            ...(wire.top_p === undefined ? {} : { topP: wire.top_p }),
            ...(maxTokens === undefined
              ? {}
              : { maxTokens }),
            ...(wire.stop === undefined ? {} : { stop: wire.stop }),
          };
          calls.push({
            endpoint: connection.endpoint,
            model: wire.model,
            request,
            wireRequest: structuredClone(input.wireRequest) as Record<string, unknown>,
            signal,
          });
          starts.push(content);
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            attempts.set(content, (attempts.get(content) ?? 0) + 1);
            if (content === 'provider-error') {
              throw new ModelClientError('HTTP_ERROR', 'The relay is overloaded.', {
                retryable: true,
                statusCode: 429,
              });
            }
            if (content === 'retry-once' && attempts.get(content) === 1) {
              throw new ModelClientError('CONNECT_FAILED', 'Temporary network failure.', {
                retryable: true,
              });
            }
            if (content === 'timeout' || content.startsWith('slow')) await waitForAbort(signal);
            if (options.delayMs) await abortableDelay(options.delayMs, signal);
            return {
              kind: 'json' as const,
              response: {
                id: `response:${content}`,
                choices: [{ message: { content }, finish_reason: 'stop' }].map((choice) => ({
                  ...choice,
                  message: { content: `first:${wire.model}:${content}` },
                })),
                usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
              },
            };
          } finally {
            active -= 1;
          }
        },
      } satisfies ModelClient,
      bindingEvidence: {
        connectionResolutionRevision: resolution.revision,
        connectionConfigurationRevision: connection.connectionConfigurationRevision,
        credentialRevision: connection.credentialRevision,
      },
    }),
    ...(options.globalParameters === undefined
      ? {}
      : { globalParameters: options.globalParameters }),
  });
  const [first, second] = manager.replaceConnections([
    {
      name: 'first',
      endpoint: 'https://first.invalid/v1',
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    },
    { name: 'second', endpoint: 'https://second.invalid/v1' },
  ]);
  if (!first || !second) throw new Error('Fixture connections were not created.');

  return {
    manager,
    first,
    second,
    calls,
    starts,
    get maxActive() {
      return maxActive;
    },
    runtime(overrides: Partial<ConstructorParameters<typeof DirectLlmRuntime>[0]> = {}) {
      return new DirectLlmRuntime({
        manager,
        usageTracker: new UsageTracker(),
        tenantId: 'tenant-a',
        ...overrides,
      });
    },
    async waitUntilStarted(content?: string) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (content === undefined ? starts.length > 0 : starts.includes(content)) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`Provider did not start${content ? ` ${content}` : ''}.`);
    },
  };
}

class SlowUsageTracker extends UsageTracker {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });

  override async recordTokens(...args: Parameters<UsageTracker['recordTokens']>) {
    this.resolveStarted();
    await this.released;
    return await super.recordTokens(...args);
  }

  release(): void {
    this.resolveRelease();
  }
}

function message(content: string) {
  return { messages: [{ role: 'user' as const, content }] };
}

async function waitForJob(runtime: DirectLlmRuntime, id: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const job = runtime.getJob(id);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Job ${id} did not settle.`);
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () =>
      reject(new LlmProviderError('LLM_ABORTED', 'The model request was aborted.', false));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new LlmProviderError('LLM_ABORTED', 'The model request was aborted.', false));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
