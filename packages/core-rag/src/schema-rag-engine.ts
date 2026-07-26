import { tableDocumentId } from './schema-documents.js';
import {
  buildKnowledgeCatalog,
  buildKnowledgeCatalogFromTables,
  buildKnowledgeDocuments,
} from './knowledge-catalog.js';
import { searchSchemaRagIndex } from './hybrid-schema-retriever.js';
import { searchSchemaRagIndexAsync } from './async-schema-retriever.js';
import {
  buildDocumentVectors,
  createSchemaRagIndexManifest,
  DEFAULT_RETRIEVAL_PROFILE,
  normalizeRetrievalProfile,
} from './retrieval-profile.js';
import type {
  KnowledgeCatalog,
  KnowledgeCatalogNode,
  SchemaRagDocument,
  SchemaRagContext,
  SchemaRagContextRequest,
  SchemaRagGlossaryEntry,
  SchemaRagIndex,
  SchemaRagIndexInput,
  SchemaRagIndexStatus,
  SchemaRagEmbeddingAdapter,
  SchemaRagListTablesRequest,
  SchemaRagRelationsResult,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
  SchemaRagRerankAdapter,
  SchemaRagRetrievalProfile,
  SchemaRagTableDescription,
  SchemaRagTableRef,
  SchemaRagTableSummary,
} from './types.js';

export type SchemaRagEngineOptions = {
  retrievalProfile?: SchemaRagRetrievalProfile;
  embeddingAdapter?: SchemaRagEmbeddingAdapter;
  rerankAdapter?: SchemaRagRerankAdapter;
};

export type SchemaRagEngineCheckpoint = {
  connectionId: string;
  index?: SchemaRagIndex;
  legacyTables?: NonNullable<SchemaRagIndexInput['tables']>;
};

export class SchemaRagEngine {
  private readonly indexes = new Map<string, SchemaRagIndex>();
  private readonly legacyTables = new Map<string, Map<string, NonNullable<SchemaRagIndexInput['tables']>[number]>>();
  private readonly profiles = new Map<string, SchemaRagRetrievalProfile>();
  private readonly defaultProfile: SchemaRagRetrievalProfile;
  private readonly embeddingAdapter: SchemaRagEmbeddingAdapter | undefined;
  private readonly rerankAdapter: SchemaRagRerankAdapter | undefined;

  constructor(options: SchemaRagEngineOptions = {}) {
    this.defaultProfile = normalizeRetrievalProfile(
      options.retrievalProfile ?? DEFAULT_RETRIEVAL_PROFILE,
    );
    this.embeddingAdapter = options.embeddingAdapter;
    this.rerankAdapter = options.rerankAdapter;
  }

  index(input: SchemaRagIndexInput): SchemaRagIndex {
    const indexedAt = input.indexedAt ?? new Date().toISOString();
    const catalog = input.resources
      ? buildKnowledgeCatalog({
          connectionId: input.connectionId,
          resources: input.resources,
          ...(input.relations === undefined ? {} : { relations: input.relations }),
          ...(input.knowledge === undefined ? {} : { knowledge: input.knowledge }),
          ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
          ...(input.sourceRevision === undefined
            ? {}
            : { sourceRevision: input.sourceRevision }),
          builtAt: indexedAt,
        })
      : buildKnowledgeCatalogFromTables({
          connectionId: input.connectionId,
          tables: input.tables ?? [],
          builtAt: indexedAt,
        });
    const documents = buildKnowledgeDocuments(catalog);
    const retrievalProfile = normalizeRetrievalProfile(
      input.retrievalProfile ?? this.defaultProfile,
    );
    const index: SchemaRagIndex = {
      connectionId: input.connectionId,
      documents,
      graph: buildGraph(documents),
      glossary: normalizeGlossary(input.glossary ?? [], documents),
      catalog,
      manifest: createSchemaRagIndexManifest({
        catalog,
        profile: retrievalProfile,
        documentCount: documents.length,
        createdAt: indexedAt,
        ...(input.sourceTableCount === undefined
          ? {}
          : { sourceTableCount: input.sourceTableCount }),
        ...(input.maxTables === undefined ? {} : { maxTables: input.maxTables }),
      }),
      retrievalProfile,
      indexedAt,
    };
    if (input.tables) {
      this.legacyTables.set(
        input.connectionId,
        new Map(
          input.tables.map((table) => [
            tableDocumentId(table.schema, table.name),
            structuredClone(table),
          ]),
        ),
      );
    } else {
      this.legacyTables.delete(input.connectionId);
    }
    this.indexes.set(input.connectionId, index);
    this.profiles.set(input.connectionId, retrievalProfile);
    return index;
  }

  async indexAsync(input: SchemaRagIndexInput): Promise<SchemaRagIndex> {
    const checkpoint = this.createCheckpoint(input.connectionId);
    try {
      const index = this.index(input);
      return await this.buildVectors(index);
    } catch (error) {
      this.restoreCheckpoint(checkpoint);
      throw error;
    }
  }

  upsertTables(input: SchemaRagIndexInput): SchemaRagIndex {
    if ((input.tables?.length ?? 0) === 0) return this.requireIndex(input.connectionId);
    const existing = this.indexes.get(input.connectionId);
    if (!existing) return this.index(input);
    const tables = this.legacyTables.get(input.connectionId);
    if (!tables) {
      throw new Error(
        'Incremental TableDetail updates require an index originally built from TableDetail input.',
      );
    }
    for (const table of input.tables ?? []) {
      tables.set(tableDocumentId(table.schema, table.name), structuredClone(table));
    }
    return this.index({
      connectionId: input.connectionId,
      tables: [...tables.values()],
      glossary: input.glossary ?? existing.glossary,
      indexedAt: input.indexedAt ?? existing.indexedAt,
      retrievalProfile: input.retrievalProfile ?? existing.retrievalProfile ?? this.defaultProfile,
    });
  }

  async upsertTablesAsync(input: SchemaRagIndexInput): Promise<SchemaRagIndex> {
    const checkpoint = this.createCheckpoint(input.connectionId);
    try {
      const index = this.upsertTables(input);
      if ((input.tables?.length ?? 0) === 0) return index;
      return await this.buildVectors(index);
    } catch (error) {
      this.restoreCheckpoint(checkpoint);
      throw error;
    }
  }

  loadIndex(index: SchemaRagIndex): SchemaRagIndex {
    assertRestoredIndex(index);
    this.indexes.set(index.connectionId, index);
    this.profiles.set(
      index.connectionId,
      normalizeRetrievalProfile(index.retrievalProfile ?? this.defaultProfile),
    );
    return index;
  }

  createCheckpoint(connectionId: string): SchemaRagEngineCheckpoint {
    const index = this.indexes.get(connectionId);
    const legacyTables = this.legacyTables.get(connectionId);
    return {
      connectionId,
      ...(index === undefined ? {} : { index: structuredClone(index) }),
      ...(legacyTables === undefined
        ? {}
        : { legacyTables: structuredClone([...legacyTables.values()]) }),
    };
  }

  restoreCheckpoint(checkpoint: SchemaRagEngineCheckpoint): void {
    this.clear(checkpoint.connectionId);
    if (checkpoint.index) this.loadIndex(structuredClone(checkpoint.index));
    if (checkpoint.legacyTables) {
      this.legacyTables.set(
        checkpoint.connectionId,
        new Map(
          checkpoint.legacyTables.map((table) => [
            tableDocumentId(table.schema, table.name),
            structuredClone(table),
          ]),
        ),
      );
    }
  }

  clear(connectionId: string): void {
    this.indexes.delete(connectionId);
    this.legacyTables.delete(connectionId);
    this.profiles.delete(connectionId);
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

  getCatalog(connectionId: string): KnowledgeCatalog {
    return structuredClone(this.requireCatalog(connectionId));
  }

  getIndexManifest(connectionId: string): NonNullable<SchemaRagIndex['manifest']> {
    const manifest = this.requireIndex(connectionId).manifest;
    if (!manifest) {
      throw new Error(`Schema RAG index manifest is not available for connection: ${connectionId}`);
    }
    return structuredClone(manifest);
  }

  listResources(input: {
    connectionId: string;
    parentId?: string;
    kinds?: string[];
    limit?: number;
  }): KnowledgeCatalogNode[] {
    const catalog = this.requireCatalog(input.connectionId);
    const parentId = input.parentId ?? catalog.rootIds[0];
    if (!parentId) return [];
    const parent = catalog.nodes[parentId];
    if (!parent) throw new Error(`Knowledge resource is not indexed: ${parentId}`);
    const kindSet = input.kinds ? new Set(input.kinds) : undefined;
    return parent.childIds
      .map((id) => catalog.nodes[id])
      .filter((node): node is KnowledgeCatalogNode => node !== undefined)
      .filter((node) => !kindSet || kindSet.has(node.kind))
      .slice(0, input.limit ?? 200)
      .map((node) => structuredClone(node));
  }

  getResource(input: {
    connectionId: string;
    resourceId: string;
  }): {
    node: KnowledgeCatalogNode;
    relations: KnowledgeCatalog['relations'][string][];
    knowledge: KnowledgeCatalog['knowledge'][string][];
  } {
    const catalog = this.requireCatalog(input.connectionId);
    const node = catalog.nodes[input.resourceId];
    if (!node) throw new Error(`Knowledge resource is not indexed: ${input.resourceId}`);
    const relationIds = new Set(node.relationIds);
    const applicableResourceIds = new Set([node.resourceId, ...node.ancestorIds]);
    const knowledgeIds = new Set(
      Object.values(catalog.bindings)
        .filter(
          (binding) =>
            binding.resourceId === node.resourceId ||
            (binding.mode === 'subtree' &&
              applicableResourceIds.has(binding.resourceId)),
        )
        .map((binding) => binding.knowledgeId),
    );
    return {
      node: structuredClone(node),
      relations: Object.values(catalog.relations)
        .filter((relation) => relationIds.has(relation.id))
        .map((relation) => structuredClone(relation)),
      knowledge: Object.values(catalog.knowledge)
        .filter((item) => knowledgeIds.has(item.id))
        .map((item) => structuredClone(item)),
    };
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
      .filter(isTableDocument)
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

  async searchAsync(request: SchemaRagSearchRequest): Promise<SchemaRagSearchResult[]> {
    const index = this.requireIndex(request.connectionId);
    const profile = this.profiles.get(request.connectionId) ?? this.defaultProfile;
    return searchSchemaRagIndexAsync({
      index,
      request,
      profile,
      ...(this.embeddingAdapter === undefined
        ? {}
        : { embeddingAdapter: this.embeddingAdapter }),
      ...(this.rerankAdapter === undefined
        ? {}
        : { rerankAdapter: this.rerankAdapter }),
    });
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
    return formatContext(request.query, results, request.maxChars ?? 4_000);
  }

  async buildContextAsync(request: SchemaRagContextRequest): Promise<SchemaRagContext> {
    const results = await this.searchAsync({
      connectionId: request.connectionId,
      query: request.query,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.explicitTables === undefined
        ? {}
        : { explicitTables: request.explicitTables }),
      ...(request.explicitColumns === undefined
        ? {}
        : { explicitColumns: request.explicitColumns }),
      includeRelations: true,
    });
    return formatContext(request.query, results, request.maxChars ?? 4_000);
  }

  private requireIndex(connectionId: string): SchemaRagIndex {
    const index = this.indexes.get(connectionId);
    if (!index) {
      throw new Error(`Schema RAG index is not available for connection: ${connectionId}`);
    }
    return index;
  }

  private requireCatalog(connectionId: string): KnowledgeCatalog {
    const catalog = this.requireIndex(connectionId).catalog;
    if (!catalog) {
      throw new Error(`Knowledge catalog is not available for connection: ${connectionId}`);
    }
    return catalog;
  }

  private async buildVectors(index: SchemaRagIndex): Promise<SchemaRagIndex> {
    const profile = this.profiles.get(index.connectionId)!;
    if (!profile.embedding) return index;
    if (!this.embeddingAdapter) {
      throw new Error(
        `Retrieval profile ${profile.id} configures embeddings but no embedding adapter is available.`,
      );
    }
    index.vectors = await buildDocumentVectors({
      documents: index.documents,
      profile: profile.embedding,
      adapter: this.embeddingAdapter,
    });
    return index;
  }
}

function formatContext(
  query: string,
  results: SchemaRagSearchResult[],
  maxChars: number,
): SchemaRagContext {
    const sections: string[] = [];
    let truncated = false;

    for (const result of results) {
      const section = `## ${result.document.title}\n${result.document.text}\n原因: ${result.reasons.join(', ')}`;
      const candidate = [...sections, section].join('\n\n');
      if (candidate.length > maxChars) {
        truncated = true;
        if (sections.length === 0) {
          sections.push(clipText(section, maxChars).text);
        }
        break;
      }
      sections.push(section);
    }

    return {
      query,
      documents: results,
      text: sections.join('\n\n'),
      truncated,
    };
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
  const tableCount = index.documents.filter(isTableDocument).length;
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
      isTableDocument(document) &&
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

function isTableDocument(document: SchemaRagDocument): boolean {
  return ['table', 'view', 'materialized-view', 'external-table'].includes(document.kind);
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
