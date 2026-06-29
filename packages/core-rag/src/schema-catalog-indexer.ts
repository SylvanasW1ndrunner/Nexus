import type { Result, TableDetail } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import type {
  ProgressiveSchemaRagIndexer,
  ProgressiveSchemaRagIndexResult,
} from './progressive-schema-rag-indexer.js';
import {
  parseExplicitSchemaReference,
  type SchemaRagExplicitReference,
} from './explicit-references.js';
import type {
  SchemaRagGlossaryEntry,
  SchemaRagIndexInput,
  SchemaRagProgressiveIndexOptions,
} from './types.js';

export type SchemaCatalogTableSummary = {
  schema: string;
  name: string;
  type: 'table' | 'view';
  comment?: string;
};

export type SchemaCatalogReader = {
  listTables(connectionId: string): Promise<Result<SchemaCatalogTableSummary[]>>;
  describeTable(connectionId: string, schema: string, table: string): Promise<Result<TableDetail>>;
};

export type SchemaCatalogIndexWarning = {
  schema: string;
  table: string;
  code: string;
  message: string;
  retryable?: boolean;
};

export type SchemaCatalogIndexRequest = {
  connectionId: string;
  reader: SchemaCatalogReader;
  indexer: ProgressiveSchemaRagIndexer;
  glossary?: SchemaRagGlossaryEntry[];
  indexedAt?: string;
  includeSchemas?: string[];
  excludeSchemas?: string[];
  tableLimit?: number;
  describeConcurrency?: number;
  continueOnTableError?: boolean;
  hotTableLimit?: number;
};

export type SchemaCatalogIndexResult = ProgressiveSchemaRagIndexResult & {
  tables: TableDetail[];
  requestedTableCount: number;
  indexedTableCount: number;
  skippedTableCount: number;
  warnings: SchemaCatalogIndexWarning[];
};

export type SchemaCatalogEnsureRequest = {
  connectionId: string;
  reader: SchemaCatalogReader;
  indexer: ProgressiveSchemaRagIndexer;
  references: Array<string | SchemaRagExplicitReference>;
  glossary?: SchemaRagGlossaryEntry[];
  indexedAt?: string;
  continueOnTableError?: boolean;
};

export type SchemaCatalogEnsureResult = ProgressiveSchemaRagIndexResult & {
  requestedReferenceCount: number;
  indexedTableCount: number;
  skippedReferenceCount: number;
  tables: TableDetail[];
  warnings: SchemaCatalogIndexWarning[];
};

export async function indexSchemaCatalogFromReader(
  request: SchemaCatalogIndexRequest,
): Promise<Result<SchemaCatalogIndexResult>> {
  const summariesResult = await request.reader.listTables(request.connectionId);
  if (!summariesResult.ok) return summariesResult;

  const summaries = filterCatalogTables(summariesResult.data, request);
  const describeResults = await mapWithConcurrency(
    summaries,
    normalizeConcurrency(request.describeConcurrency),
    async (summary) => {
      const detail = await request.reader.describeTable(
        request.connectionId,
        summary.schema,
        summary.name,
      );
      return { summary, detail };
    },
  );

  const tables: TableDetail[] = [];
  const warnings: SchemaCatalogIndexWarning[] = [];
  const continueOnTableError = request.continueOnTableError ?? true;

  for (const result of describeResults) {
    if (result.detail.ok) {
      tables.push(result.detail.data);
      continue;
    }

    if (!continueOnTableError) return err(result.detail.error);
    warnings.push({
      schema: result.summary.schema,
      table: result.summary.name,
      code: result.detail.error.code,
      message: result.detail.error.message,
      ...(result.detail.error.retryable === undefined
        ? {}
        : { retryable: result.detail.error.retryable }),
    });
  }

  const input: SchemaRagIndexInput = {
    connectionId: request.connectionId,
    tables,
    ...(request.glossary === undefined ? {} : { glossary: request.glossary }),
    ...(request.indexedAt === undefined ? {} : { indexedAt: request.indexedAt }),
  };
  const progressiveOptions: SchemaRagProgressiveIndexOptions = {
    ...(request.hotTableLimit === undefined ? {} : { hotTableLimit: request.hotTableLimit }),
  };
  const result = await request.indexer.index(input, progressiveOptions);

  return ok({
    ...result,
    tables,
    requestedTableCount: summaries.length,
    indexedTableCount: tables.length,
    skippedTableCount: warnings.length,
    warnings,
  });
}

export async function ensureSchemaCatalogTablesIndexed(
  request: SchemaCatalogEnsureRequest,
): Promise<Result<SchemaCatalogEnsureResult>> {
  const references = normalizeEnsureReferences(request.references);
  if (references.length === 0) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'At least one table reference is required for on-demand Schema RAG indexing.',
    });
  }

  const summariesResult = await request.reader.listTables(request.connectionId);
  if (!summariesResult.ok) return summariesResult;

  const resolved = resolveCatalogReferences(references, summariesResult.data);
  const describeResults = await mapWithConcurrency(resolved.tables, 4, async (summary) => {
    const detail = await request.reader.describeTable(
      request.connectionId,
      summary.schema,
      summary.name,
    );
    return { summary, detail };
  });

  const tables: TableDetail[] = [];
  const warnings = [...resolved.warnings];
  const continueOnTableError = request.continueOnTableError ?? true;
  for (const result of describeResults) {
    if (result.detail.ok) {
      tables.push(result.detail.data);
      continue;
    }
    if (!continueOnTableError) return err(result.detail.error);
    warnings.push({
      schema: result.summary.schema,
      table: result.summary.name,
      code: result.detail.error.code,
      message: result.detail.error.message,
      ...(result.detail.error.retryable === undefined
        ? {}
        : { retryable: result.detail.error.retryable }),
    });
  }

  if (tables.length === 0) {
    return err({
      code: 'NOT_FOUND',
      message: 'No referenced tables could be resolved for on-demand Schema RAG indexing.',
    });
  }

  const result = await request.indexer.upsertTables({
    connectionId: request.connectionId,
    tables,
    ...(request.glossary === undefined ? {} : { glossary: request.glossary }),
    ...(request.indexedAt === undefined ? {} : { indexedAt: request.indexedAt }),
  });

  return ok({
    ...result,
    requestedReferenceCount: references.length,
    indexedTableCount: tables.length,
    skippedReferenceCount: warnings.length,
    tables,
    warnings,
  });
}

function filterCatalogTables(
  summaries: SchemaCatalogTableSummary[],
  request: Pick<SchemaCatalogIndexRequest, 'includeSchemas' | 'excludeSchemas' | 'tableLimit'>,
): SchemaCatalogTableSummary[] {
  const includeSchemas =
    request.includeSchemas === undefined ? undefined : new Set(request.includeSchemas);
  const excludeSchemas = new Set(request.excludeSchemas ?? ['information_schema', 'pg_catalog']);
  return summaries
    .filter((table) => includeSchemas === undefined || includeSchemas.has(table.schema))
    .filter((table) => !excludeSchemas.has(table.schema))
    .sort(
      (left, right) =>
        left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name),
    )
    .slice(0, request.tableLimit ?? summaries.length);
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 4;
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(16, Math.floor(value)));
}

function normalizeEnsureReferences(
  references: Array<string | SchemaRagExplicitReference>,
): SchemaRagExplicitReference[] {
  const parsed: SchemaRagExplicitReference[] = [];
  for (const reference of references) {
    if (typeof reference === 'string') {
      const normalized = parseExplicitSchemaReference(
        reference.startsWith('@') ? reference.slice(1) : reference,
      );
      if (normalized) parsed.push(normalized);
      continue;
    }
    parsed.push(reference);
  }
  const seen = new Set<string>();
  const unique: SchemaRagExplicitReference[] = [];
  for (const reference of parsed) {
    const key = `${reference.schema ?? ''}.${reference.table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}

function resolveCatalogReferences(
  references: SchemaRagExplicitReference[],
  summaries: SchemaCatalogTableSummary[],
): { tables: SchemaCatalogTableSummary[]; warnings: SchemaCatalogIndexWarning[] } {
  const tables: SchemaCatalogTableSummary[] = [];
  const warnings: SchemaCatalogIndexWarning[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    const matches = summaries.filter(
      (summary) =>
        summary.name === reference.table &&
        (reference.schema === undefined || summary.schema === reference.schema),
    );
    if (matches.length === 0) {
      warnings.push({
        schema: reference.schema ?? '',
        table: reference.table,
        code: 'NOT_FOUND',
        message: `Referenced table is not present in database catalog: ${formatReference(reference)}.`,
      });
      continue;
    }
    if (matches.length > 1) {
      warnings.push({
        schema: reference.schema ?? '',
        table: reference.table,
        code: 'AMBIGUOUS_TABLE',
        message: `Referenced table is ambiguous: ${reference.table}. Candidates: ${matches
          .map((summary) => `${summary.schema}.${summary.name}`)
          .join(', ')}.`,
      });
      continue;
    }
    const match = matches[0]!;
    const key = `${match.schema}.${match.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push(match);
  }

  return { tables, warnings };
}

function formatReference(reference: SchemaRagExplicitReference): string {
  return reference.schema ? `${reference.schema}.${reference.table}` : reference.table;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}
