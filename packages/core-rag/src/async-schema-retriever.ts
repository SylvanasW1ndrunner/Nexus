import { searchSchemaRagIndex } from './hybrid-schema-retriever.js';
import { normalizeVector } from './retrieval-profile.js';
import type {
  SchemaRagDocument,
  SchemaRagEmbeddingAdapter,
  SchemaRagIndex,
  SchemaRagRerankAdapter,
  SchemaRagRetrievalProfile,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
} from './types.js';

export async function searchSchemaRagIndexAsync(input: {
  index: SchemaRagIndex;
  request: SchemaRagSearchRequest;
  profile: SchemaRagRetrievalProfile;
  embeddingAdapter?: SchemaRagEmbeddingAdapter;
  rerankAdapter?: SchemaRagRerankAdapter;
}): Promise<SchemaRagSearchResult[]> {
  const candidateLimit = Math.max(input.request.limit ?? 8, 8) * 3;
  const lexical = searchSchemaRagIndex(input.index, {
    ...input.request,
    limit: candidateLimit,
    maxContextTokens: Number.MAX_SAFE_INTEGER,
  });
  let fused = lexical;

  if (
    input.profile.embedding &&
    input.embeddingAdapter &&
    input.index.vectors &&
    Object.keys(input.index.vectors).length > 0
  ) {
    const response = await input.embeddingAdapter.embed({
      profile: input.profile.embedding,
      texts: [input.request.query],
    });
    const queryVector = response[0];
    if (!queryVector) throw new Error('Embedding adapter did not return a query vector.');
    const normalized = normalizeVector(
      queryVector,
      input.profile.embedding.normalization,
    );
    const vectorResults = vectorSearch(
      input.index,
      normalized,
      input.profile.embedding.distanceMetric,
      candidateLimit,
    );
    fused = reciprocalRankFusion(
      input.index,
      lexical,
      vectorResults,
      input.profile.rrfK ?? 60,
    );
  }

  if (input.profile.reranker && input.rerankAdapter && fused.length > 1) {
    const reranked = await input.rerankAdapter.rerank({
      profile: input.profile.reranker,
      query: input.request.query,
      documents: fused.map((result) => ({
        id: result.document.id,
        text: `${result.document.title}\n${result.document.text}`,
      })),
    });
    const scores = new Map(reranked.map((item) => [item.id, item.score]));
    fused = fused
      .map((result) => {
        const score = scores.get(result.document.id);
        if (score === undefined) return result;
        return {
          ...result,
          score: result.score + score,
          reasons: [...result.reasons, 'channel:rerank'],
          scoreDetails: [
            ...(result.scoreDetails ?? []),
            {
              channel: 'rerank' as const,
              score,
              reasons: ['configured-reranker'],
            },
          ],
        };
      })
      .sort(compareResults);
  }

  return applyContextLimit(
    fused.slice(0, input.request.limit ?? input.profile.defaultLimit ?? 8),
    input.request.maxContextTokens ??
      input.profile.defaultMaxContextTokens ??
      Number.MAX_SAFE_INTEGER,
  );
}

function vectorSearch(
  index: SchemaRagIndex,
  queryVector: number[],
  metric: 'cosine' | 'dot' | 'euclidean',
  limit: number,
): SchemaRagSearchResult[] {
  const documents = new Map(index.documents.map((document) => [document.id, document]));
  return Object.entries(index.vectors ?? {})
    .map<SchemaRagSearchResult | undefined>(([id, vector]) => {
      const document = documents.get(id);
      if (!document || vector.length !== queryVector.length) return undefined;
      const score = vectorSimilarity(queryVector, vector, metric);
      return {
        document,
        score,
        reasons: ['channel:vector'],
        scoreDetails: [
          {
            channel: 'vector' as const,
            score,
            reasons: [`distance:${metric}`],
          },
        ],
      };
    })
    .filter((result): result is SchemaRagSearchResult => result !== undefined)
    .sort(compareResults)
    .slice(0, limit);
}

function reciprocalRankFusion(
  index: SchemaRagIndex,
  lexical: SchemaRagSearchResult[],
  vector: SchemaRagSearchResult[],
  k: number,
): SchemaRagSearchResult[] {
  const byId = new Map<string, SchemaRagSearchResult>();
  const add = (
    result: SchemaRagSearchResult,
    rank: number,
    channel: 'keyword' | 'vector',
  ) => {
    const existing = byId.get(result.document.id);
    const score = 1 / (Math.max(1, k) + rank + 1);
    byId.set(result.document.id, {
      document: result.document,
      score: (existing?.score ?? 0) + score,
      reasons: [
        ...new Set([...(existing?.reasons ?? []), ...result.reasons, `rrf:${channel}`]),
      ],
      scoreDetails: [
        ...(existing?.scoreDetails ?? []),
        {
          channel,
          score,
          rank: rank + 1,
          reasons: [`rrf:${channel}`],
        },
      ],
    });
  };
  lexical.forEach((result, rank) => add(result, rank, 'keyword'));
  vector.forEach((result, rank) => add(result, rank, 'vector'));

  // Preserve graph neighbors selected by the lexical retriever even if a
  // vector backend does not have a vector for a structural node.
  for (const result of lexical) {
    if (!byId.has(result.document.id)) byId.set(result.document.id, result);
  }
  const ids = new Set(index.documents.map((document) => document.id));
  return [...byId.values()]
    .filter((result) => ids.has(result.document.id))
    .sort(compareResults);
}

function vectorSimilarity(
  left: number[],
  right: number[],
  metric: 'cosine' | 'dot' | 'euclidean',
): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  let squaredDistance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
    const delta = leftValue - rightValue;
    squaredDistance += delta * delta;
  }
  if (metric === 'dot') return dot;
  if (metric === 'euclidean') return 1 / (1 + Math.sqrt(squaredDistance));
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

function applyContextLimit(
  results: SchemaRagSearchResult[],
  maxContextTokens: number,
): SchemaRagSearchResult[] {
  const selected: SchemaRagSearchResult[] = [];
  let tokens = 0;
  for (const result of results) {
    const estimated = estimateDocumentTokens(result.document);
    if (selected.length > 0 && tokens + estimated > maxContextTokens) break;
    selected.push(result);
    tokens += estimated;
  }
  return selected;
}

function estimateDocumentTokens(document: SchemaRagDocument): number {
  return Math.max(1, Math.ceil((document.title.length + document.text.length) / 3.5));
}

function compareResults(
  left: SchemaRagSearchResult,
  right: SchemaRagSearchResult,
): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}
