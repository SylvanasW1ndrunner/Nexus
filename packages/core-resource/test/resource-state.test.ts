import { describe, expect, it } from 'vitest';
import { ResourceRegistry } from '../src/index.js';
import {
  testObservation,
  testResource,
  testSource,
} from './test-helpers.js';

describe('resource facts, observations and state', () => {
  it('keeps multi-source facts, resolves priority deterministically and exposes conflicts', () => {
    const registry = new ResourceRegistry({
      now: () => '2026-07-23T00:05:00.000Z',
      createEventId: sequenceId(),
    });
    const table = testResource('public.orders', 'table', {
      attributes: { owner: 'connector-owner', rows: 10 },
      facts: {
        owner: [
          {
            value: 'connector-owner',
            confidence: 0.9,
            source: testSource('connector', { priority: 5 }),
          },
        ],
      },
    });
    registry.upsertResource(table);
    registry.upsertResource({
      ...table,
      attributes: { owner: 'manual-owner', rows: 12 },
      facts: {
        owner: [
          {
            value: 'manual-owner',
            confidence: 0.8,
            source: testSource('manual', {
              sourceType: 'manual',
              priority: 100,
              observedAt: '2026-07-23T00:01:00.000Z',
            }),
          },
        ],
      },
      sources: [
        testSource('manual', {
          sourceType: 'manual',
          priority: 100,
          observedAt: '2026-07-23T00:01:00.000Z',
        }),
      ],
      version: 2,
      updatedAt: '2026-07-23T00:01:00.000Z',
    });

    expect(registry.resolveFact(table.id, 'owner')).toMatchObject({
      selected: { value: 'manual-owner' },
      conflicted: true,
    });
    expect(registry.state(table.id)?.factConflicts).toEqual(['owner']);
  });

  it('does not let stale resource payloads overwrite newer attributes', () => {
    const registry = new ResourceRegistry({ createEventId: sequenceId() });
    const table = testResource('public.orders', 'table', {
      attributes: { rows: 20, owner: 'new' },
      version: 3,
      updatedAt: '2026-07-23T00:03:00.000Z',
    });
    registry.upsertResource(table);
    registry.upsertResource({
      ...table,
      attributes: { rows: 5, staleOnly: true },
      version: 2,
      updatedAt: '2026-07-23T00:02:00.000Z',
      sources: [
        testSource('stale', {
          observedAt: '2026-07-23T00:02:00.000Z',
        }),
      ],
    });

    expect(registry.getResource(table.id)).toMatchObject({
      attributes: { rows: 20, owner: 'new', staleOnly: true },
      version: 3,
      updatedAt: '2026-07-23T00:03:00.000Z',
    });
  });

  it('derives fresh, stale, conflicting and lifecycle state without AI', () => {
    const registry = new ResourceRegistry({
      now: () => '2026-07-23T00:05:00.000Z',
      createEventId: sequenceId(),
    });
    const table = testResource('public.orders');
    registry.upsertResource(table);
    registry.addObservation(
      testObservation(table.id, 'driver-health', {
        source: testSource('driver'),
        status: 'healthy',
      }),
    );
    registry.addObservation(
      testObservation(table.id, 'monitor-health', {
        source: testSource('monitor', { sourceType: 'mcp' }),
        status: 'degraded',
      }),
    );
    registry.addObservation(
      testObservation(table.id, 'expired-capacity', {
        category: 'capacity',
        status: 'unavailable',
        observedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-07-23T00:01:00.000Z',
      }),
    );
    registry.addObservation(
      testObservation(table.id, 'future-observation', {
        observedAt: '2026-07-23T00:06:00.000Z',
        expiresAt: '2026-07-23T00:07:00.000Z',
        status: 'unavailable',
        source: testSource('future', { observedAt: '2026-07-23T00:06:00.000Z' }),
      }),
    );

    const state = registry.state(table.id);
    expect(state).toMatchObject({
      lifecycle: 'active',
      status: 'degraded',
      freshness: 'fresh',
    });
    expect(state?.categories.find((item) => item.category === 'health')).toMatchObject({
      status: 'degraded',
      freshness: 'fresh',
      conflicted: true,
    });
    expect(state?.categories.find((item) => item.category === 'capacity')).toMatchObject({
      status: 'unavailable',
      freshness: 'stale',
    });
    registry.markResourceDeleted(table.id, '2026-07-23T00:05:30.000Z');
    expect(registry.state(table.id)?.lifecycle).toBe('deleted');
  });

  it('preserves custom category status but treats it as unknown overall', () => {
    const registry = new ResourceRegistry({
      now: () => '2026-07-23T00:05:00.000Z',
    });
    const table = testResource('public.orders');
    registry.upsertResource(table);
    registry.addObservation(
      testObservation(table.id, 'custom-health', {
        status: 'vendor-maintenance',
      }),
    );

    const state = registry.state(table.id);
    expect(state?.categories[0]?.status).toBe('vendor-maintenance');
    expect(state?.status).toBe('unknown');
  });

  it('deduplicates observations and keeps observation and event history bounded', () => {
    const registry = new ResourceRegistry({
      maxObservationsPerResource: 3,
      maxEvents: 4,
      createEventId: sequenceId(),
    });
    const table = testResource('public.orders');
    registry.upsertResource(table);
    for (let index = 0; index < 8; index += 1) {
      const minute = String(index).padStart(2, '0');
      registry.addObservation(
        testObservation(table.id, `observation-${index}`, {
          observedAt: `2026-07-23T00:${minute}:00.000Z`,
          expiresAt: `2026-07-23T01:${minute}:00.000Z`,
          source: testSource('monitor', {
            observedAt: `2026-07-23T00:${minute}:00.000Z`,
          }),
        }),
      );
    }
    const latest = testObservation(table.id, 'observation-7', {
      observedAt: '2026-07-23T00:07:00.000Z',
      expiresAt: '2026-07-23T01:07:00.000Z',
      source: testSource('monitor', {
        observedAt: '2026-07-23T00:07:00.000Z',
      }),
    });
    const beforeEvents = registry.eventCount;
    registry.addObservation(latest);

    expect(registry.observationCount).toBe(3);
    expect(
      registry
        .observationsFor(table.id, {
          includeExpired: true,
          at: '2026-07-23T02:00:00.000Z',
        })
        .map((item) => item.id),
    ).toEqual(['observation-7', 'observation-6', 'observation-5']);
    expect(registry.eventCount).toBe(beforeEvents);
    expect(registry.eventCount).toBe(4);
    expect(registry.events({ limit: 10 }).items[0]?.sequence).toBeGreaterThan(1);
  });
});

function sequenceId(): () => string {
  let index = 0;
  return () => `event-${++index}`;
}
