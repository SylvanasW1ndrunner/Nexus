import { buildSchemaDocuments, tokenize } from './schema-documents.js';
import type {
  SchemaRagDocument,
  SchemaRagContext,
  SchemaRagContextRequest,
  SchemaRagIndex,
  SchemaRagIndexInput,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
} from './types.js';

export class SchemaRagEngine {
  private readonly indexes = new Map<string, SchemaRagIndex>();

  index(input: SchemaRagIndexInput): SchemaRagIndex {
    const documents = buildSchemaDocuments({
      connectionId: input.connectionId,
      tables: input.tables,
    });
    const graph = new Map<string, Set<string>>();
    for (const document of documents) {
      graph.set(document.id, new Set(document.relationIds));
    }
    const index: SchemaRagIndex = {
      connectionId: input.connectionId,
      documents,
      graph,
      indexedAt: input.indexedAt ?? new Date().toISOString(),
    };
    this.indexes.set(input.connectionId, index);
    return index;
  }

  clear(connectionId: string): void {
    this.indexes.delete(connectionId);
  }

  search(request: SchemaRagSearchRequest): SchemaRagSearchResult[] {
    const index = this.requireIndex(request.connectionId);
    const queryTokens = tokenize([request.query]);
    const limit = request.limit ?? 8;
    const includeRelations = request.includeRelations ?? true;

    const scored = index.documents
      .map((document) => scoreDocument(document, request.query, queryTokens))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));

    const selected = new Map<string, SchemaRagSearchResult>();
    const directLimit = includeRelations ? Math.max(1, Math.ceil(limit / 2)) : limit;

    for (const result of scored.slice(0, directLimit)) {
      selected.set(result.document.id, result);
      if (!includeRelations) continue;
      for (const relationId of index.graph.get(result.document.id) ?? []) {
        if (selected.size >= limit) break;
        const relation = index.documents.find((document) => document.id === relationId);
        if (!relation || selected.has(relation.id)) continue;
        selected.set(relation.id, {
          document: relation,
          score: Math.max(1, result.score * 0.35),
          reasons: [`relation:${result.document.id}`],
        });
      }
    }

    for (const result of scored) {
      if (selected.size >= limit) break;
      if (!selected.has(result.document.id)) selected.set(result.document.id, result);
    }

    return [...selected.values()]
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
      .slice(0, limit);
  }

  buildContext(request: SchemaRagContextRequest): SchemaRagContext {
    const results = this.search({
      connectionId: request.connectionId,
      query: request.query,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      includeRelations: true,
    });
    const maxChars = request.maxChars ?? 4_000;
    const sections: string[] = [];
    let truncated = false;

    for (const result of results) {
      const section = `## ${result.document.title}\n${result.document.text}\n原因: ${result.reasons.join(', ')}`;
      const candidate = [...sections, section].join('\n\n');
      if (candidate.length > maxChars) {
        truncated = true;
        break;
      }
      sections.push(section);
    }

    return {
      query: request.query,
      documents: results,
      text: sections.join('\n\n'),
      truncated,
    };
  }

  private requireIndex(connectionId: string): SchemaRagIndex {
    const index = this.indexes.get(connectionId);
    if (!index) {
      throw new Error(`Schema RAG index is not available for connection: ${connectionId}`);
    }
    return index;
  }
}

function scoreDocument(
  document: SchemaRagDocument,
  query: string,
  queryTokens: string[],
): SchemaRagSearchResult {
  const reasons: string[] = [];
  let score = 0;
  const normalizedQuery = query.toLowerCase();
  const normalizedTitle = document.title.toLowerCase();
  const normalizedText = document.text.toLowerCase();

  if (normalizedTitle === normalizedQuery) {
    score += 100;
    reasons.push('exact-title');
  } else if (normalizedTitle.includes(normalizedQuery) && normalizedQuery.length > 1) {
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
