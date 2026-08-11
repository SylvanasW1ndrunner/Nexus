import { describe, expect, it, vi } from 'vitest';
import {
  BatchingModelTurnObserver,
  ModelTurnObserverError,
} from '../src/kernel/model-turn-coordinator.js';

describe('Model Turn lifecycle observer', () => {
  it('batches deltas by size and flushes before a completed block', async () => {
    const facts: unknown[] = [];
    const observer = new BatchingModelTurnObserver({
      maxBytes: 1, maxDelayMs: 40,
      sink: { async publish(fact) { facts.push(fact); } },
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
  });

  it('latches a timer-driven sink failure and exposes it at flush', async () => {
    vi.useFakeTimers();
    const observer = new BatchingModelTurnObserver({
      maxBytes: 10_000, maxDelayMs: 40,
      sink: { async publish() { throw new Error('journal unavailable'); } },
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
      sink: { async publish(fact) {
        return fact.type === 'attempt-started' ? { runRevision: 7 } : undefined;
      } },
    });
    await observer.onEvent({
      type: 'attempt-started', attemptId: 'a', routeId: 'r', purpose: 'agent-turn',
      origin: { connectionId: 'c', model: 'm', protocol: 'openai-chat' }, startedAt: 1,
    });
    expect(observer.startRevision('a')).toBe(7);
    expect(observer.startRevision('other')).toBeUndefined();
  });
});
