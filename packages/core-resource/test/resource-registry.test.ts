import { describe, expect, it } from 'vitest';
import type {
  ResourceDescriptor,
  ResourceObservation,
  ResourceRelation,
  ResourceSource,
} from '@dbagent/shared';
import {
  ResourceConflictError,
  ResourceRegistry,
  createStableRelationId,
  createStableResourceId,
} from '../src/index.js';

const time = '2026-07-23T00:00:00.000Z';
const source: ResourceSource = {
  sourceId: 'test-connector',
  sourceType: 'connector',
  observedAt: time,
};

function resource(
  nativeId: string,
  kind = 'table',
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: createStableResourceId({ sourceNamespace: 'test', kind, nativeId }),
    kind,
    nativeId,
    canonicalName: nativeId,
    engine: 'mock',
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: [source],
    ...overrides,
  };
}

function relation(
  from: ResourceDescriptor,
  to: ResourceDescriptor,
  kind = 'contains',
): ResourceRelation {
  return {
    id: createStableRelationId({
      kind,
      fromResourceId: from.id,
      toResourceId: to.id,
    }),
    kind,
    fromResourceId: from.id,
    toResourceId: to.id,
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: [source],
  };
}

describe('ResourceRegistry', () => {
  it('creates deterministic resource and relation identities', () => {
    expect(createStableResourceId({ sourceNamespace: 'x', kind: 'table', nativeId: 'a' })).toBe(
      createStableResourceId({ sourceNamespace: 'x', kind: 'table', nativeId: 'a' }),
    );
    expect(createStableResourceId({ sourceNamespace: 'x', kind: 'view', nativeId: 'a' })).not.toBe(
      createStableResourceId({ sourceNamespace: 'x', kind: 'table', nativeId: 'a' }),
    );
    expect(
      createStableRelationId({ kind: 'contains', fromResourceId: 'a', toResourceId: 'b' }),
    ).not.toBe(
      createStableRelationId({ kind: 'contains', fromResourceId: 'b', toResourceId: 'a' }),
    );
  });

  it('upserts, merges provenance and rejects identity mutation', () => {
    const registry = new ResourceRegistry();
    const table = resource('db.public.orders', 'table', {
      tags: { owner: 'data' },
      attributes: { rows: 10 },
      facts: { owner: [{ value: 'data', source }] },
    });
    registry.upsertResource(table);
    registry.upsertResource({
      ...table,
      displayName: 'Orders',
      aliases: ['sales_orders'],
      attributes: { rows: 12, size: 100 },
      facts: {
        owner: [
          {
            value: 'sales',
            source: { sourceId: 'manual', sourceType: 'manual', observedAt: time },
          },
        ],
      },
      version: 2,
      updatedAt: '2026-07-23T00:01:00.000Z',
      sources: [{ sourceId: 'manual', sourceType: 'manual', observedAt: time }],
    });

    const merged = registry.getResource(table.id);
    expect(merged).toMatchObject({
      displayName: 'Orders',
      aliases: ['sales_orders'],
      attributes: { rows: 12, size: 100 },
      version: 2,
    });
    expect(merged?.sources).toHaveLength(2);
    expect(merged?.facts?.owner).toHaveLength(2);
    expect(() =>
      registry.upsertResource({ ...table, kind: 'view', nativeId: 'other' }),
    ).toThrow(ResourceConflictError);
    expect(registry.getResource(table.id)?.attributes).not.toBe(table.attributes);
  });

  it('indexes relations in both directions and queries one-hop neighbors', () => {
    const registry = new ResourceRegistry();
    const database = resource('db', 'database');
    const schema = resource('db.public', 'schema');
    const table = resource('db.public.orders');
    for (const item of [database, schema, table]) registry.upsertResource(item);
    registry.upsertRelation(relation(database, schema));
    registry.upsertRelation(relation(schema, table));

    expect(registry.relationsFor(schema.id)).toHaveLength(2);
    expect(registry.relationsFor(schema.id, { direction: 'outgoing' })).toHaveLength(1);
    expect(registry.neighbors(schema.id).map((item) => item.id)).toEqual(
      expect.arrayContaining([database.id, table.id]),
    );
    expect(
      registry.query({ parentResourceId: schema.id, kinds: ['table'] }).items.map((item) => item.id),
    ).toEqual([table.id]);
    expect(() =>
      registry.upsertRelation({
        ...relation(schema, table),
        id: 'self',
        fromResourceId: schema.id,
        toResourceId: schema.id,
      }),
    ).toThrow(ResourceConflictError);
    expect(() =>
      registry.upsertRelation({
        ...relation(schema, table),
        id: 'unknown',
        toResourceId: 'missing',
      }),
    ).toThrow(ResourceConflictError);
  });

  it('supports filters, stable cursor pagination, deletion and text/scope lookup', () => {
    const registry = new ResourceRegistry();
    for (let index = 0; index < 7; index += 1) {
      registry.upsertResource(
        resource(`db.public.table_${index}`, index === 6 ? 'view' : 'table', {
          displayName: index === 3 ? 'Important Orders' : `Table ${index}`,
          scope: { projectId: index < 4 ? 'a' : 'b' },
        }),
      );
    }
    const first = registry.query({
      kinds: ['table'],
      engine: 'mock',
      scope: { projectId: 'a' },
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = registry.query({
      kinds: ['table'],
      engine: 'mock',
      scope: { projectId: 'a' },
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(registry.query({ text: 'important' }).items).toHaveLength(1);
    const deleted = first.items[0]!;
    expect(registry.markResourceDeleted(deleted.id)).toBe(true);
    expect(registry.getResource(deleted.id)).toBeUndefined();
    expect(registry.getResource(deleted.id, true)?.deletedAt).toBeTruthy();
    expect(registry.query({ includeDeleted: true, ids: [deleted.id] }).items).toHaveLength(1);
    expect(registry.markResourceDeleted('missing')).toBe(false);
    expect(() => registry.query({ cursor: 'bad' })).toThrow(ResourceConflictError);
  });

  it('tracks current and expired observations separately', () => {
    const registry = new ResourceRegistry();
    const table = resource('db.public.orders');
    registry.upsertResource(table);
    const observations: ResourceObservation[] = [
      {
        id: 'old',
        resourceId: table.id,
        category: 'capacity',
        status: 'healthy',
        observedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-07-23T00:00:10.000Z',
        source,
      },
      {
        id: 'new',
        resourceId: table.id,
        category: 'capacity',
        status: 'degraded',
        observedAt: '2026-07-23T00:01:00.000Z',
        expiresAt: '2026-07-23T00:02:00.000Z',
        source,
      },
    ];
    observations.forEach((item) => registry.addObservation(item));
    expect(
      registry.observationsFor(table.id, { at: '2026-07-23T00:01:30.000Z' }).map((item) => item.id),
    ).toEqual(['new']);
    expect(
      registry.observationsFor(table.id, {
        at: '2026-07-23T00:01:30.000Z',
        includeExpired: true,
        category: 'capacity',
      }),
    ).toHaveLength(2);
    expect(() =>
      registry.addObservation({ ...observations[0]!, id: 'missing', resourceId: 'missing' }),
    ).toThrow(ResourceConflictError);
  });

  it('applies discovery pages and idempotent incremental change sets without rebuilding', () => {
    const registry = new ResourceRegistry();
    const database = resource('db', 'database');
    const schema = resource('db.public', 'schema');
    expect(
      registry.applyDiscoveryPage({
        resources: [database, schema],
        relations: [relation(database, schema)],
        complete: true,
      }),
    ).toEqual({ resources: 2, relations: 1, observations: 0 });
    const table = resource('db.public.orders');
    const change = {
      sourceId: 'test',
      version: '2',
      observedAt: time,
      upsertResources: [table],
      upsertRelations: [relation(schema, table)],
    };
    expect(registry.applyChangeSet(change)).toMatchObject({
      upsertedResources: 1,
      upsertedRelations: 1,
    });
    expect(registry.applyChangeSet(change)).toEqual({
      upsertedResources: 0,
      deletedResources: 0,
      restoredResources: 0,
      upsertedRelations: 0,
      deletedRelations: 0,
      observations: 0,
      ignored: true,
    });
    const beforeSize = registry.size;
    registry.applyChangeSet({
      sourceId: 'test',
      version: '3',
      observedAt: '2026-07-23T00:03:00.000Z',
      deleteResourceIds: [table.id],
      deleteRelationIds: [relation(schema, table).id],
    });
    expect(registry.size).toBe(beforeSize);
    expect(registry.getResource(table.id)).toBeUndefined();
    expect(registry.getRelation(relation(schema, table).id)).toBeUndefined();
  });

  it('manually binds duplicate resources and redirects graph edges', () => {
    const registry = new ResourceRegistry();
    const database = resource('db', 'database');
    const primary = resource('db.public.orders');
    const duplicate = resource('db.public.orders_alias', 'table', {
      id: 'duplicate',
      attributes: { discoveredBy: 'cloud' },
    });
    for (const item of [database, primary, duplicate]) registry.upsertResource(item);
    registry.upsertRelation(relation(database, duplicate));
    const merged = registry.bindResources(primary.id, duplicate.id, {
      sourceId: 'operator',
      sourceType: 'manual',
      observedAt: '2026-07-23T00:05:00.000Z',
    });
    expect(merged.aliases).toEqual(expect.arrayContaining([duplicate.nativeId]));
    expect(merged.attributes).toMatchObject({ discoveredBy: 'cloud' });
    expect(registry.getResource(duplicate.id)).toBeUndefined();
    expect(registry.neighbors(database.id).map((item) => item.id)).toContain(primary.id);
    expect(() =>
      registry.bindResources(primary.id, resource('other', 'view').id, source),
    ).toThrow(ResourceConflictError);
  });

  it('round-trips snapshots and clears all indexes', () => {
    const registry = new ResourceRegistry();
    const database = resource('db', 'database');
    const schema = resource('db.public', 'schema');
    registry.applyDiscoveryPage({
      resources: [database, schema],
      relations: [relation(database, schema)],
      complete: true,
    });
    registry.addObservation({
      id: 'health',
      resourceId: database.id,
      category: 'health',
      status: 'healthy',
      observedAt: time,
      expiresAt: '2099-01-01T00:00:00.000Z',
      source,
    });
    registry.applyChangeSet({ sourceId: 'x', version: '1', observedAt: time });
    const snapshot = registry.snapshot();

    const restored = new ResourceRegistry();
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    restored.clear();
    expect(restored.size).toBe(0);
    expect(restored.relationCount).toBe(0);
    expect(restored.observationsFor(database.id)).toEqual([]);
  });
});
