import { tokenize } from './schema-documents.js';
import {
  extractExplicitSchemaReferences,
  parseExplicitSchemaReference,
  type SchemaRagExplicitReference,
} from './explicit-references.js';
import type {
  SchemaRagDocument,
  SchemaRagGlossaryEntry,
  SchemaRagIndex,
  SchemaRagRetrievalChannel,
  SchemaRagScoreDetail,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
} from './types.js';

type ChannelHit = {
  document: SchemaRagDocument;
  score: number;
  reasons: string[];
};

type CandidateHit = {
  document: SchemaRagDocument;
  score: number;
  reasons: Set<string>;
  channels: Set<SchemaRagRetrievalChannel>;
  scoreDetails: SchemaRagScoreDetail[];
};

type SearchRuntimeIndex = {
  documentById: Map<string, SchemaRagDocument>;
  normalizedTitles: Map<string, string>;
  normalizedTables: Map<string, string>;
  documentsByTitle: Map<string, Set<string>>;
  documentsByTable: Map<string, Set<string>>;
  documentsByQualifiedTable: Map<string, Set<string>>;
  tokenCounts: Map<string, Map<string, number>>;
  inverseDocumentFrequency: Map<string, number>;
  postings: Map<string, Set<string>>;
  lengthNormalizers: Map<string, number>;
};

const RRF_K = 60;
const runtimeIndexes = new WeakMap<SchemaRagIndex, SearchRuntimeIndex>();

export function searchSchemaRagIndex(
  index: SchemaRagIndex,
  request: SchemaRagSearchRequest,
): SchemaRagSearchResult[] {
  const runtime = getSearchRuntimeIndex(index);
  const queryTokens = tokenize([request.query]);
  const explicitReferences = collectExplicitReferences(request);
  const limit = request.limit ?? 8;
  const includeRelations = request.includeRelations ?? true;
  const channelCandidateLimit = Math.max(64, limit * 8);

  const channels: Array<{ name: SchemaRagRetrievalChannel; hits: ChannelHit[]; weight: number }> = [
    {
      name: 'explicit',
      hits: explicitChannel(runtime, explicitReferences),
      weight: 420,
    },
    {
      name: 'keyword',
      hits: keywordChannel(
        runtime,
        request.query,
        queryTokens,
        channelCandidateLimit,
      ),
      weight: 120,
    },
    {
      name: 'glossary',
      hits: glossaryChannel(runtime, index.glossary, request.query, queryTokens),
      weight: 180,
    },
  ];

  const candidates = new Map<string, CandidateHit>();
  for (const channel of channels) {
    channel.hits.forEach((hit, rank) => {
      const existing =
        candidates.get(hit.document.id) ??
        ({
          document: hit.document,
          score: 0,
          reasons: new Set<string>(),
          channels: new Set<SchemaRagRetrievalChannel>(),
          scoreDetails: [],
        } satisfies CandidateHit);
      const fusedScore = hit.score + channel.weight / (RRF_K + rank + 1);
      existing.score += fusedScore;
      hit.reasons.forEach((reason) => existing.reasons.add(reason));
      existing.channels.add(channel.name);
      existing.scoreDetails.push({
        channel: channel.name,
        score: fusedScore,
        rank: rank + 1,
        reasons: hit.reasons,
      });
      candidates.set(hit.document.id, existing);
    });
  }

  const ranked = [...candidates.values()].sort(compareCandidates);
  const selected = new Map<string, SchemaRagSearchResult>();
  const directLimit = includeRelations ? Math.max(1, Math.ceil(limit / 2)) : limit;

  for (const candidate of ranked.slice(0, directLimit)) {
    selected.set(candidate.document.id, toSearchResult(candidate));
  }

  if (includeRelations) {
    const expanded = expandGraph(
      index,
      runtime,
      ranked.slice(0, directLimit),
      request.expandHops ?? 1,
    );
    for (const expansion of expanded) {
      for (const relationId of expansion.relationIds) {
        const existing = selected.get(relationId);
        if (existing) {
          if (!existing.reasons.some((reason) => reason.startsWith('graph:'))) {
            const graphScore = Math.max(
              1,
              expansion.source.score * Math.pow(0.35, expansion.hop),
            );
            existing.reasons.push(
              `graph:${expansion.source.document.id}`,
              'channel:graph',
              `hop:${expansion.hop}`,
            );
            existing.scoreDetails = [
              ...(existing.scoreDetails ?? []),
              {
                channel: 'graph',
                score: graphScore,
                rank: expansion.hop,
                reasons: [`graph:${expansion.source.document.id}`],
              },
            ];
          }
          continue;
        }
        if (selected.size >= limit) break;
        const relation = runtime.documentById.get(relationId);
        if (!relation) continue;
        const score = Math.max(1, expansion.source.score * Math.pow(0.35, expansion.hop));
        selected.set(relation.id, {
          document: relation,
          score,
          reasons: [`graph:${expansion.source.document.id}`, `channel:graph`, `hop:${expansion.hop}`],
          scoreDetails: [
            {
              channel: 'graph',
              score,
              rank: expansion.hop,
              reasons: [`graph:${expansion.source.document.id}`],
            },
          ],
        });
      }
      if (selected.size >= limit) break;
    }
  }

  for (const candidate of ranked) {
    if (selected.size >= limit) break;
    if (!selected.has(candidate.document.id)) selected.set(candidate.document.id, toSearchResult(candidate));
  }

  return applyContextLimit(
    [...selected.values()].sort(compareResults).slice(0, limit),
    request.maxContextTokens,
  );
}

function collectExplicitReferences(request: SchemaRagSearchRequest): SchemaRagExplicitReference[] {
  return [
    ...extractExplicitSchemaReferences(request.query),
    ...(request.explicitTables ?? []).flatMap((reference) => {
      const parsed = parseExplicitSchemaReference(reference);
      return parsed ? [parsed] : [];
    }),
    ...(request.explicitColumns ?? []).flatMap((reference) => {
      const parsed = parseExplicitSchemaReference(reference);
      return parsed ? [parsed] : [];
    }),
  ];
}

function explicitChannel(
  runtime: SearchRuntimeIndex,
  references: SchemaRagExplicitReference[],
): ChannelHit[] {
  if (references.length === 0) return [];
  const candidateIds = new Set<string>();
  for (const reference of references) {
    const lookup =
      reference.schema === undefined
        ? runtime.documentsByTable.get(reference.table)
        : runtime.documentsByQualifiedTable.get(
            qualifiedTableKey(reference.schema, reference.table),
          );
    for (const documentId of lookup ?? []) candidateIds.add(documentId);
  }
  return [...candidateIds]
    .map((documentId) => runtime.documentById.get(documentId))
    .filter((document): document is SchemaRagDocument => document !== undefined)
    .map((document) => {
      const score = scoreExplicitReference(document, references);
      const reasons = explicitReasons(document, references);
      return { document, score, reasons };
    })
    .filter((hit) => hit.score > 0)
    .sort(compareChannelHits);
}

function keywordChannel(
  runtime: SearchRuntimeIndex,
  query: string,
  queryTokens: string[],
  maxHits: number,
): ChannelHit[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery && queryTokens.length === 0) return [];
  const candidateIds = new Set<string>();
  for (const token of queryTokens) {
    for (const documentId of runtime.postings.get(token) ?? []) {
      candidateIds.add(documentId);
    }
  }
  if (normalizedQuery.length > 1) {
    for (const documentId of runtime.documentsByTitle.get(normalizedQuery) ?? []) {
      candidateIds.add(documentId);
    }
    const hasTokenPosting = queryTokens.some(
      (token) => (runtime.postings.get(token)?.size ?? 0) > 0,
    );
    if (!hasTokenPosting) {
      for (const [documentId, normalizedTitle] of runtime.normalizedTitles) {
        if (normalizedTitle.includes(normalizedQuery)) candidateIds.add(documentId);
      }
    }
  }
  const topHits: ChannelHit[] = [];
  for (const documentId of candidateIds) {
    const document = runtime.documentById.get(documentId);
    if (!document) continue;
    const hit = scoreKeyword(
      document,
      normalizedQuery,
      queryTokens,
      runtime.normalizedTitles.get(document.id) ?? document.title.toLowerCase(),
      runtime.normalizedTables.get(document.id) ?? document.table.toLowerCase(),
      runtime.tokenCounts.get(document.id) ?? new Map<string, number>(),
      runtime.lengthNormalizers.get(document.id) ?? 1,
      runtime.inverseDocumentFrequency,
    );
    if (hit.score > 0) addTopChannelHit(topHits, hit, maxHits);
  }
  return topHits.sort(compareChannelHits);
}

function glossaryChannel(
  runtime: SearchRuntimeIndex,
  glossary: SchemaRagGlossaryEntry[],
  query: string,
  queryTokens: string[],
): ChannelHit[] {
  const normalizedQuery = query.toLowerCase();
  const hits = new Map<string, ChannelHit>();

  for (const entry of glossary) {
    const matchedTerm = findGlossaryMatch(entry, normalizedQuery, queryTokens);
    if (!matchedTerm) continue;
    for (const documentId of entry.documentIds) {
      const document = runtime.documentById.get(documentId);
      if (!document) continue;
      const existing = hits.get(documentId) ?? { document, score: 0, reasons: [] };
      existing.score += entry.weight ?? 30;
      existing.reasons.push(`glossary:${matchedTerm}`);
      if (entry.description) {
        const descriptionTokens = tokenize([entry.description]);
        existing.score += descriptionTokens.filter((token) => queryTokens.includes(token)).length * 2;
      }
      hits.set(documentId, existing);
    }
  }

  return [...hits.values()].sort(compareChannelHits);
}

function scoreKeyword(
  document: SchemaRagDocument,
  normalizedQuery: string,
  queryTokens: string[],
  normalizedTitle: string,
  normalizedTable: string,
  tokenCounts: Map<string, number>,
  lengthNormalizer: number,
  inverseDocumentFrequency: Map<string, number>,
): ChannelHit {
  const reasons: string[] = [];
  let score = 0;

  if (normalizedTitle === normalizedQuery) {
    score += 100;
    reasons.push('exact-title');
  } else if (normalizedQuery.length > 1 && normalizedTitle.includes(normalizedQuery)) {
    score += 40;
    reasons.push('title-contains');
  }

  for (const token of queryTokens) {
    const termFrequency = tokenCounts.get(token) ?? 0;
    if (termFrequency === 0) continue;
    const denominator = termFrequency + lengthNormalizer;
    score +=
      (inverseDocumentFrequency.get(token) ?? 0) *
      ((termFrequency * (1.2 + 1)) / Math.max(Number.EPSILON, denominator)) *
      20;
    reasons.push(`bm25:${token}`);
    reasons.push(`token:${token}`);
  }

  if (document.kind === 'table' && normalizedTable === normalizedQuery) {
    score += 100;
    reasons.push('exact-table-name');
  }

  if (document.kind === 'table' && score > 0) {
    score += 5;
    reasons.push('table-priority');
  }

  return { document, score, reasons };
}

function applyContextLimit(
  results: SchemaRagSearchResult[],
  maxContextTokens: number | undefined,
): SchemaRagSearchResult[] {
  if (maxContextTokens === undefined) return results;
  const contextLimit = Math.max(1, Math.floor(maxContextTokens));
  const selected: SchemaRagSearchResult[] = [];
  let consumed = 0;
  for (const result of results) {
    const estimatedTokens = Math.max(
      1,
      Math.ceil((result.document.title.length + result.document.text.length) / 3.5),
    );
    if (
      selected.length > 0 &&
      consumed + estimatedTokens > contextLimit
    ) {
      break;
    }
    selected.push(result);
    consumed += estimatedTokens;
  }
  return selected;
}

function scoreExplicitReference(
  document: SchemaRagDocument,
  references: SchemaRagExplicitReference[],
): number {
  let score = 0;
  for (const reference of references) {
    const schemaMatches = reference.schema === undefined || reference.schema === document.schema;
    const tableMatches = reference.table === document.table;
    if (!schemaMatches || !tableMatches) continue;

    if (reference.column) {
      if (document.kind === 'column' && document.column === reference.column) {
        score = Math.max(score, 320);
      } else if (document.kind === 'table') {
        score = Math.max(score, 160);
      }
      continue;
    }

    if (document.kind === 'table') {
      score = Math.max(score, reference.schema ? 300 : 240);
    } else if (document.kind === 'column') {
      score = Math.max(score, reference.schema ? 90 : 60);
    }
  }
  return score;
}

function explicitReasons(
  document: SchemaRagDocument,
  references: SchemaRagExplicitReference[],
): string[] {
  if (scoreExplicitReference(document, references) <= 0) return [];
  return [document.kind === 'column' ? 'explicit-column' : 'explicit-table'];
}

function findGlossaryMatch(
  entry: SchemaRagGlossaryEntry,
  normalizedQuery: string,
  queryTokens: string[],
): string | undefined {
  const candidates = [entry.term, ...(entry.aliases ?? [])];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (normalizedQuery.includes(normalized)) return candidate;
    const tokens = tokenize([candidate]);
    if (tokens.some((token) => queryTokens.includes(token))) return candidate;
  }
  return undefined;
}

function toSearchResult(candidate: CandidateHit): SchemaRagSearchResult {
  return {
    document: candidate.document,
    score: candidate.score,
    reasons: [...candidate.reasons, ...[...candidate.channels].map((channel) => `channel:${channel}`)],
    scoreDetails: candidate.scoreDetails,
  };
}

function expandGraph(
  index: SchemaRagIndex,
  runtime: SearchRuntimeIndex,
  sources: CandidateHit[],
  expandHops: number,
): Array<{ source: CandidateHit; hop: number; relationIds: string[] }> {
  const normalizedHops = Math.max(0, Math.floor(expandHops));
  if (normalizedHops === 0) return [];
  const expansions: Array<{ source: CandidateHit; hop: number; relationIds: string[] }> = [];

  for (const source of sources) {
    let frontier = new Set(index.graph.get(source.document.id) ?? []);
    const visited = new Set<string>([source.document.id]);
    for (let hop = 1; hop <= normalizedHops && frontier.size > 0; hop += 1) {
      const relationIds = sortRelationIds(
        index,
        runtime,
        source.document,
        [...frontier].filter((id) => !visited.has(id)),
      );
      if (relationIds.length > 0) expansions.push({ source, hop, relationIds });
      relationIds.forEach((id) => visited.add(id));
      frontier = new Set(
        relationIds.flatMap((id) => [...(index.graph.get(id) ?? [])]).filter((id) => !visited.has(id)),
      );
    }
  }

  return expansions;
}

function sortRelationIds(
  index: SchemaRagIndex,
  runtime: SearchRuntimeIndex,
  source: SchemaRagDocument,
  relationIds: string[],
): string[] {
  return [...relationIds].sort((left, right) => {
    const leftDocument = runtime.documentById.get(left);
    const rightDocument = runtime.documentById.get(right);
    return relationRank(source, leftDocument) - relationRank(source, rightDocument);
  });
}

function getSearchRuntimeIndex(index: SchemaRagIndex): SearchRuntimeIndex {
  const cached = runtimeIndexes.get(index);
  if (cached) return cached;
  const documentById = new Map(
    index.documents.map((document) => [document.id, document]),
  );
  const normalizedTitles = new Map<string, string>();
  const normalizedTables = new Map<string, string>();
  const documentsByTitle = new Map<string, Set<string>>();
  const documentsByTable = new Map<string, Set<string>>();
  const documentsByQualifiedTable = new Map<string, Set<string>>();
  const documentTokens = new Map<string, string[]>();
  const tokenCounts = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();
  const postings = new Map<string, Set<string>>();
  let totalLength = 0;

  for (const document of index.documents) {
    const normalizedTitle = document.title.toLowerCase();
    normalizedTitles.set(document.id, normalizedTitle);
    normalizedTables.set(document.id, document.table.toLowerCase());
    addPosting(documentsByTitle, normalizedTitle, document.id);
    if (document.table) {
      addPosting(documentsByTable, document.table, document.id);
      addPosting(
        documentsByQualifiedTable,
        qualifiedTableKey(document.schema, document.table),
        document.id,
      );
    }
    const tokens = tokenize([document.title, document.text]);
    documentTokens.set(document.id, tokens);
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    tokenCounts.set(document.id, counts);
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      const documentIds = postings.get(token) ?? new Set<string>();
      documentIds.add(document.id);
      postings.set(token, documentIds);
    }
  }

  const documentCount = documentById.size;
  const inverseDocumentFrequency = new Map(
    [...documentFrequency].map(([token, frequency]) => [
      token,
      Math.log(
        1 + (documentCount - frequency + 0.5) / (frequency + 0.5),
      ),
    ]),
  );
  const averageLength = totalLength / Math.max(1, index.documents.length);
  const lengthNormalizers = new Map(
    [...documentTokens].map(([documentId, tokens]) => [
      documentId,
      1.2 * (1 - 0.75 + 0.75 * (tokens.length / Math.max(1, averageLength))),
    ]),
  );
  const runtime = {
    documentById,
    normalizedTitles,
    normalizedTables,
    documentsByTitle,
    documentsByTable,
    documentsByQualifiedTable,
    tokenCounts,
    inverseDocumentFrequency,
    postings,
    lengthNormalizers,
  };
  runtimeIndexes.set(index, runtime);
  return runtime;
}

function relationRank(
  source: SchemaRagDocument,
  document: SchemaRagDocument | undefined,
): number {
  if (document?.kind === 'column' && document.metadata.foreignKey) {
    return -3;
  }
  if (
    document?.kind === 'table' &&
    (document.schema !== source.schema || document.table !== source.table)
  ) {
    return -2;
  }
  if (
    document?.kind === 'column' &&
    document.schema === source.schema &&
    document.table === source.table
  ) {
    return 0;
  }
  if (
    document?.kind === 'table' &&
    document.schema === source.schema &&
    document.table === source.table
  ) {
    return 0;
  }
  if (document?.kind === 'table') return 1;
  if (document?.kind === 'relation') return 2;
  if (document?.kind === 'column') return 3;
  return 4;
}

function qualifiedTableKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

function addPosting(
  index: Map<string, Set<string>>,
  key: string,
  documentId: string,
): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(documentId);
  index.set(key, values);
}

function addTopChannelHit(
  heap: ChannelHit[],
  hit: ChannelHit,
  limit: number,
): void {
  if (heap.length < limit) {
    heap.push(hit);
    siftWorstUp(heap, heap.length - 1);
    return;
  }
  const worst = heap[0];
  if (!worst || compareHitQuality(hit, worst) <= 0) return;
  heap[0] = hit;
  siftWorstDown(heap, 0);
}

function siftWorstUp(heap: ChannelHit[], startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex]!;
    const current = heap[index]!;
    if (compareHitQuality(current, parent) >= 0) return;
    heap[parentIndex] = current;
    heap[index] = parent;
    index = parentIndex;
  }
}

function siftWorstDown(heap: ChannelHit[], startIndex: number): void {
  let index = startIndex;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    if (leftIndex >= heap.length) return;
    let worstChildIndex = leftIndex;
    if (
      rightIndex < heap.length &&
      compareHitQuality(heap[rightIndex]!, heap[leftIndex]!) < 0
    ) {
      worstChildIndex = rightIndex;
    }
    if (
      compareHitQuality(heap[index]!, heap[worstChildIndex]!) <= 0
    ) {
      return;
    }
    const current = heap[index]!;
    heap[index] = heap[worstChildIndex]!;
    heap[worstChildIndex] = current;
    index = worstChildIndex;
  }
}

function compareHitQuality(left: ChannelHit, right: ChannelHit): number {
  return (
    left.score - right.score ||
    right.document.id.localeCompare(left.document.id)
  );
}

function compareChannelHits(left: ChannelHit, right: ChannelHit): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}

function compareCandidates(left: CandidateHit, right: CandidateHit): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}

function compareResults(left: SchemaRagSearchResult, right: SchemaRagSearchResult): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}
