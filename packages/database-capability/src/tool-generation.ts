import type { ToolInvocationContribution } from '@dbagent/core-agent';
import {
  createAiSqlToolContributions,
  type ActiveDatabaseBinding,
  type AiSqlQueryExecutor,
  type AiSqlResultContentResolver,
} from './ai-sql-tools.js';

export type DatabaseToolGeneration = Readonly<{
  binding: ActiveDatabaseBinding;
  contributions: readonly ToolInvocationContribution[];
}>;

/**
 * Build one immutable Tool generation. A later active-profile change creates
 * another generation; existing turns retain this generation's binding.
 */
export function createDatabaseToolGeneration(input: Readonly<{
  binding: ActiveDatabaseBinding;
  handlerGeneration?: string;
  queryExecutor: AiSqlQueryExecutor;
  resultContent?: AiSqlResultContentResolver;
  ensureSchemaFresh?(input: Readonly<{
    binding: ActiveDatabaseBinding;
    force: boolean;
    signal?: AbortSignal;
  }>): Promise<ActiveDatabaseBinding>;
  onSchemaChanged?(input: Readonly<{
    binding: ActiveDatabaseBinding;
    sql: string;
    parsed: Parameters<NonNullable<Parameters<typeof createAiSqlToolContributions>[0]['onSchemaChanged']>>[0]['parsed'];
    result: Parameters<NonNullable<Parameters<typeof createAiSqlToolContributions>[0]['onSchemaChanged']>>[0]['result'];
  }>): void | Promise<void>;
}>): DatabaseToolGeneration {
  const binding = Object.freeze({ ...input.binding });
  const tools = createAiSqlToolContributions({
    binding,
    ...(input.handlerGeneration === undefined ? {} : { handlerGeneration: input.handlerGeneration }),
    queryExecutor: input.queryExecutor,
    ...(input.resultContent === undefined ? {} : { resultContent: input.resultContent }),
    ...(input.ensureSchemaFresh === undefined ? {} : { ensureSchemaFresh: input.ensureSchemaFresh }),
    ...(input.onSchemaChanged === undefined ? {} : { onSchemaChanged: input.onSchemaChanged }),
  });
  return Object.freeze({ binding, contributions: tools.contributions });
}
