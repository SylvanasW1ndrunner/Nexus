import type {
  ResourceDescriptor,
  ResourceObservation,
  ResourceRelation,
  ResourceSource,
} from '@dbagent/shared';
import {
  createStableRelationId,
  createStableResourceId,
} from '../src/index.js';

export const testTime = '2026-07-23T00:00:00.000Z';

export function testSource(
  sourceId = 'test-connector',
  overrides: Partial<ResourceSource> = {},
): ResourceSource {
  return {
    sourceId,
    sourceType: 'connector',
    observedAt: testTime,
    ...overrides,
  };
}

export function testResource(
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
    firstSeenAt: testTime,
    updatedAt: testTime,
    sources: [testSource()],
    ...overrides,
  };
}

export function testRelation(
  from: ResourceDescriptor,
  to: ResourceDescriptor,
  kind = 'contains',
  overrides: Partial<ResourceRelation> = {},
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
    firstSeenAt: testTime,
    updatedAt: testTime,
    sources: [testSource()],
    ...overrides,
  };
}

export function testObservation(
  resourceId: string,
  id: string,
  overrides: Partial<ResourceObservation> = {},
): ResourceObservation {
  return {
    id,
    resourceId,
    category: 'health',
    status: 'healthy',
    observedAt: testTime,
    expiresAt: '2026-07-23T00:10:00.000Z',
    source: testSource(),
    ...overrides,
  };
}
