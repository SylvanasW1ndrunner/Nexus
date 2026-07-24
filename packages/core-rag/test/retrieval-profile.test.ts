import { describe, expect, it, vi } from 'vitest';
import type { ResourceDescriptor, ResourceRelation } from '@dbagent/shared';
import {
  compareIndexManifest,
  createSchemaRagIndexManifest,
  embeddingFingerprint,
  SchemaRagEngine,
  type SchemaRagEmbeddingAdapter,
  type SchemaRagRetrievalProfile,
} from '../src/index.js';

const profile: SchemaRagRetrievalProfile = {
  id: 'siliconflow-bilingual',
  version: 1,
  backend: { type: 'memory' },
  embedding: {
    providerInstanceId: 'siliconflow-main',
    modelId: 'BAAI/bge-m3',
    modelRevision: '2026-07',
    dimensions: 2,
    normalization: 'l2',
    distanceMetric: 'cosine',
    requestTemplateVersion: 'v1',
  },
  reranker: {
    providerInstanceId: 'siliconflow-main',
    modelId: 'BAAI/bge-reranker-v2-m3',
    topN: 8,
  },
  defaultLimit: 5,
  defaultMaxContextTokens: 500,
  graphHops: 1,
  rrfK: 20,
};

describe('configurable schema retrieval', () => {
  it('uses the configured embedding provider for Chinese questions over English schema keys', async () => {
    const embed = vi.fn<SchemaRagEmbeddingAdapter['embed']>(({ texts }) =>
      Promise.resolve(texts.map(vectorForText)),
    );
    const rerank = vi.fn(
      ({ documents }: { documents: Array<{ id: string }> }) =>
        Promise.resolve(
          documents.map((document, index) => ({
            id: document.id,
            score: document.id.includes('revenue') ? 100 : 1 / (index + 1),
          })),
        ),
    );
    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: { embed },
      rerankAdapter: { rerank },
    });
    await engine.indexAsync({
      connectionId: 'analytics',
      resources: resources(),
      relations: relations(),
      indexedAt: '2026-07-24T00:00:00.000Z',
    });

    const results = await engine.searchAsync({
      connectionId: 'analytics',
      query: '按月统计营收',
      limit: 4,
      includeRelations: true,
    });

    expect(results[0]?.document.id).toBe('column:analytics.monthly_metrics.revenue');
    expect(results[0]?.reasons).toEqual(
      expect.arrayContaining(['channel:vector', 'channel:rerank']),
    );
    const firstEmbeddingInput = embed.mock.calls[0]?.[0];
    expect(firstEmbeddingInput?.profile.providerInstanceId).toBe(
      'siliconflow-main',
    );
    expect(firstEmbeddingInput?.profile.modelId).toBe('BAAI/bge-m3');
    expect(rerank).toHaveBeenCalledOnce();
  });

  it('fingerprints model compatibility and distinguishes lexical/vector rebuilds', async () => {
    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: {
        embed: ({ texts }) => Promise.resolve(texts.map(vectorForText)),
      },
    });
    const index = await engine.indexAsync({
      connectionId: 'analytics',
      resources: resources(),
      relations: relations(),
      indexedAt: '2026-07-24T00:00:00.000Z',
    });
    const catalog = index.catalog!;
    const manifest = index.manifest!;

    expect(manifest.embeddingFingerprint).toBe(
      embeddingFingerprint(profile.embedding!),
    );
    expect(
      compareIndexManifest(manifest, {
        catalog,
        profile,
        documentCount: index.documents.length,
      }),
    ).toMatchObject({
      compatible: true,
      rebuildLexical: false,
      rebuildVector: false,
    });

    const changedEmbedding = {
      ...profile,
      embedding: { ...profile.embedding!, modelRevision: '2026-08' },
    };
    const compatibility = compareIndexManifest(manifest, {
      catalog,
      profile: changedEmbedding,
      documentCount: index.documents.length,
    });
    expect(compatibility).toMatchObject({
      compatible: false,
      rebuildLexical: false,
      rebuildVector: true,
      reasons: ['embedding-fingerprint-changed'],
    });

    const changedCatalogManifest = createSchemaRagIndexManifest({
      catalog: { ...catalog, catalogRootHash: 'changed-root' },
      profile,
      documentCount: index.documents.length,
      createdAt: manifest.createdAt,
    });
    expect(changedCatalogManifest.indexVersion).not.toBe(manifest.indexVersion);
  });

  it('enforces embedding dimensions and retrieval token budgets', async () => {
    const invalid = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: {
        embed: ({ texts }) =>
          Promise.resolve(texts.map(() => [1, 0, 0])),
      },
    });
    await expect(
      invalid.indexAsync({
        connectionId: 'analytics',
        resources: resources(),
        relations: relations(),
      }),
    ).rejects.toThrow('dimensions mismatch');

    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: {
        embed: ({ texts }) => Promise.resolve(texts.map(vectorForText)),
      },
    });
    await engine.indexAsync({
      connectionId: 'analytics',
      resources: resources(),
      relations: relations(),
    });
    const results = await engine.searchAsync({
      connectionId: 'analytics',
      query: '营收',
      limit: 20,
      maxContextTokens: 1,
    });
    expect(results).toHaveLength(1);
  });
});

function vectorForText(text: string): number[] {
  const normalized = text.toLowerCase();
  if (
    normalized.includes('营收') ||
    normalized.includes('revenue') ||
    normalized.includes('amount')
  ) {
    return [1, 0];
  }
  return [0, 1];
}

function resources(): ResourceDescriptor[] {
  const time = '2026-07-24T00:00:00.000Z';
  const source = [
    {
      sourceId: 'fixture',
      sourceType: 'connector' as const,
      connectionProfileId: 'analytics',
      observedAt: time,
    },
  ];
  return [
    {
      id: 'database:analytics',
      kind: 'database',
      nativeId: 'analytics',
      canonicalName: 'analytics',
      displayName: 'analytics',
      version: 1,
      firstSeenAt: time,
      updatedAt: time,
      sources: source,
    },
    {
      id: 'schema:analytics',
      kind: 'schema',
      nativeId: 'analytics',
      canonicalName: 'analytics',
      displayName: 'analytics',
      version: 1,
      firstSeenAt: time,
      updatedAt: time,
      sources: source,
    },
    {
      id: 'table:analytics.monthly_metrics',
      kind: 'table',
      nativeId: 'analytics.monthly_metrics',
      canonicalName: 'analytics.monthly_metrics',
      displayName: 'monthly_metrics',
      attributes: { schema: 'analytics', table: 'monthly_metrics' },
      version: 1,
      firstSeenAt: time,
      updatedAt: time,
      sources: source,
    },
    {
      id: 'column:analytics.monthly_metrics.revenue',
      kind: 'column',
      nativeId: 'analytics.monthly_metrics.revenue',
      canonicalName: 'analytics.monthly_metrics.revenue',
      displayName: 'revenue',
      attributes: {
        schema: 'analytics',
        table: 'monthly_metrics',
        column: 'revenue',
        dataType: 'numeric',
      },
      version: 1,
      firstSeenAt: time,
      updatedAt: time,
      sources: source,
    },
    {
      id: 'column:analytics.monthly_metrics.active_users',
      kind: 'column',
      nativeId: 'analytics.monthly_metrics.active_users',
      canonicalName: 'analytics.monthly_metrics.active_users',
      displayName: 'active_users',
      attributes: {
        schema: 'analytics',
        table: 'monthly_metrics',
        column: 'active_users',
        dataType: 'integer',
      },
      version: 1,
      firstSeenAt: time,
      updatedAt: time,
      sources: source,
    },
  ];
}

function relations(): ResourceRelation[] {
  const time = '2026-07-24T00:00:00.000Z';
  const source = [
    {
      sourceId: 'fixture',
      sourceType: 'connector' as const,
      connectionProfileId: 'analytics',
      observedAt: time,
    },
  ];
  const create = (
    id: string,
    fromResourceId: string,
    toResourceId: string,
  ): ResourceRelation => ({
    id,
    kind: 'contains',
    fromResourceId,
    toResourceId,
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: source,
  });
  return [
    create('contains:database-schema', 'database:analytics', 'schema:analytics'),
    create(
      'contains:schema-table',
      'schema:analytics',
      'table:analytics.monthly_metrics',
    ),
    create(
      'contains:table-revenue',
      'table:analytics.monthly_metrics',
      'column:analytics.monthly_metrics.revenue',
    ),
    create(
      'contains:table-users',
      'table:analytics.monthly_metrics',
      'column:analytics.monthly_metrics.active_users',
    ),
  ];
}
