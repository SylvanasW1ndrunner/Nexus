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

const RRF_K = 60;

export function searchSchemaRagIndex(
  index: SchemaRagIndex,
  request: SchemaRagSearchRequest,
): SchemaRagSearchResult[] {
  const queryTokens = tokenize([request.query]);
  const explicitReferences = collectExplicitReferences(request);
  const limit = request.limit ?? 8;
  const includeRelations = request.includeRelations ?? true;

  const channels: Array<{ name: SchemaRagRetrievalChannel; hits: ChannelHit[]; weight: number }> = [
    {
      name: 'explicit',
      hits: explicitChannel(index.documents, explicitReferences),
      weight: 420,
    },
    {
      name: 'keyword',
      hits: keywordChannel(index.documents, request.query, queryTokens),
      weight: 120,
    },
    {
      name: 'glossary',
      hits: glossaryChannel(index.documents, index.glossary, request.query, queryTokens),
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
    const expanded = expandGraph(index, ranked.slice(0, directLimit), request.expandHops ?? 1);
    for (const expansion of expanded) {
      for (const relationId of expansion.relationIds) {
        if (selected.size >= limit) break;
        if (selected.has(relationId)) continue;
        const relation = index.documents.find((document) => document.id === relationId);
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

  return [...selected.values()].sort(compareResults).slice(0, limit);
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
  documents: SchemaRagDocument[],
  references: SchemaRagExplicitReference[],
): ChannelHit[] {
  if (references.length === 0) return [];
  return documents
    .map((document) => {
      const score = scoreExplicitReference(document, references);
      const reasons = explicitReasons(document, references);
      return { document, score, reasons };
    })
    .filter((hit) => hit.score > 0)
    .sort(compareChannelHits);
}

function keywordChannel(
  documents: SchemaRagDocument[],
  query: string,
  queryTokens: string[],
): ChannelHit[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery && queryTokens.length === 0) return [];

  return documents
    .map((document) => scoreKeyword(document, normalizedQuery, queryTokens))
    .filter((hit) => hit.score > 0)
    .sort(compareChannelHits);
}

function glossaryChannel(
  documents: SchemaRagDocument[],
  glossary: SchemaRagGlossaryEntry[],
  query: string,
  queryTokens: string[],
): ChannelHit[] {
  const normalizedQuery = query.toLowerCase();
  const byId = new Map(documents.map((document) => [document.id, document]));
  const hits = new Map<string, ChannelHit>();

  for (const entry of glossary) {
    const matchedTerm = findGlossaryMatch(entry, normalizedQuery, queryTokens);
    if (!matchedTerm) continue;
    for (const documentId of entry.documentIds) {
      const document = byId.get(documentId);
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
): ChannelHit {
  const reasons: string[] = [];
  let score = 0;
  const normalizedTitle = document.title.toLowerCase();
  const normalizedText = document.text.toLowerCase();

  if (normalizedTitle === normalizedQuery) {
    score += 100;
    reasons.push('exact-title');
  } else if (normalizedQuery.length > 1 && normalizedTitle.includes(normalizedQuery)) {
    score += 40;
    reasons.push('title-contains');
  }

  for (const token of queryTokens) {
    if (document.tokens.includes(token)) {
      score += 10;
      reasons.push(`token:${token}`);
    } else if (normalizedText.includes(token)) {
      score += 3;
      reasons.push(`text:${token}`);
    }
  }

  if (document.kind === 'table' && score > 0) {
    score += 5;
    reasons.push('table-priority');
  }

  return { document, score, reasons };
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
  source: SchemaRagDocument,
  relationIds: string[],
): string[] {
  return [...relationIds].sort((left, right) => {
    const leftDocument = index.documents.find((document) => document.id === left);
    const rightDocument = index.documents.find((document) => document.id === right);
    return relationRank(source, leftDocument) - relationRank(source, rightDocument);
  });
}

function relationRank(
  source: SchemaRagDocument,
  document: SchemaRagDocument | undefined,
): number {
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

function compareChannelHits(left: ChannelHit, right: ChannelHit): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}

function compareCandidates(left: CandidateHit, right: CandidateHit): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}

function compareResults(left: SchemaRagSearchResult, right: SchemaRagSearchResult): number {
  return right.score - left.score || left.document.id.localeCompare(right.document.id);
}
