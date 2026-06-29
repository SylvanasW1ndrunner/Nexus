import type { TableDetail } from '@dbagent/shared';

export type SchemaRagDocumentKind = 'table' | 'column' | 'relation';

export type SchemaRagDocument = {
  id: string;
  connectionId: string;
  kind: SchemaRagDocumentKind;
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
  indexedAt: string;
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
};

export type SchemaRagSearchResult = {
  document: SchemaRagDocument;
  score: number;
  reasons: string[];
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
  tables: TableDetail[];
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
