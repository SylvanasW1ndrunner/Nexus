import { hashCanonical } from './merkle-catalog.js';
import type {
  EmbeddingProfile,
  KnowledgeCatalog,
  SchemaRagDocument,
  SchemaRagEmbeddingAdapter,
  SchemaRagIndexManifest,
  SchemaRagRetrievalProfile,
} from './types.js';

export const DEFAULT_RETRIEVAL_PROFILE: SchemaRagRetrievalProfile = {
  id: 'builtin-memory-hybrid',
  version: 1,
  backend: {
    type: 'memory',
    bm25K1: 1.2,
    bm25B: 0.75,
  },
  defaultLimit: 8,
  defaultMaxContextTokens: 1_500,
  graphHops: 1,
  rrfK: 60,
};

export function normalizeRetrievalProfile(
  profile: SchemaRagRetrievalProfile = DEFAULT_RETRIEVAL_PROFILE,
): SchemaRagRetrievalProfile {
  if (!profile.id.trim()) throw new Error('Retrieval profile id is required.');
  if (!Number.isSafeInteger(profile.version) || profile.version < 1) {
    throw new Error('Retrieval profile version must be a positive integer.');
  }
  if (profile.backend.type !== 'memory') {
    throw new Error(`Unsupported retrieval backend: ${profile.backend.type}`);
  }
  if (profile.embedding) validateEmbeddingProfile(profile.embedding);
  return {
    ...structuredClone(profile),
    backend: {
      ...profile.backend,
      bm25K1: positiveNumber(profile.backend.bm25K1, 1.2),
      bm25B: boundedNumber(profile.backend.bm25B, 0.75, 0, 1),
    },
    defaultLimit: positiveInteger(profile.defaultLimit, 8),
    defaultMaxContextTokens: positiveInteger(
      profile.defaultMaxContextTokens,
      1_500,
    ),
    graphHops: nonNegativeInteger(profile.graphHops, 1),
    rrfK: positiveInteger(profile.rrfK, 60),
  };
}

export function embeddingFingerprint(profile: EmbeddingProfile): string {
  validateEmbeddingProfile(profile);
  return hashCanonical({
    providerInstanceId: profile.providerInstanceId,
    modelId: profile.modelId,
    modelRevision: profile.modelRevision ?? null,
    dimensions: profile.dimensions ?? null,
    normalization: profile.normalization,
    distanceMetric: profile.distanceMetric,
    requestTemplateVersion: profile.requestTemplateVersion,
  });
}

export function createSchemaRagIndexManifest(input: {
  catalog: KnowledgeCatalog;
  profile: SchemaRagRetrievalProfile;
  documentCount: number;
  createdAt?: string;
}): SchemaRagIndexManifest {
  const profile = normalizeRetrievalProfile(input.profile);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const fingerprint = profile.embedding
    ? embeddingFingerprint(profile.embedding)
    : undefined;
  return {
    version: 1,
    connectionId: input.catalog.connectionId,
    catalogRootHash: input.catalog.catalogRootHash,
    retrievalProfileId: profile.id,
    retrievalProfileVersion: profile.version,
    ...(fingerprint === undefined ? {} : { embeddingFingerprint: fingerprint }),
    documentCount: input.documentCount,
    indexVersion: hashCanonical({
      catalogRootHash: input.catalog.catalogRootHash,
      profileId: profile.id,
      profileVersion: profile.version,
      backend: profile.backend,
      embeddingFingerprint: fingerprint ?? null,
      documentCount: input.documentCount,
    }),
    createdAt,
  };
}

export function compareIndexManifest(
  manifest: SchemaRagIndexManifest,
  input: {
    catalog: KnowledgeCatalog;
    profile: SchemaRagRetrievalProfile;
    documentCount: number;
  },
): {
  compatible: boolean;
  rebuildLexical: boolean;
  rebuildVector: boolean;
  reasons: string[];
} {
  const expected = createSchemaRagIndexManifest({
    ...input,
    createdAt: manifest.createdAt,
  });
  const reasons: string[] = [];
  const catalogChanged = manifest.catalogRootHash !== expected.catalogRootHash;
  const profileChanged =
    manifest.retrievalProfileId !== expected.retrievalProfileId ||
    manifest.retrievalProfileVersion !== expected.retrievalProfileVersion;
  const documentCountChanged = manifest.documentCount !== expected.documentCount;
  const embeddingChanged =
    manifest.embeddingFingerprint !== expected.embeddingFingerprint;
  if (catalogChanged) reasons.push('catalog-root-changed');
  if (profileChanged) reasons.push('retrieval-profile-changed');
  if (documentCountChanged) reasons.push('document-count-changed');
  if (embeddingChanged) reasons.push('embedding-fingerprint-changed');
  return {
    compatible: reasons.length === 0,
    rebuildLexical: catalogChanged || profileChanged || documentCountChanged,
    rebuildVector:
      catalogChanged || profileChanged || documentCountChanged || embeddingChanged,
    reasons,
  };
}

export async function buildDocumentVectors(input: {
  documents: SchemaRagDocument[];
  profile: EmbeddingProfile;
  adapter: SchemaRagEmbeddingAdapter;
  batchSize?: number;
}): Promise<Record<string, number[]>> {
  validateEmbeddingProfile(input.profile);
  const batchSize = positiveInteger(input.batchSize, 32);
  const result: Record<string, number[]> = {};
  for (let offset = 0; offset < input.documents.length; offset += batchSize) {
    const batch = input.documents.slice(offset, offset + batchSize);
    const vectors = await input.adapter.embed({
      profile: input.profile,
      texts: batch.map((document) => `${document.title}\n${document.text}`),
    });
    if (vectors.length !== batch.length) {
      throw new Error('Embedding adapter returned an unexpected vector count.');
    }
    vectors.forEach((vector, index) => {
      validateVector(vector, input.profile.dimensions);
      result[batch[index]!.id] = normalizeVector(vector, input.profile.normalization);
    });
  }
  return result;
}

export function normalizeVector(
  vector: number[],
  normalization: EmbeddingProfile['normalization'],
): number[] {
  if (normalization === 'none') return [...vector];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}

function validateEmbeddingProfile(profile: EmbeddingProfile): void {
  if (!profile.providerInstanceId.trim()) {
    throw new Error('Embedding provider instance id is required.');
  }
  if (!profile.modelId.trim()) throw new Error('Embedding model id is required.');
  if (!profile.requestTemplateVersion.trim()) {
    throw new Error('Embedding request template version is required.');
  }
  if (
    profile.dimensions !== undefined &&
    (!Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1)
  ) {
    throw new Error('Embedding dimensions must be a positive integer.');
  }
}

function validateVector(vector: number[], expectedDimensions: number | undefined): void {
  if (
    vector.length === 0 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Embedding adapter returned an invalid vector.');
  }
  if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
    throw new Error(
      `Embedding vector dimensions mismatch: expected ${expectedDimensions}, received ${vector.length}.`,
    );
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
