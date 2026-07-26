import { describe, expect, it } from 'vitest';
import { ResourceConflictError, ResourceRegistry } from '../src/index.js';
import { testObservation, testRelation, testResource, testSource } from './test-helpers.js';

describe('resource graph, lifecycle and scope isolation', () => {
  it('rejects direct and batched contains cycles without partial writes', () => {
    const registry = new ResourceRegistry();
    const database = testResource('db', 'database');
    const schema = testResource('db.public', 'schema');
    const table = testResource('db.public.orders');
    for (const item of [database, schema, table]) registry.upsertResource(item);
    registry.upsertRelation(testRelation(database, schema));
    registry.upsertRelation(testRelation(schema, table));

    expect(
      captureResourceFailure(() => registry.upsertRelation(testRelation(table, database))).code,
    ).toBe('RELATION_CYCLE');

    const view = testResource('db.public.orders_view', 'view');
    expect(() =>
      registry.applyDiscoveryPage({
        resources: [view],
        relations: [testRelation(table, view), testRelation(view, database)],
        complete: true,
      }),
    ).toThrowError(ResourceConflictError);
    expect(registry.getResource(view.id)).toBeUndefined();
  });

  it('traverses cyclic dependency graphs once and enforces result limits', () => {
    const registry = new ResourceRegistry();
    const resources = Array.from({ length: 6 }, (_, index) => testResource(`table-${index}`));
    resources.forEach((resource) => registry.upsertResource(resource));
    for (let index = 0; index < resources.length; index += 1) {
      registry.upsertRelation(
        testRelation(resources[index]!, resources[(index + 1) % resources.length]!, 'depends_on'),
      );
    }

    const complete = registry.traverse({
      startResourceIds: [resources[0]!.id],
      relationKinds: ['depends_on'],
      direction: 'both',
      maxDepth: 10,
      maxResources: 10,
    });
    expect(complete.nodes).toHaveLength(6);
    expect(new Set(complete.nodes.map((item) => item.resource.id)).size).toBe(6);
    expect(complete.truncated).toBe(false);

    const limited = registry.traverse({
      startResourceIds: [resources[0]!.id],
      relationKinds: ['depends_on'],
      direction: 'both',
      maxDepth: 10,
      maxResources: 3,
    });
    expect(limited.nodes).toHaveLength(3);
    expect(limited.truncated).toBe(true);
    expect(
      captureResourceFailure(() =>
        registry.traverse({
          startResourceIds: [resources[0]!.id],
          maxDepth: 33,
          maxResources: 10,
        }),
      ).code,
    ).toBe('TRAVERSAL_LIMIT_INVALID');
  });

  it('cannot cross tenant scope through graph relations', () => {
    const registry = new ResourceRegistry();
    const teamA = testResource('team-a.table', 'table', {
      scope: { tenantId: 'team-a', environment: 'production' },
    });
    const teamB = testResource('team-b.table', 'table', {
      scope: { tenantId: 'team-b', environment: 'production' },
    });
    registry.upsertResource(teamA);
    registry.upsertResource(teamB);
    registry.upsertRelation(testRelation(teamA, teamB, 'depends_on'));

    expect(registry.query({ scope: { tenantId: 'team-a' } }).items.map((item) => item.id)).toEqual([
      teamA.id,
    ]);
    const graph = registry.traverse({
      startResourceIds: [teamA.id],
      direction: 'both',
      scope: { tenantId: 'team-a' },
      maxDepth: 2,
      maxResources: 10,
    });
    expect(graph.nodes.map((item) => item.resource.id)).toEqual([teamA.id]);
    expect(graph.relations).toEqual([]);
  });

  it('keeps direct resource, state, observation and event reads inside an explicit scoped view', () => {
    const registry = new ResourceRegistry({
      now: () => '2026-07-23T00:05:00.000Z',
    });
    const teamA = testResource('team-a.table', 'table', {
      scope: {
        tenantId: 'team-a',
        projectId: 'analytics',
        environment: 'production',
      },
    });
    const teamB = testResource('team-b.table', 'table', {
      scope: {
        tenantId: 'team-b',
        projectId: 'analytics',
        environment: 'production',
      },
    });
    registry.upsertResource(teamA);
    registry.upsertResource(teamB);
    registry.addObservation(testObservation(teamA.id, 'team-a-health'));
    registry.addObservation(testObservation(teamB.id, 'team-b-health'));

    const resources = registry.scoped({
      tenantId: 'team-a',
      projectId: 'analytics',
      environment: 'production',
    });

    expect(resources.getResource(teamA.id)?.id).toBe(teamA.id);
    expect(resources.getResource(teamB.id)).toBeUndefined();
    expect(resources.state(teamA.id)?.resourceId).toBe(teamA.id);
    expect(resources.state(teamB.id)).toBeUndefined();
    expect(
      resources
        .observationsFor(teamA.id, {
          includeExpired: true,
          at: '2026-07-23T00:05:00.000Z',
        })
        .map((item) => item.id),
    ).toEqual(['team-a-health']);
    expect(
      resources.observationsFor(teamB.id, {
        includeExpired: true,
        at: '2026-07-23T00:05:00.000Z',
      }),
    ).toEqual([]);
    expect(resources.events({ limit: 100 }).items.length).toBeGreaterThan(0);
    expect(
      resources
        .events({ limit: 100 })
        .items.some(
          (event) => event.resourceId === teamB.id || event.relatedResourceId === teamB.id,
        ),
    ).toBe(false);
    expect(resources.events({ resourceId: teamB.id, limit: 100 }).items).toEqual([]);
  });

  it('rejects reuse of a resource ID across scopes without merging tenant data', () => {
    const registry = new ResourceRegistry();
    const tenantA = testResource('orders', 'table', {
      id: 'shared-resource-id',
      scope: { tenantId: 'tenant-a', projectId: 'analytics' },
      attributes: { owner: 'tenant-a' },
    });
    const tenantB = testResource('orders', 'table', {
      id: 'shared-resource-id',
      scope: { tenantId: 'tenant-b', projectId: 'analytics' },
      attributes: { tenantMarker: 'tenant-b-only' },
    });
    registry.upsertResource(tenantA);

    expect(captureResourceFailure(() => registry.upsertResource(tenantB)).message).toContain(
      'scope',
    );
    expect(registry.scoped(tenantA.scope!).getResource(tenantA.id)).toMatchObject({
      attributes: { owner: 'tenant-a' },
    });
    expect(registry.scoped(tenantA.scope!).getResource(tenantA.id)?.attributes).not.toHaveProperty(
      'tenantMarker',
    );
    expect(registry.scoped(tenantB.scope!).getResource(tenantB.id)).toBeUndefined();
  });

  it('hides relations to deleted resources and restores them explicitly', () => {
    const registry = new ResourceRegistry();
    const schema = testResource('public', 'schema');
    const table = testResource('public.orders');
    registry.upsertResource(schema);
    registry.upsertResource(table);
    registry.upsertRelation(testRelation(schema, table));

    registry.markResourceDeleted(
      table.id,
      '2026-07-23T00:01:00.000Z',
      testSource('operator', {
        sourceType: 'manual',
        observedAt: '2026-07-23T00:01:00.000Z',
      }),
    );
    expect(registry.relationsFor(schema.id)).toEqual([]);
    expect(registry.relationsFor(schema.id, { includeDeleted: true })).toHaveLength(1);
    expect(registry.restoreResource(table.id, '2026-07-23T00:02:00.000Z')).toBe(true);
    expect(registry.relationsFor(schema.id)).toHaveLength(1);
    expect(registry.events({ resourceId: table.id }).items.map((item) => item.type)).toEqual(
      expect.arrayContaining(['resource-deleted', 'resource-restored']),
    );
  });

  it('uses identity cursors that remain stable when an earlier ID is inserted', () => {
    const registry = new ResourceRegistry();
    const items = ['b', 'c', 'd'].map((id) => testResource(id, 'table', { id: `resource-${id}` }));
    items.forEach((item) => registry.upsertResource(item));
    const first = registry.query({ limit: 2 });
    registry.upsertResource(testResource('a', 'table', { id: 'resource-a' }));
    const second = registry.query({ limit: 2, cursor: first.nextCursor! });

    expect(first.items.map((item) => item.id)).toEqual(['resource-b', 'resource-c']);
    expect(second.items.map((item) => item.id)).toEqual(['resource-d']);
    expect(
      captureResourceFailure(() => registry.query({ cursor: 'not-a-canonical-cursor' })).code,
    ).toBe('INVALID_CURSOR');
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
