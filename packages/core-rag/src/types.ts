import type {
  ResourceDescriptor,
  ResourceKind,
  ResourceRelation,
  TableDetail,
} from '@dbagent/shared';

export type SchemaRagDocumentKind =
  | ResourceKind
  | 'knowledge'
  | 'relation';

export type SchemaRagDocument = {
  id: string;
  connectionId: string;
  kind: SchemaRagDocumentKind;
  resourceId?: string;
  schema: string;
  table: string;
  column?: string;
  title: string;
  text: string;
  tokens: string[];
  relationIds: string[];
  metadata: Record<string, unknown>;
};

export type SchemaRagIndex = {
  connectionId: string;
  documents: SchemaRagDocument[];
  graph: Map<string, Set<string>>;
  glossary: SchemaRagGlossaryEntry[];
  catalog?: KnowledgeCatalog;
  manifest?: SchemaRagIndexManifest;
  retrievalProfile?: SchemaRagRetrievalProfile;
  vectors?: Record<string, number[]>;
  indexedAt: string;
};

export type KnowledgeBindingMode = 'node' | 'subtree';

export type BusinessKnowledgeSource = {
  type: 'manual' | 'import' | 'mcp' | (string & {});
  id: string;
  version?: string;
};

export type BusinessKnowledgeItem = {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  contentHash: string;
  tags: string[];
  source: BusinessKnowledgeSource;
  version: number;
  updatedAt: string;
};

export type BusinessKnowledgeInput = Omit<
  BusinessKnowledgeItem,
  'connectionId' | 'contentHash' | 'tags'
> & {
  tags?: string[];
};

export type KnowledgeBinding = {
  id: string;
  connectionId: string;
  knowledgeId: string;
  resourceId: string;
  mode: KnowledgeBindingMode;
  version: number;
  updatedAt: string;
};

export type KnowledgeBindingInput = Omit<KnowledgeBinding, 'connectionId'>;

export type KnowledgeCatalogNode = {
  resourceId: string;
  connectionId: string;
  kind: ResourceKind;
  parentId?: string;
  canonicalName: string;
  displayName: string;
  path: string;
  ancestorIds: string[];
  depth: number;
  childIds: string[];
  relationIds: string[];
  knowledgeBindingIds: string[];
  localFacts: Record<string, unknown>;
  localHash: string;
  childBlockHashes: string[];
  subtreeHash: string;
};

export type KnowledgeCatalog = {
  version: 1;
  connectionId: string;
  rootIds: string[];
  nodes: Record<string, KnowledgeCatalogNode>;
  relations: Record<string, ResourceRelation>;
  knowledge: Record<string, BusinessKnowledgeItem>;
  bindings: Record<string, KnowledgeBinding>;
  sourceRevision?: string;
  containmentRootHash: string;
  relationRootHash: string;
  knowledgeRootHash: string;
  catalogRootHash: string;
  snapshotId: string;
  builtAt: string;
};

export type KnowledgeCatalogInput = {
  connectionId: string;
  resources: ResourceDescriptor[];
  relations?: ResourceRelation[];
  knowledge?: BusinessKnowledgeInput[];
  bindings?: KnowledgeBindingInput[];
  sourceRevision?: string;
  builtAt?: string;
};

export type KnowledgeCatalogChange = {
  resourceId: string;
  kind: 'added' | 'removed' | 'changed';
};

export type KnowledgeCatalogDiff = {
  equal: boolean;
  previousRootHash: string;
  nextRootHash: string;
  changedResources: KnowledgeCatalogChange[];
  changedRelationIds: string[];
  changedKnowledgeIds: string[];
};

export type EmbeddingProfile = {
  providerInstanceId: string;
  modelId: string;
  modelRevision?: string;
  dimensions?: number;
  normalization: 'none' | 'l2';
  distanceMetric: 'cosine' | 'dot' | 'euclidean';
  requestTemplateVersion: string;
};

export type RerankProfile = {
  providerInstanceId: string;
  modelId: string;
  modelRevision?: string;
  topN?: number;
};

export type RetrievalBackendProfile = {
  type: 'memory' | (string & {});
  bm25K1?: number;
  bm25B?: number;
};

export type SchemaRagRetrievalProfile = {
  id: string;
  version: number;
  backend: RetrievalBackendProfile;
  embedding?: EmbeddingProfile;
  reranker?: RerankProfile;
  defaultLimit?: number;
  defaultMaxContextTokens?: number;
  graphHops?: number;
  rrfK?: number;
};

export type SchemaRagIndexManifest = {
  version: 1;
  connectionId: string;
  catalogRootHash: string;
  retrievalProfileId: string;
  retrievalProfileVersion: number;
  embeddingFingerprint?: string;
  documentCount: number;
  indexVersion: string;
  createdAt: string;
};

export type SchemaRagEmbeddingAdapter = {
  embed(input: {
    profile: EmbeddingProfile;
    texts: string[];
  }): Promise<number[][]>;
};

export type SchemaRagRerankAdapter = {
  rerank(input: {
    profile: RerankProfile;
    query: string;
    documents: Array<{ id: string; text: string }>;
  }): Promise<Array<{ id: string; score: number }>>;
};

export type SchemaRagIndexStage =
  | 'idle'
  | 'skeleton'
  | 'hot_tables'
  | 'long_tail'
  | 'ready'
  | 'failed';

export type SchemaRagIndexStageState = 'pending' | 'running' | 'completed' | 'failed';

export type SchemaRagIndexStageStatus = {
  stage: SchemaRagIndexStage;
  state: SchemaRagIndexStageState;
  done: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type SchemaRagIndexStatus = {
  connectionId: string;
  stage: SchemaRagIndexStage;
  ready: boolean;
  documentCount: number;
  tableCount: number;
  columnCount: number;
  relationCount: number;
  glossaryCount: number;
  indexedAt?: string;
  updatedAt: string;
  stages: SchemaRagIndexStageStatus[];
};

export type SchemaRagProgressiveIndexOptions = {
  hotTableLimit?: number;
};

export type SchemaRagSearchRequest = {
  connectionId: string;
  query: string;
  explicitTables?: string[];
  explicitColumns?: string[];
  limit?: number;
  includeRelations?: boolean;
  expandHops?: number;
  maxContextTokens?: number;
};

export type SchemaRagRetrievalChannel = 'explicit' | 'keyword' | 'glossary' | 'graph' | 'vector' | 'rerank';

export type SchemaRagScoreDetail = {
  channel: SchemaRagRetrievalChannel;
  score: number;
  rank?: number;
  reasons: string[];
};

export type SchemaRagSearchResult = {
  document: SchemaRagDocument;
  score: number;
  reasons: string[];
  scoreDetails?: SchemaRagScoreDetail[];
};

export type SchemaRagRetriever = {
  search(index: SchemaRagIndex, request: SchemaRagSearchRequest): SchemaRagSearchResult[];
};

export type SchemaRagContextRequest = {
  connectionId: string;
  query: string;
  explicitTables?: string[];
  explicitColumns?: string[];
  maxChars?: number;
  limit?: number;
};

export type SchemaRagContext = {
  query: string;
  documents: SchemaRagSearchResult[];
  text: string;
  truncated: boolean;
};

export type SchemaRagTableRef = {
  connectionId: string;
  table: string;
  schema?: string;
  maxChars?: number;
};

export type SchemaRagTableSummary = {
  id: string;
  schema: string;
  table: string;
  title: string;
  type?: string;
  columnCount?: number;
};

export type SchemaRagListTablesRequest = {
  connectionId: string;
  schema?: string;
  limit?: number;
};

export type SchemaRagTableDescription = {
  table: SchemaRagDocument;
  columns: SchemaRagDocument[];
  relatedTables: SchemaRagDocument[];
  text: string;
  truncated: boolean;
};

export type SchemaRagRelationsResult = {
  table: SchemaRagDocument;
  relatedTables: SchemaRagDocument[];
  relationDocuments: SchemaRagDocument[];
};

export type SchemaRagIndexInput = {
  connectionId: string;
  tables?: TableDetail[];
  resources?: ResourceDescriptor[];
  relations?: ResourceRelation[];
  knowledge?: BusinessKnowledgeInput[];
  bindings?: KnowledgeBindingInput[];
  sourceRevision?: string;
  retrievalProfile?: SchemaRagRetrievalProfile;
  glossary?: SchemaRagGlossaryEntry[];
  indexedAt?: string;
};

export type SchemaRagGlossaryEntry = {
  term: string;
  aliases?: string[];
  description?: string;
  documentIds: string[];
  weight?: number;
};

export type SchemaRagEvaluationCase = {
  id: string;
  query: string;
  mustInclude: string[];
  shouldInclude?: string[];
  mustNotInclude?: string[];
  limit?: number;
  includeRelations?: boolean;
};

export type SchemaRagEvaluationCaseResult = {
  id: string;
  query: string;
  retrievedIds: string[];
  missingMustInclude: string[];
  missingShouldInclude: string[];
  unexpectedIds: string[];
  mustHitRate: number;
  shouldHitRate: number;
  passed: boolean;
};

export type SchemaRagEvaluationSummary = {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageMustHitRate: number;
  averageShouldHitRate: number;
  results: SchemaRagEvaluationCaseResult[];
};
