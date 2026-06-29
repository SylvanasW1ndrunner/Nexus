import type { Result, TableDetail } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import type {
  ProgressiveSchemaRagIndexer,
  ProgressiveSchemaRagIndexResult,
} from './progressive-schema-rag-indexer.js';
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
