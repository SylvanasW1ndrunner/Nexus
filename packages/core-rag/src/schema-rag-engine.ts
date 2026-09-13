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

export class SchemaRagOperationSupersededError extends Error {
  readonly code = 'SCHEMA_RAG_OPERATION_SUPERSEDED';

  constructor(readonly connectionId: string) {
    super(`Schema RAG indexing operation was superseded for connection: ${connectionId}`);
    this.name = 'SchemaRagOperationSupersededError';
  }
}

export type SchemaRagReadView = Readonly<{
  connectionId: string;
  getCatalog(): KnowledgeCatalog;
  getIndexManifest(): NonNullable<SchemaRagIndex['manifest']>;
  listResources(input: Omit<Parameters<SchemaRagEngine['listResources']>[0], 'connectionId'>): KnowledgeCatalogNode[];
  getResource(input: Omit<Parameters<SchemaRagEngine['getResource']>[0], 'connectionId'>): ReturnType<SchemaRagEngine['getResource']>;
  listTables(input: Omit<SchemaRagListTablesRequest, 'connectionId'>): SchemaRagTableSummary[];
  describeTable(input: Omit<SchemaRagTableRef, 'connectionId'>): SchemaRagTableDescription;
  getRelations(input: Omit<SchemaRagTableRef, 'connectionId'>): SchemaRagRelationsResult;
  search(input: Omit<SchemaRagSearchRequest, 'connectionId'>): SchemaRagSearchResult[];
  searchAsync(input: Omit<SchemaRagSearchRequest, 'connectionId'>): Promise<SchemaRagSearchResult[]>;
  buildContext(input: Omit<SchemaRagContextRequest, 'connectionId'>): SchemaRagContext;
  buildContextAsync(input: Omit<SchemaRagContextRequest, 'connectionId'>): Promise<SchemaRagContext>;
}>;

type SchemaRagSlot = {
  index: SchemaRagIndex;
  profile: SchemaRagRetrievalProfile;
  legacyTables?: Map<string, NonNullable<SchemaRagIndexInput['tables']>[number]>;
  revision: number;
};

export class SchemaRagEngine {
  /** One immutable-after-publication read slot per connection. */
  private readonly slots = new Map<string, SchemaRagSlot>();
  private readonly epochs = new Map<string, number>();
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
    this.assertSynchronousWriteAllowed(input.retrievalProfile);
    const epoch = this.reserveEpoch(input.connectionId);
    const candidate = this.buildCandidate(input);
    return this.publish(input.connectionId, epoch, candidate);
  }

  async indexAsync(input: SchemaRagIndexInput): Promise<SchemaRagIndex> {
    const epoch = this.reserveEpoch(input.connectionId);
    const candidate = this.buildCandidate(input);
    await this.buildVectors(candidate.index, candidate.profile);
    if (this.isCurrentEpoch(input.connectionId, epoch)) {
      return this.publish(input.connectionId, epoch, candidate);
    }
    throw new SchemaRagOperationSupersededError(input.connectionId);
  }

  upsertTables(input: SchemaRagIndexInput): SchemaRagIndex {
    if ((input.tables?.length ?? 0) === 0) return this.requireIndex(input.connectionId);
    const current = this.slots.get(input.connectionId);
    if (!current) return this.index(input);
    this.assertSynchronousWriteAllowed(input.retrievalProfile ?? current.profile);
    if (!current.legacyTables) {
      throw new Error(
        'Incremental TableDetail updates require an index originally built from TableDetail input.',
      );
    }
    const tables = new Map(current.legacyTables);
    for (const table of input.tables ?? []) {
      tables.set(tableDocumentId(table.schema, table.name), structuredClone(table));
    }
    const epoch = this.reserveEpoch(input.connectionId);
    const candidate = this.buildCandidate({
      connectionId: input.connectionId,
      tables: [...tables.values()],
      glossary: input.glossary ?? current.index.glossary,
      indexedAt: input.indexedAt ?? current.index.indexedAt,
      retrievalProfile: input.retrievalProfile ?? current.profile,
    });
    return this.publish(input.connectionId, epoch, candidate);
  }

  async upsertTablesAsync(input: SchemaRagIndexInput): Promise<SchemaRagIndex> {
    if ((input.tables?.length ?? 0) === 0) return this.requireIndex(input.connectionId);
    const current = this.slots.get(input.connectionId);
    if (!current) return await this.indexAsync(input);
    if (!current.legacyTables) {
      throw new Error(
        'Incremental TableDetail updates require an index originally built from TableDetail input.',
      );
    }
    const tables = new Map(current.legacyTables);
    for (const table of input.tables ?? []) {
      tables.set(tableDocumentId(table.schema, table.name), structuredClone(table));
    }
    const epoch = this.reserveEpoch(input.connectionId);
    const candidate = this.buildCandidate({
      connectionId: input.connectionId,
      tables: [...tables.values()],
      glossary: input.glossary ?? current.index.glossary,
      indexedAt: input.indexedAt ?? current.index.indexedAt,
      retrievalProfile: input.retrievalProfile ?? current.profile,
    });
    await this.buildVectors(candidate.index, candidate.profile);
    if (this.isCurrentEpoch(input.connectionId, epoch)) {
      return this.publish(input.connectionId, epoch, candidate);
    }
    throw new SchemaRagOperationSupersededError(input.connectionId);
  }

  private buildCandidate(input: SchemaRagIndexInput): Omit<SchemaRagSlot, 'revision'> {
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
    return {
      index,
      profile: retrievalProfile,
      ...(input.tables === undefined
        ? {}
        : {
            legacyTables: new Map(
              input.tables.map((table) => [
                tableDocumentId(table.schema, table.name),
                structuredClone(table),
              ]),
            ),
          }),
    };
  }

  loadIndex(index: SchemaRagIndex): SchemaRagIndex {
    assertRestoredIndex(index);
    const epoch = this.reserveEpoch(index.connectionId);
    return this.publish(index.connectionId, epoch, {
      index,
      profile: normalizeRetrievalProfile(index.retrievalProfile ?? this.defaultProfile),
    });
  }

  clear(connectionId: string): void {
    this.reserveEpoch(connectionId);
    this.slots.delete(connectionId);
  }

  hasIndex(connectionId: string): boolean {
    return this.slots.has(connectionId);
  }

  /** Captures one complete RAG slot; later publications do not alter this view. */
  captureReadView(connectionId: string): SchemaRagReadView {
    const slot = this.requireSlot(connectionId);
    const index = slot.index;
    const catalog = requireSlotCatalog(slot);
    const search = (input: Omit<SchemaRagSearchRequest, 'connectionId'>) =>
      structuredClone(searchSchemaRagIndex(index, { connectionId, ...input }));
    const searchAsync = async (input: Omit<SchemaRagSearchRequest, 'connectionId'>) =>
      structuredClone(
        await searchSchemaRagIndexAsync({
          index,
          request: { connectionId, ...input },
          profile: slot.profile,
          ...(this.embeddingAdapter === undefined
            ? {}
            : { embeddingAdapter: this.embeddingAdapter }),
          ...(this.rerankAdapter === undefined ? {} : { rerankAdapter: this.rerankAdapter }),
        }),
      );
    const listResources = (input: Omit<Parameters<SchemaRagEngine['listResources']>[0], 'connectionId'>) => {
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
    };
    const getResource = (input: Omit<Parameters<SchemaRagEngine['getResource']>[0], 'connectionId'>) => {
      const node = catalog.nodes[input.resourceId];
      if (!node) throw new Error(`Knowledge resource is not indexed: ${input.resourceId}`);
      const relationIds = new Set(node.relationIds);
      const applicableResourceIds = new Set([node.resourceId, ...node.ancestorIds]);
      const knowledgeIds = new Set(
        Object.values(catalog.bindings)
          .filter((binding) => binding.resourceId === node.resourceId ||
            (binding.mode === 'subtree' && applicableResourceIds.has(binding.resourceId)))
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
    };
    const listTables = (input: Omit<SchemaRagListTablesRequest, 'connectionId'>) =>
      index.documents
        .filter(isTableDocument)
        .filter((document) => input.schema === undefined || document.schema === input.schema)
        .sort((left, right) => left.title.localeCompare(right.title))
        .slice(0, input.limit ?? 200)
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
    const describeTable = (input: Omit<SchemaRagTableRef, 'connectionId'>) => {
      const table = resolveTable(index, { connectionId, ...input });
      const columns = index.documents
        .filter((document) => document.kind === 'column' && document.schema === table.schema && document.table === table.table)
        .sort((left, right) => left.title.localeCompare(right.title));
      const relatedTables = relatedTableDocuments(index, table);
      const sections = [
        `## ${table.title}`,
        table.text,
        columns.length ? `\n### Columns\n${columns.map((column) => `- ${column.title}: ${column.text.replace(/\n/g, '; ')}`).join('\n')}` : '',
        relatedTables.length ? `\n### Related tables\n${relatedTables.map((related) => `- ${related.title}`).join('\n')}` : '',
      ].filter(Boolean);
      const clipped = clipText(sections.join('\n'), input.maxChars ?? 4_000);
      return structuredClone({ table, columns, relatedTables, text: clipped.text, truncated: clipped.truncated });
    };
    const getRelations = (input: Omit<SchemaRagTableRef, 'connectionId'>) => {
      const table = resolveTable(index, { connectionId, ...input });
      const relatedTables = relatedTableDocuments(index, table);
      const relationDocuments = (index.graph.get(table.id) ? [...(index.graph.get(table.id) ?? [])] : [])
        .map((id) => index.documents.find((document) => document.id === id))
        .filter((document): document is SchemaRagDocument => document !== undefined);
      return structuredClone({ table, relatedTables, relationDocuments });
    };
    const buildContext = (input: Omit<SchemaRagContextRequest, 'connectionId'>) =>
      formatContext(input.query, search({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.explicitTables === undefined ? {} : { explicitTables: input.explicitTables }),
        ...(input.explicitColumns === undefined ? {} : { explicitColumns: input.explicitColumns }),
        includeRelations: true,
      }), input.maxChars ?? 4_000);
    const buildContextAsync = async (input: Omit<SchemaRagContextRequest, 'connectionId'>) =>
      formatContext(input.query, await searchAsync({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.explicitTables === undefined ? {} : { explicitTables: input.explicitTables }),
        ...(input.explicitColumns === undefined ? {} : { explicitColumns: input.explicitColumns }),
        includeRelations: true,
      }), input.maxChars ?? 4_000);
    const manifest = index.manifest;
    return Object.freeze({
      connectionId,
      getCatalog: () => structuredClone(catalog),
      getIndexManifest: () => {
        if (!manifest) throw new Error(`Schema RAG index manifest is not available for connection: ${connectionId}`);
        return structuredClone(manifest);
      },
      listResources,
      getResource,
      listTables,
      describeTable,
      getRelations,
      search,
      searchAsync,
      buildContext,
      buildContextAsync,
    });
  }

  hasTable(request: SchemaRagTableRef): boolean {
    const index = this.slots.get(request.connectionId)?.index;
    if (!index) return false;
    try {
      resolveTable(index, request);
      return true;
    } catch {
      return false;
    }
  }

  getCatalog(connectionId: string): KnowledgeCatalog {
    return this.captureReadView(connectionId).getCatalog();
  }

  getIndexManifest(connectionId: string): NonNullable<SchemaRagIndex['manifest']> {
    return this.captureReadView(connectionId).getIndexManifest();
  }

  listResources(input: {
    connectionId: string;
    parentId?: string;
    kinds?: string[];
    limit?: number;
  }): KnowledgeCatalogNode[] {
    const { connectionId, ...request } = input;
    return this.captureReadView(connectionId).listResources(request);
  }

  getResource(input: {
    connectionId: string;
    resourceId: string;
  }): {
    node: KnowledgeCatalogNode;
    relations: KnowledgeCatalog['relations'][string][];
    knowledge: KnowledgeCatalog['knowledge'][string][];
  } {
    const { connectionId, ...request } = input;
    return this.captureReadView(connectionId).getResource(request);
  }

  getIndexStatus(connectionId: string): SchemaRagIndexStatus {
    const index = this.slots.get(connectionId)?.index;
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
    const { connectionId, ...input } = request;
    return this.captureReadView(connectionId).listTables(input);
  }

  describeTable(request: SchemaRagTableRef): SchemaRagTableDescription {
    const { connectionId, ...input } = request;
    return this.captureReadView(connectionId).describeTable(input);
  }

  getRelations(request: SchemaRagTableRef): SchemaRagRelationsResult {
    const { connectionId, ...input } = request;
    return this.captureReadView(connectionId).getRelations(input);
  }

  search(request: SchemaRagSearchRequest): SchemaRagSearchResult[] {
    const { connectionId, ...input } = request;
    return this.captureReadView(connectionId).search(input);
  }

  async searchAsync(request: SchemaRagSearchRequest): Promise<SchemaRagSearchResult[]> {
    const { connectionId, ...input } = request;
    return await this.captureReadView(connectionId).searchAsync(input);
  }

  buildContext(request: SchemaRagContextRequest): SchemaRagContext {
    const { connectionId, ...input } = request;
    return this.captureReadView(connectionId).buildContext(input);
  }

  async buildContextAsync(request: SchemaRagContextRequest): Promise<SchemaRagContext> {
    const { connectionId, ...input } = request;
    return await this.captureReadView(connectionId).buildContextAsync(input);
  }

  private requireIndex(connectionId: string): SchemaRagIndex {
    return this.requireSlot(connectionId).index;
  }

  private requireSlot(connectionId: string): SchemaRagSlot {
    const slot = this.slots.get(connectionId);
    if (!slot) {
      throw new Error(`Schema RAG index is not available for connection: ${connectionId}`);
    }
    return slot;
  }

  private reserveEpoch(connectionId: string): number {
    const epoch = Math.max(
      this.epochs.get(connectionId) ?? 0,
      this.slots.get(connectionId)?.revision ?? 0,
    ) + 1;
    this.epochs.set(connectionId, epoch);
    return epoch;
  }

  private isCurrentEpoch(connectionId: string, epoch: number): boolean {
    return this.epochs.get(connectionId) === epoch;
  }

  private publish(
    connectionId: string,
    epoch: number,
    candidate: Omit<SchemaRagSlot, 'revision'>,
  ): SchemaRagIndex {
    // A candidate belongs to its builder; the live slot receives a distinct object graph.
    // Readers retain this one graph until their bound view is released by GC.
    const ownedIndex = structuredClone(candidate.index);
    this.slots.set(connectionId, { ...candidate, index: ownedIndex, revision: epoch });
    return structuredClone(ownedIndex);
  }

  private assertSynchronousWriteAllowed(profile: SchemaRagRetrievalProfile | undefined): void {
    const resolved = normalizeRetrievalProfile(profile ?? this.defaultProfile);
    if (resolved.embedding) {
      throw new Error(
        `Schema RAG retrieval profile ${resolved.id} requires asynchronous indexing because it configures embeddings.`,
      );
    }
  }

  private async buildVectors(
    index: SchemaRagIndex,
    profile: SchemaRagRetrievalProfile,
  ): Promise<SchemaRagIndex> {
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

function requireSlotCatalog(slot: SchemaRagSlot): KnowledgeCatalog {
  if (!slot.index.catalog) {
    throw new Error(`Knowledge catalog is not available for connection: ${slot.index.connectionId}`);
  }
  return slot.index.catalog;
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
  if (index.retrievalProfile?.embedding && index.vectors === undefined) {
    throw new Error('Schema RAG restored index configures embeddings but does not contain vectors.');
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
