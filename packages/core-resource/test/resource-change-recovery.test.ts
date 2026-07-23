import { describe, expect, it } from 'vitest';
import type { ResourceRegistrySnapshot } from '@dbagent/shared';
import {
  ResourceConflictError,
  ResourceRegistry,
} from '../src/index.js';
import {
  testObservation,
  testRelation,
  testResource,
  testSource,
} from './test-helpers.js';

describe('resource incremental changes and recovery', () => {
  it('makes duplicate versions idempotent and rejects out-of-order sequences', () => {
    const registry = new ResourceRegistry();
    const table = testResource('public.orders');
    expect(
      registry.applyChangeSet({
        sourceId: 'connector',
        version: '2',
        sequence: 2,
        observedAt: '2026-07-23T00:02:00.000Z',
        upsertResources: [
          {
            ...table,
            updatedAt: '2026-07-23T00:02:00.000Z',
            version: 2,
          },
        ],
      }),
    ).toMatchObject({ ignored: false, upsertedResources: 1 });
    const before = registry.snapshot();
    expect(
      registry.applyChangeSet({
        sourceId: 'connector',
        version: '2',
        sequence: 2,
        observedAt: '2026-07-23T00:02:00.000Z',
      }),
    ).toMatchObject({ ignored: true });
    expect(registry.snapshot()).toEqual(before);
    expect(
      captureResourceFailure(() =>
        registry.applyChangeSet({
          sourceId: 'connector',
          version: '1',
          sequence: 1,
          observedAt: '2026-07-23T00:01:00.000Z',
        }),
      ).code,
    ).toBe('STALE_CHANGE_SET');
    expect(registry.snapshot()).toEqual(before);
  });

  it('applies resource restoration and records a bounded change summary', () => {
    const registry = new ResourceRegistry({ maxEvents: 20 });
    const table = testResource('public.orders');
    registry.upsertResource(table);
    registry.applyChangeSet({
      sourceId: 'connector',
      version: '2',
      sequence: 2,
      observedAt: '2026-07-23T00:02:00.000Z',
      deleteResourceIds: [table.id],
    });
    expect(registry.getResource(table.id)).toBeUndefined();

    const restored = registry.applyChangeSet({
      sourceId: 'connector',
      version: '3',
      sequence: 3,
      observedAt: '2026-07-23T00:03:00.000Z',
      restoreResourceIds: [table.id],
    });
    expect(restored).toMatchObject({ restoredResources: 1, ignored: false });
    expect(registry.getResource(table.id)).toBeDefined();
    expect(
      registry.events({ types: ['change-set-applied'] }).items.map((event) => event.attributes),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: '2', sequence: 2 }),
        expect.objectContaining({ version: '3', sequence: 3 }),
      ]),
    );
  });

  it('binds duplicate resources without losing facts, aliases or graph edges', () => {
    const registry = new ResourceRegistry();
    const schema = testResource('public', 'schema');
    const primary = testResource('public.orders');
    const duplicate = testResource('public.orders-copy', 'table', {
      id: 'duplicate',
      facts: {
        owner: [
          {
            value: 'warehouse',
            source: testSource('cloud', { sourceType: 'cloud-api' }),
          },
        ],
      },
    });
    [schema, primary, duplicate].forEach((item) => registry.upsertResource(item));
    registry.upsertRelation(testRelation(schema, duplicate));

    const merged = registry.bindResources(
      primary.id,
      duplicate.id,
      testSource('operator', {
        sourceType: 'manual',
        observedAt: '2026-07-23T00:05:00.000Z',
      }),
    );
    expect(merged.aliases).toEqual(expect.arrayContaining([duplicate.nativeId]));
    expect(merged.facts?.owner).toHaveLength(1);
    expect(registry.getResource(duplicate.id)).toBeUndefined();
    expect(registry.neighbors(schema.id).map((item) => item.id)).toContain(primary.id);
    expect(registry.events({ types: ['resource-bound'] }).items).toHaveLength(1);
  });

  it('restores snapshots atomically and preserves the original state on invalid input', () => {
    const registry = new ResourceRegistry();
    const database = testResource('analytics', 'database');
    const table = testResource('public.orders');
    registry.upsertResource(database);
    registry.upsertResource(table);
    registry.upsertRelation(testRelation(database, table));
    registry.addObservation(testObservation(table.id, 'health'));
    const valid = registry.snapshot();

    const restored = new ResourceRegistry();
    restored.restore(valid);
    expect(restored.snapshot()).toEqual(valid);

    const invalid: ResourceRegistrySnapshot = structuredClone(valid);
    invalid.relations[0]!.toResourceId = 'missing';
    const before = restored.snapshot();
    expect(() => restored.restore(invalid)).toThrowError(ResourceConflictError);
    expect(restored.snapshot()).toEqual(before);

    const unsupportedVersion = structuredClone(valid);
    Reflect.set(unsupportedVersion, 'contractVersion', '2.0');
    expect(
      captureResourceFailure(() => restored.restore(unsupportedVersion)).code,
    ).toBe('RESOURCE_VALIDATION_FAILED');
  });

  it('rejects an invalid lifecycle timestamp before applying any batch mutation', () => {
    const registry = new ResourceRegistry();
    const existing = testResource('public.existing', 'table', {
      updatedAt: '2026-07-23T00:05:00.000Z',
      version: 5,
    });
    registry.upsertResource(existing);
    const before = registry.snapshot();
    const newResource = testResource('public.new');

    expect(
      captureResourceFailure(() =>
        registry.applyChangeSet({
          sourceId: 'connector',
          version: '6',
          sequence: 6,
          observedAt: '2026-07-23T00:04:00.000Z',
          upsertResources: [newResource],
          deleteResourceIds: [existing.id],
        }),
      ).code,
    ).toBe('RESOURCE_VALIDATION_FAILED');
    expect(registry.snapshot()).toEqual(before);
    expect(registry.getResource(newResource.id)).toBeUndefined();
  });
});

function captureResourceFailure(operation: () => void): ResourceConflictError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ResourceConflictError) return error;
    throw error;
  }
  throw new Error('Expected ResourceConflictError');
}
