import type {
  SchemaRagContextRequest,
  SchemaRagListTablesRequest,
  SchemaRagRelationsResult,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
  SchemaRagTableDescription,
  SchemaRagTableRef,
  SchemaRagTableSummary,
} from '@dbagent/core-rag';
import type { ToolRegistry } from './tool-registry.js';

export type AgentSchemaRagService = {
  search(request: SchemaRagSearchRequest): SchemaRagSearchResult[];
  buildContext(request: SchemaRagContextRequest): { text: string; truncated: boolean; documents: SchemaRagSearchResult[] };
  listTables(request: SchemaRagListTablesRequest): SchemaRagTableSummary[];
  describeTable(request: SchemaRagTableRef): SchemaRagTableDescription;
  getRelations(request: SchemaRagTableRef): SchemaRagRelationsResult;
};

export type RegisterSchemaRagToolsOptions = {
  defaultConnectionId?: string;
  defaultLimit?: number;
  maxContextChars?: number;
  skipExistingTools?: boolean;
};

export const SCHEMA_RAG_TOOL_NAMES = {
  searchSchema: 'search_schema',
  describeTable: 'describe_table',
  listTables: 'list_tables',
  getRelations: 'get_relations',
} as const;

export function registerSchemaRagTools(
  registry: ToolRegistry,
  rag: AgentSchemaRagService,
  options: RegisterSchemaRagToolsOptions = {},
): void {
  registerRagTool(
    registry,
    options,
    {
      name: SCHEMA_RAG_TOOL_NAMES.searchSchema,
      description: 'Search indexed database schema by business question, table name, column name, or glossary term.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
          includeRelations: { type: 'boolean' },
          maxContextChars: { type: 'number' },
        },
        required: ['query'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    (args) => {
      const connectionId = resolveConnectionId(args, options);
      const query = requireString(args.query, 'query');
      const limit = optionalPositiveInteger(args.limit, 'limit') ?? options.defaultLimit ?? 8;
      const includeRelations = typeof args.includeRelations === 'boolean' ? args.includeRelations : true;
      const maxChars = optionalPositiveInteger(args.maxContextChars, 'maxContextChars') ?? options.maxContextChars ?? 2_000;
      const results = rag.search({ connectionId, query, limit, includeRelations });
      const context = rag.buildContext({ connectionId, query, limit, maxChars });
      return {
        connectionId,
        query,
        count: results.length,
        contextText: context.text,
        truncated: context.truncated,
        results: results.map((result) => ({
          id: result.document.id,
          kind: result.document.kind,
          title: result.document.title,
          score: result.score,
          reasons: result.reasons,
          preview: previewText(result.document.text),
        })),
      };
    },
  );

  registerRagTool(
    registry,
    options,
    {
      name: SCHEMA_RAG_TOOL_NAMES.describeTable,
      description: 'Describe one indexed table with columns and related tables. Use schema.table when table names are ambiguous.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          schema: { type: 'string' },
          table: { type: 'string' },
          maxChars: { type: 'number' },
        },
        required: ['table'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    (args) => {
      const description = rag.describeTable({
        connectionId: resolveConnectionId(args, options),
        table: requireString(args.table, 'table'),
        ...(typeof args.schema === 'string' && args.schema.trim() ? { schema: args.schema.trim() } : {}),
        maxChars: optionalPositiveInteger(args.maxChars, 'maxChars') ?? options.maxContextChars ?? 4_000,
      });
      return {
        table: documentSummary(description.table),
        columns: description.columns.map(documentSummary),
        relatedTables: description.relatedTables.map(documentSummary),
        text: description.text,
        truncated: description.truncated,
      };
    },
  );

  registerRagTool(
    registry,
    options,
    {
      name: SCHEMA_RAG_TOOL_NAMES.listTables,
      description: 'List indexed tables in a connection, optionally limited to one schema.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          schema: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    (args) => ({
      connectionId: resolveConnectionId(args, options),
      tables: rag.listTables({
        connectionId: resolveConnectionId(args, options),
        ...(typeof args.schema === 'string' && args.schema.trim() ? { schema: args.schema.trim() } : {}),
        limit: optionalPositiveInteger(args.limit, 'limit') ?? 200,
      }),
    }),
  );

  registerRagTool(
    registry,
    options,
    {
      name: SCHEMA_RAG_TOOL_NAMES.getRelations,
      description: 'Return direct relation context for one indexed table.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          schema: { type: 'string' },
          table: { type: 'string' },
        },
        required: ['table'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    (args) => {
      const relations = rag.getRelations({
        connectionId: resolveConnectionId(args, options),
        table: requireString(args.table, 'table'),
        ...(typeof args.schema === 'string' && args.schema.trim() ? { schema: args.schema.trim() } : {}),
      });
      return {
        table: documentSummary(relations.table),
        relatedTables: relations.relatedTables.map(documentSummary),
        relationDocuments: relations.relationDocuments.map(documentSummary),
      };
    },
  );
}

function registerRagTool(
  registry: ToolRegistry,
  options: RegisterSchemaRagToolsOptions,
  definition: Parameters<ToolRegistry['register']>[0],
  handler: Parameters<ToolRegistry['register']>[1],
): void {
  if (options.skipExistingTools && registry.has(definition.name)) return;
  registry.register(definition, handler);
}

function resolveConnectionId(args: Record<string, unknown>, options: RegisterSchemaRagToolsOptions): string {
  if (typeof args.connectionId === 'string' && args.connectionId.trim()) return args.connectionId.trim();
  if (options.defaultConnectionId) return options.defaultConnectionId;
  throw new Error('connectionId is required.');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function documentSummary(document: { id: string; kind: string; title: string; schema: string; table: string; column?: string }) {
  return {
    id: document.id,
    kind: document.kind,
    title: document.title,
    schema: document.schema,
    table: document.table,
    ...(document.column === undefined ? {} : { column: document.column }),
  };
}

function previewText(text: string): string {
  return text.length > 240 ? `${text.slice(0, 225)}...[truncated]` : text;
}
