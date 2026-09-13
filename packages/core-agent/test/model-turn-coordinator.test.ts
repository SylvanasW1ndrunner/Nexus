import { describe, expect, it, vi } from 'vitest';
import {
  BatchingModelTurnObserver,
  ModelTurnCoordinator,
  ModelTurnObserverClosedError,
  ModelTurnObserverError,
} from '../src/kernel/model-turn-coordinator.js';

describe('Model Turn lifecycle observer', () => {
  it('batches deltas by size and flushes before a completed block', async () => {
    const facts: unknown[] = [];
    const observer = new BatchingModelTurnObserver({
      maxBytes: 1, maxDelayMs: 40,
      sink: { publish(fact) { facts.push(fact); return Promise.resolve(); } },
    });
    await observer.onEvent({
      type: 'decoded-delta', attemptId: 'a', routeId: 'r', occurredAt: 1,
      event: { type: 'text-delta', text: 'x', blockOrdinal: 0 },
    });
    await observer.onEvent({
      type: 'block-completed', attemptId: 'a', routeId: 'r', occurredAt: 2,
      blockOrdinal: 0, block: { type: 'text', text: 'x' },
    });
    expect(facts.map((fact) => (fact as { type: string }).type)).toEqual([
      'model-delta-batch', 'block-completed',
    ]);
    expect(facts[0]).toMatchObject({
      attemptId: 'a', routeId: 'r', batchOrdinal: 0,
      idempotencyKey: 'model-delta-batch:a:0',
    });
  });

  it('assigns stable distinct ordinals to identical-text batches', async () => {
    const facts: unknown[] = [];
    const observer = new BatchingModelTurnObserver({
      maxBytes: 1,
      sink: { publish(fact) { facts.push(fact); return Promise.resolve(); } },
    });
    const delta = {
      type: 'decoded-delta' as const, attemptId: 'a', routeId: 'r', occurredAt: 1,
      event: { type: 'text-delta' as const, text: 'same', blockOrdinal: 0 },
    };
    await observer.onEvent(delta);
    await observer.onEvent(delta);

    expect(facts).toMatchObject([
      { batchOrdinal: 0, idempotencyKey: 'model-delta-batch:a:0' },
      { batchOrdinal: 1, idempotencyKey: 'model-delta-batch:a:1' },
    ]);
  });

  it('latches a timer-driven sink failure and exposes it at flush', async () => {
    vi.useFakeTimers();
    const observer = new BatchingModelTurnObserver({
      maxBytes: 10_000, maxDelayMs: 40,
      sink: { publish() { return Promise.reject(new Error('journal unavailable')); } },
    });
    await observer.onEvent({
      type: 'decoded-delta', attemptId: 'a', routeId: 'r', occurredAt: 1,
      event: { type: 'text-delta', text: 'x', blockOrdinal: 0 },
    });
    await vi.advanceTimersByTimeAsync(41);
    await expect(observer.flush()).rejects.toBeInstanceOf(ModelTurnObserverError);
    vi.useRealTimers();
  });

  it('records only the revision acknowledged for the exact attempt start', async () => {
    const observer = new BatchingModelTurnObserver({
      sink: { publish(fact) {
        return Promise.resolve(fact.type === 'attempt-started' ? { runRevision: 7 } : undefined);
      } },
    });
    await observer.onEvent({
      type: 'attempt-started', attemptId: 'a', routeId: 'r', purpose: 'agent-turn',
      origin: { connectionId: 'c', model: 'm', protocol: 'openai-chat' }, startedAt: 1,
    });
    expect(observer.startRevision('a')).toBe(7);
    expect(observer.startRevision('other')).toBeUndefined();
  });

  it('flushes normally, closes idempotently, and rejects events after close', async () => {
    vi.useFakeTimers();
    const facts: unknown[] = [];
    const observer = new BatchingModelTurnObserver({
      sink: { publish(fact) { facts.push(fact); return Promise.resolve(); } },
    });
    await observer.onEvent({
      type: 'decoded-delta', attemptId: 'a', routeId: 'r', occurredAt: 1,
      event: { type: 'text-delta', text: 'x', blockOrdinal: 0 },
    });

    await observer.flush();
    await Promise.all([observer.close(), observer.close()]);
    await expect(observer.onEvent({
      type: 'attempt-discarded', attemptId: 'a', routeId: 'r',
      reason: 'late event', discardedAt: 2,
    })).rejects.toBeInstanceOf(ModelTurnObserverClosedError);
    await vi.advanceTimersByTimeAsync(100);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ type: 'model-delta-batch', attemptId: 'a' });
    vi.useRealTimers();
  });

  it('waits for an already-started timer flush while closing', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const sinkSettled = new Promise<void>((resolve) => { release = resolve; });
    let publishCalls = 0;
    const observer = new BatchingModelTurnObserver({
      sink: {
        publish() {
          publishCalls += 1;
          return sinkSettled;
        },
      },
    });
    await observer.onEvent({
      type: 'decoded-delta', attemptId: 'a', routeId: 'r', occurredAt: 1,
      event: { type: 'text-delta', text: 'x', blockOrdinal: 0 },
    });
    await vi.advanceTimersByTimeAsync(40);

    let closed = false;
    const closing = observer.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(publishCalls).toBe(1);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    vi.useRealTimers();
  });

  it('closes and discards an unflushed delta batch when the gateway throws', async () => {
    vi.useFakeTimers();
    const facts: unknown[] = [];
    let capturedObserver: BatchingModelTurnObserver | undefined;
    const coordinator = new ModelTurnCoordinator({
      gateway: {
        async executeAttempt(_session, _request, options) {
          capturedObserver = options.observer as BatchingModelTurnObserver;
          await options.observer?.onEvent({
            type: 'decoded-delta', attemptId: 'attempt', routeId: 'route', occurredAt: 1,
            event: { type: 'text-delta', text: 'partial', blockOrdinal: 0 },
          });
          throw new Error('gateway failed');
        },
      },
      session: {} as never,
      committer: {} as never,
      resolveUsageBillingMode: () => 'byok',
      lifecycleSink: { publish(fact) { facts.push(fact); return Promise.resolve(); } },
    });

    await expect(coordinator.execute({
      projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn',
      commandId: 'command', lease: {} as never, expectedTurnRevision: 0,
      prompt: {
        messages: [], tools: [], tokenEstimate: 0,
        request: { model: 'model', messages: [] },
      },
    })).rejects.toThrow('gateway failed');
    await vi.advanceTimersByTimeAsync(100);

    expect(facts).toEqual([]);
    if (capturedObserver === undefined) throw new Error('Gateway did not receive an observer.');
    await expect(capturedObserver.onEvent({
      type: 'attempt-discarded', attemptId: 'attempt', routeId: 'route',
      reason: 'late event', discardedAt: 2,
    })).rejects.toBeInstanceOf(ModelTurnObserverClosedError);
    vi.useRealTimers();
  });

  it('flushes and closes before a successful coordinator execution returns', async () => {
    vi.useFakeTimers();
    const facts: unknown[] = [];
    let capturedObserver: BatchingModelTurnObserver | undefined;
    const coordinator = new ModelTurnCoordinator({
      gateway: {
        async executeAttempt(_session, _request, options) {
          capturedObserver = options.observer as BatchingModelTurnObserver;
          await options.observer?.onEvent({
            type: 'attempt-started', attemptId: 'attempt', routeId: 'route',
            purpose: 'agent-turn',
            origin: { connectionId: 'connection', model: 'model', protocol: 'openai-chat' },
            startedAt: 1,
          });
          await options.observer?.onEvent({
            type: 'decoded-delta', attemptId: 'attempt', routeId: 'route', occurredAt: 2,
            event: { type: 'text-delta', text: 'complete', blockOrdinal: 0 },
          });
          return {
            attempt: {
              attemptId: 'attempt',
              origin: { connectionId: 'connection', model: 'model', protocol: 'openai-chat' },
              blocks: [], terminal: true, finishReason: 'stop', opaqueBlockRefs: [],
              validation: 'validated',
            },
            session: { route: { routeId: 'route', modelId: 'model' } } as never,
            discardedAttempts: [],
          } as never;
        },
      },
      session: {} as never,
      committer: {
        commitValidatedAttempt() {
          return Promise.resolve({ turn: {}, envelope: {}, invocations: [] } as never);
        },
      } as never,
      resolveUsageBillingMode: () => 'byok',
      lifecycleSink: {
        publish(fact) {
          facts.push(fact);
          return Promise.resolve(fact.type === 'attempt-started' ? { runRevision: 1 } : undefined);
        },
      },
    });

    await coordinator.execute({
      projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn',
      commandId: 'command', lease: {} as never, expectedTurnRevision: 0,
      prompt: {
        messages: [], tools: [], tokenEstimate: 0,
        request: { model: 'model', messages: [] },
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(facts.map((fact) => (fact as { type: string }).type)).toEqual([
      'attempt-started', 'model-delta-batch',
    ]);
    if (capturedObserver === undefined) throw new Error('Gateway did not receive an observer.');
    await expect(capturedObserver.onEvent({
      type: 'attempt-discarded', attemptId: 'attempt', routeId: 'route',
      reason: 'late event', discardedAt: 3,
    })).rejects.toBeInstanceOf(ModelTurnObserverClosedError);
    vi.useRealTimers();
  });

  it('closes the observer when an owner signal interrupts the gateway', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const facts: unknown[] = [];
    let markGatewayReady!: () => void;
    const gatewayReady = new Promise<void>((resolve) => { markGatewayReady = resolve; });
    const coordinator = new ModelTurnCoordinator({
      gateway: {
        async executeAttempt(_session, _request, options) {
          await options.observer?.onEvent({
            type: 'decoded-delta', attemptId: 'attempt', routeId: 'route', occurredAt: 1,
            event: { type: 'text-delta', text: 'partial', blockOrdinal: 0 },
          });
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error('owner interrupted')),
              { once: true },
            );
            markGatewayReady();
          });
        },
      },
      session: {} as never,
      committer: {} as never,
      resolveUsageBillingMode: () => 'byok',
      lifecycleSink: { publish(fact) { facts.push(fact); return Promise.resolve(); } },
    });
    const pending = coordinator.execute({
      projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn',
      commandId: 'command', lease: {} as never, expectedTurnRevision: 0,
      prompt: {
        messages: [], tools: [], tokenEstimate: 0,
        request: { model: 'model', messages: [] },
      },
      signal: controller.signal,
    });
    await gatewayReady;
    controller.abort();

    await expect(pending).rejects.toThrow('owner interrupted');
    await vi.advanceTimersByTimeAsync(100);
    expect(facts).toEqual([]);
    vi.useRealTimers();
  });
});
