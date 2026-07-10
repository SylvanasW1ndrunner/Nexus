import { buildSchemaDocuments, tableDocumentId } from './schema-documents.js';
import { searchSchemaRagIndex } from './hybrid-schema-retriever.js';
import type {
  SchemaRagDocument,
  SchemaRagContext,
  SchemaRagContextRequest,
  SchemaRagGlossaryEntry,
  SchemaRagIndex,
  SchemaRagIndexInput,
  SchemaRagIndexStatus,
  SchemaRagListTablesRequest,
  SchemaRagRelationsResult,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
  SchemaRagTableDescription,
  SchemaRagTableRef,
  SchemaRagTableSummary,
} from './types.js';

export class SchemaRagEngine {
  private readonly indexes = new Map<string, SchemaRagIndex>();

  index(input: SchemaRagIndexInput): SchemaRagIndex {
    const documents = buildSchemaDocuments({
      connectionId: input.connectionId,
      tables: input.tables,
    });
    const index: SchemaRagIndex = {
      connectionId: input.connectionId,
      documents,
      graph: buildGraph(documents),
      glossary: normalizeGlossary(input.glossary ?? [], documents),
      indexedAt: input.indexedAt ?? new Date().toISOString(),
    };
    this.indexes.set(input.connectionId, index);
    return index;
  }

  upsertTables(input: SchemaRagIndexInput): SchemaRagIndex {
    if (input.tables.length === 0) return this.requireIndex(input.connectionId);
    const existing = this.indexes.get(input.connectionId);
    if (!existing) return this.index(input);

    const affectedTables = new Set(
      input.tables.map((table) => tableDocumentId(table.schema, table.name)),
    );
    const documents = buildSchemaDocuments({
      connectionId: input.connectionId,
      tables: input.tables,
    });
    const replacementIds = new Set(documents.map((document) => document.id));
    const retained = existing.documents.filter((document) => {
      if (affectedTables.has(tableDocumentId(document.schema, document.table))) return false;
      if (replacementIds.has(document.id)) return false;
      return true;
    });
    const mergedDocuments = [...retained, ...documents].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const index: SchemaRagIndex = {
      connectionId: input.connectionId,
      documents: mergedDocuments,
      graph: buildGraph(mergedDocuments),
      glossary: normalizeGlossary(input.glossary ?? existing.glossary, mergedDocuments),
      indexedAt: input.indexedAt ?? existing.indexedAt,
    };
    this.indexes.set(input.connectionId, index);
    return index;
  }

  loadIndex(index: SchemaRagIndex): SchemaRagIndex {
    assertRestoredIndex(index);
    this.indexes.set(index.connectionId, index);
    return index;
  }

  clear(connectionId: string): void {
    this.indexes.delete(connectionId);
  }

  hasIndex(connectionId: string): boolean {
    return this.indexes.has(connectionId);
  }

  hasTable(request: SchemaRagTableRef): boolean {
    const index = this.indexes.get(request.connectionId);
    if (!index) return false;
    try {
      resolveTable(index, request);
      return true;
    } catch {
      return false;
    }
  }

  getIndexStatus(connectionId: string): SchemaRagIndexStatus {
    const index = this.indexes.get(connectionId);
    const updatedAt = new Date().toISOString();
    if (!index) {
      return {
        connectionId,
        stage: 'idle',
        ready: false,
        documentCount: 0,
        tableCount: 0,
        columnCount: 0,
        relationCount: 0,
        glossaryCount: 0,
        updatedAt,
        stages: [
          {
            stage: 'idle',
            state: 'completed',
            done: 0,
            total: 0,
            completedAt: updatedAt,
          },
        ],
      };
    }

    return buildReadyStatus(index, updatedAt);
  }

  listTables(request: SchemaRagListTablesRequest): SchemaRagTableSummary[] {
    const index = this.requireIndex(request.connectionId);
    const limit = request.limit ?? 200;
    return index.documents
      .filter((document) => document.kind === 'table')
      .filter((document) => request.schema === undefined || document.schema === request.schema)
      .sort((left, right) => left.title.localeCompare(right.title))
      .slice(0, limit)
      .map((document) => ({
        id: document.id,
        schema: document.schema,
        table: document.table,
        title: document.title,
        ...(typeof document.metadata.type === 'string' ? { type: document.metadata.type } : {}),
        ...(typeof document.metadata.columnCount === 'number'
          ? { columnCount: document.metadata.columnCount }
          : {}),
      }));
  }

  describeTable(request: SchemaRagTableRef): SchemaRagTableDescription {
    const index = this.requireIndex(request.connectionId);
    const table = resolveTable(index, request);
    const columns = index.documents
      .filter(
        (document) =>
          document.kind === 'column' &&
          document.schema === table.schema &&
          document.table === table.table,
      )
      .sort((left, right) => left.title.localeCompare(right.title));
    const relatedTables = relatedTableDocuments(index, table);
    const sections = [
      `## ${table.title}`,
      table.text,
      columns.length
        ? `\n### Columns\n${columns.map((column) => `- ${column.title}: ${column.text.replace(/\n/g, '; ')}`).join('\n')}`
        : '',
      relatedTables.length
        ? `\n### Related tables\n${relatedTables.map((related) => `- ${related.title}`).join('\n')}`
        : '',
    ].filter(Boolean);
    const clipped = clipText(sections.join('\n'), request.maxChars ?? 4_000);
    return {
      table,
      columns,
      relatedTables,
      text: clipped.text,
      truncated: clipped.truncated,
    };
  }

  getRelations(request: SchemaRagTableRef): SchemaRagRelationsResult {
    const index = this.requireIndex(request.connectionId);
    const table = resolveTable(index, request);
    const relatedTables = relatedTableDocuments(index, table);
    const relationDocuments = (
      index.graph.get(table.id) ? [...(index.graph.get(table.id) ?? [])] : []
    )
      .map((id) => index.documents.find((document) => document.id === id))
      .filter((document): document is SchemaRagDocument => document !== undefined);
    return { table, relatedTables, relationDocuments };
  }

  search(request: SchemaRagSearchRequest): SchemaRagSearchResult[] {
    const index = this.requireIndex(request.connectionId);
    return searchSchemaRagIndex(index, request);
  }

  buildContext(request: SchemaRagContextRequest): SchemaRagContext {
    const results = this.search({
      connectionId: request.connectionId,
      query: request.query,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.explicitTables === undefined ? {} : { explicitTables: request.explicitTables }),
      ...(request.explicitColumns === undefined
        ? {}
        : { explicitColumns: request.explicitColumns }),
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

function assertRestoredIndex(index: SchemaRagIndex): void {
  if (!index.connectionId.trim()) {
    throw new Error('Schema RAG restored index requires a connection id.');
  }
  for (const document of index.documents) {
    if (document.connectionId !== index.connectionId) {
      throw new Error(`Schema RAG document ${document.id} belongs to a different connection.`);
    }
  }
}

function buildReadyStatus(index: SchemaRagIndex, updatedAt: string): SchemaRagIndexStatus {
  const tableCount = index.documents.filter((document) => document.kind === 'table').length;
  const columnCount = index.documents.filter((document) => document.kind === 'column').length;
  const relationCount = index.documents.filter((document) => document.kind === 'relation').length;
  return {
    connectionId: index.connectionId,
    stage: 'ready',
    ready: true,
    documentCount: index.documents.length,
    tableCount,
    columnCount,
    relationCount,
    glossaryCount: index.glossary.length,
    indexedAt: index.indexedAt,
    updatedAt,
    stages: [
      {
        stage: 'ready',
        state: 'completed',
        done: index.documents.length,
        total: index.documents.length,
        startedAt: index.indexedAt,
        completedAt: updatedAt,
      },
    ],
  };
}

function normalizeGlossary(
  entries: SchemaRagGlossaryEntry[],
  documents: SchemaRagDocument[],
): SchemaRagGlossaryEntry[] {
  const documentIds = new Set(documents.map((document) => document.id));
  return entries
    .map((entry) => ({
      term: entry.term.trim(),
      aliases: unique((entry.aliases ?? []).map((alias) => alias.trim()).filter(Boolean)),
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      documentIds: unique(entry.documentIds.filter((id) => documentIds.has(id))),
      ...(entry.weight === undefined ? {} : { weight: Math.max(1, entry.weight) }),
    }))
    .filter((entry) => entry.term.length > 0 && entry.documentIds.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function buildGraph(documents: SchemaRagDocument[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const document of documents) {
    graph.set(document.id, new Set(document.relationIds));
  }
  return graph;
}

function resolveTable(index: SchemaRagIndex, request: SchemaRagTableRef): SchemaRagDocument {
  const parsed = parseTableRef(request.table);
  const schema = request.schema ?? parsed.schema;
  const table = parsed.table;
  const matches = index.documents.filter(
    (document) =>
      document.kind === 'table' &&
      document.table === table &&
      (schema === undefined || document.schema === schema),
  );
  if (matches.length === 0) {
    throw new Error(`Schema RAG table is not indexed: ${schema ? `${schema}.` : ''}${table}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Schema RAG table reference is ambiguous: ${table}. Candidates: ${matches
        .map((document) => document.title)
        .join(', ')}`,
    );
  }
  return matches[0]!;
}

function parseTableRef(tableRef: string): { schema?: string; table: string } {
  const trimmed = tableRef.trim();
  if (!trimmed) throw new Error('Table name is required.');
  const parts = trimmed.split('.').filter(Boolean);
  if (parts.length === 1) return { table: parts[0]! };
  if (parts.length === 2) return { schema: parts[0]!, table: parts[1]! };
  throw new Error(`Invalid table reference: ${tableRef}`);
}

function relatedTableDocuments(
  index: SchemaRagIndex,
  table: SchemaRagDocument,
): SchemaRagDocument[] {
  return [...(index.graph.get(table.id) ?? [])]
    .map((id) => index.documents.find((document) => document.id === id))
    .filter(
      (document): document is SchemaRagDocument =>
        document?.kind === 'table' && document.id !== table.id,
    )
    .sort((left, right) => left.title.localeCompare(right.title));
}

function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 15))}\n...[truncated]`, truncated: true };
}
