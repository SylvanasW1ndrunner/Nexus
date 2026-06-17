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
  indexedAt: string;
};

export type SchemaRagSearchRequest = {
  connectionId: string;
  query: string;
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
  maxChars?: number;
  limit?: number;
};

export type SchemaRagContext = {
  query: string;
  documents: SchemaRagSearchResult[];
  text: string;
  truncated: boolean;
};

export type SchemaRagIndexInput = {
  connectionId: string;
  tables: TableDetail[];
  indexedAt?: string;
};
