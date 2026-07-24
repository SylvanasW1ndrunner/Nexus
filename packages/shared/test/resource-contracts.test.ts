import { describe, expect, it } from 'vitest';
import {
  ContractValidationError,
  assertResourceChangeSet,
  assertResourceDescriptor,
  assertResourceObservation,
  assertResourceRegistrySnapshot,
  assertResourceRelation,
  type ResourceDescriptor,
  type ResourceSource,
} from '../src/index.js';

const time = '2026-07-23T00:00:00.000Z';
const source: ResourceSource = {
  sourceId: 'connector',
  sourceType: 'connector',
  observedAt: time,
  priority: 10,
};

function resource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: 'resource-1',
    kind: 'table',
    nativeId: 'public.orders',
    canonicalName: 'orders',
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: [source],
    ...overrides,
  };
}

describe('resource public contracts', () => {
  it('validates current resource facts, scope and provenance', () => {
    expect(() =>
      assertResourceDescriptor(
        resource({
          scope: { tenantId: 'team-a', environment: 'production' },
          attributes: { estimatedRows: 1000 },
          facts: {
            owner: [
              {
                value: 'data-team',
                source,
                confidence: 0.9,
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects invalid versions, chronology, facts and secret attributes', () => {
    const invalid = [
      resource({ version: 0 }),
      resource({ updatedAt: '2026-07-22T23:59:59.000Z' }),
      resource({ facts: { owner: [] } }),
      resource({ facts: { owner: [{ value: 'x', source, confidence: 2 }] } }),
      resource({ attributes: { password: 'do-not-return' } }),
    ];
    invalid.forEach((item) => {
      expect(() => assertResourceDescriptor(item)).toThrowError(
        ContractValidationError,
      );
    });
  });

  it('validates relation identity and observation freshness', () => {
    expect(() =>
      assertResourceRelation({
        id: 'relation-1',
        kind: 'contains',
        fromResourceId: 'database-1',
        toResourceId: 'resource-1',
        version: 1,
        firstSeenAt: time,
        updatedAt: time,
        sources: [source],
      }),
    ).not.toThrow();
    expect(() =>
      assertResourceRelation({
        id: 'relation-1',
        kind: 'contains',
        fromResourceId: 'resource-1',
        toResourceId: 'resource-1',
        version: 1,
        firstSeenAt: time,
        updatedAt: time,
        sources: [source],
      }),
    ).toThrowError(ContractValidationError);

    expect(() =>
      assertResourceObservation({
        id: 'observation-1',
        resourceId: 'resource-1',
        category: 'health',
        status: 'healthy',
        observedAt: time,
        expiresAt: '2026-07-23T00:01:00.000Z',
        source,
      }),
    ).not.toThrow();
    expect(
      captureContractFailure(() =>
        assertResourceObservation({
          id: 'observation-1',
          resourceId: 'resource-1',
          category: 'health',
          status: 'healthy',
          observedAt: time,
          expiresAt: time,
          source,
        }),
      ).issues[0],
    ).toMatchObject({ path: '$.expiresAt' });
  });

  it('rejects duplicate and contradictory incremental changes', () => {
    expect(
      captureContractFailure(() =>
        assertResourceChangeSet({
          sourceId: 'connector',
          version: '2',
          sequence: 2,
          observedAt: time,
          upsertResources: [resource(), resource()],
        }),
      ).issues[0],
    ).toMatchObject({ path: '$.upsertResources[1]' });
    expect(() =>
      assertResourceChangeSet({
        sourceId: 'connector',
        version: '2',
        sequence: -1,
        observedAt: time,
      }),
    ).toThrowError(ContractValidationError);
  });

  it('rejects secret material in snapshot metadata and events', () => {
    const baseSnapshot = {
      contractVersion: '1.0',
      createdAt: time,
      resources: [resource()],
      relations: [],
      observations: [],
      events: [],
      sourceVersions: {},
      lastEventSequence: 0,
    };

    expect(() =>
      assertResourceRegistrySnapshot({
        ...baseSnapshot,
        apiKey: 'should-never-be-persisted',
      }),
    ).toThrowError(ContractValidationError);
    expect(() =>
      assertResourceRegistrySnapshot({
        ...baseSnapshot,
        events: [
          {
            id: 'event-1',
            sequence: 1,
            type: 'resource-upserted',
            occurredAt: time,
            source,
            resourceId: 'resource-1',
            attributes: { password: 'should-never-be-persisted' },
          },
        ],
        lastEventSequence: 1,
      }),
    ).toThrowError(ContractValidationError);
  });
});

function captureContractFailure(operation: () => void): ContractValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ContractValidationError) return error;
    throw error;
  }
  throw new Error('Expected ContractValidationError');
}
