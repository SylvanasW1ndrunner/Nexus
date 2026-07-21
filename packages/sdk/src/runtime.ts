import { randomUUID } from 'node:crypto';
import {
  PostgresDriver,
  analyzeSqlSafety,
  type DatabaseConnectionConfig,
  type IDatabaseDriver,
} from '@dbagent/core-db';
import { LlmProviderError, type LlmProvider } from '@dbagent/core-llm';
import { SchemaRagEngine } from '@dbagent/core-rag';
import type { QuerySafetyReport, SavedConnection } from '@dbagent/shared';
import { DatabaseAgentError, asDatabaseAgentError } from './errors.js';
import { parseGeneratedSqlResponse } from './parse-generation.js';
import type {
  ConnectionTestResult,
  DatabaseAgentRuntimeOptions,
  ExecuteGeneratedOptions,
  ExecutedSqlRun,
  GenerateSqlInput,
  GeneratedSqlEvidence,
  GeneratedSqlRun,
  IndexSchemaOptions,
  PostgresConnectionInput,
  RuntimeStatus,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
} from './types.js';

const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1_000;
const DEFAULT_MAX_SCHEMA_TABLES = 200;
const MAX_SCHEMA_TABLES = 1_000;
const DEFAULT_CONTEXT_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_QUESTION_CHARS = 4_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const EXECUTABLE_STATEMENT_KINDS = new Set(['SELECT', 'WITH', 'VALUES']);

export class DatabaseAgentRuntime {
  private readonly driver: IDatabaseDriver;
  private readonly rag: SchemaRagEngine;
  private readonly createRunId: () => string;
  private readonly createConnectionId: () => string;
  private readonly now: () => string;
  private readonly defaultRowLimit: number;
  private readonly runs = new Map<string, SqlRunSnapshot>();
  private provider?: LlmProvider;
  private model?: string;
  private connection: SavedConnection | undefined;
  private indexTruncated = false;

  constructor(options: DatabaseAgentRuntimeOptions = {}) {
    this.driver = options.driver ?? new PostgresDriver();
    this.rag = options.rag ?? new SchemaRagEngine();
    this.createRunId = options.createRunId ?? randomUUID;
    this.createConnectionId = options.createConnectionId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultRowLimit = normalizeInteger(
      options.defaultRowLimit ?? DEFAULT_ROW_LIMIT,
      'defaultRowLimit',
      1,
      MAX_ROW_LIMIT,
    );
    if (options.provider || options.model) {
      if (!options.provider || !options.model?.trim()) {
        throw new DatabaseAgentError('INVALID_INPUT', 'provider 和 model 必须同时配置。', false);
      }
      this.provider = options.provider;
      this.model = options.model.trim();
    }
  }

  configureProvider(provider: LlmProvider, model: string): void {
    const normalizedModel = requireText(model, 'model', 300);
    this.provider = provider;
    this.model = normalizedModel;
  }

  async testConnection(input: PostgresConnectionInput): Promise<ConnectionTestResult> {
    const config = normalizeConnection(input, input.id ?? 'connection-test');
    const result = await this.driver.test(config);
    if (!result.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        result.error.message,
        result.error.retryable ?? true,
        result.error.detail,
      );
    }
    return { latencyMs: result.data.latencyMs, readOnly: true };
  }

  async connect(input: PostgresConnectionInput): Promise<SavedConnection> {
    if (this.connection) await this.disconnect();
    const config = normalizeConnection(input, input.id ?? this.createConnectionId());
    const result = await this.driver.connect(config);
    if (!result.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        result.error.message,
        result.error.retryable ?? true,
        result.error.detail,
      );
    }
    this.connection = result.data;
    this.indexTruncated = false;
    return cloneConnection(result.data);
  }

  async disconnect(): Promise<void> {
    const current = this.connection;
    if (!current) return;
    const result = await this.driver.disconnect(current.id);
    if (!result.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        result.error.message,
        result.error.retryable ?? true,
        result.error.detail,
      );
    }
    this.rag.clear(current.id);
    this.connection = undefined;
    this.indexTruncated = false;
    this.runs.clear();
  }

  async indexSchema(options: IndexSchemaOptions = {}): Promise<SchemaIndexSnapshot> {
    const connection = this.requireConnection();
    const maxTables = normalizeInteger(
      options.maxTables ?? DEFAULT_MAX_SCHEMA_TABLES,
      'maxTables',
      1,
      MAX_SCHEMA_TABLES,
    );
    const listed = await this.driver.listTables(connection.id);
    if (!listed.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        listed.error.message,
        listed.error.retryable ?? true,
        listed.error.detail,
      );
    }
    const selected = listed.data.slice(0, maxTables);
    const tables = await mapInBatches(selected, 4, async (table) => {
      const described = await this.driver.describeTable(connection.id, table.schema, table.name);
      if (!described.ok) {
        throw new DatabaseAgentError(
          'CONNECTION_FAILED',
          described.error.message,
          described.error.retryable ?? true,
          described.error.detail,
        );
      }
      return described.data;
    });
    this.rag.index({ connectionId: connection.id, tables, indexedAt: this.now() });
    this.indexTruncated = listed.data.length > selected.length;
    return this.schemaStatus();
  }

  schemaStatus(): SchemaIndexSnapshot {
    const connection = this.connection;
    if (!connection) {
      return emptySchemaStatus('not_connected');
    }
    const status = this.rag.getIndexStatus(connection.id);
    if (!status.ready) {
      return {
        connectionId: connection.id,
        ...emptySchemaStatus('not_indexed'),
      };
    }
    return {
      connectionId: connection.id,
      stage: 'ready',
      ready: true,
      tableCount: status.tableCount,
      columnCount: status.columnCount,
      relationCount: status.relationCount,
      documentCount: status.documentCount,
      truncated: this.indexTruncated,
      ...(status.indexedAt === undefined ? {} : { indexedAt: status.indexedAt }),
    };
  }

  status(): RuntimeStatus {
    return {
      providerConfigured: Boolean(this.provider && this.model),
      ...(this.model === undefined ? {} : { model: this.model }),
      connected: Boolean(this.connection),
      ...(this.connection === undefined ? {} : { connection: cloneConnection(this.connection) }),
      schema: this.schemaStatus(),
      runCount: this.runs.size,
    };
  }

  async generate(input: GenerateSqlInput): Promise<GeneratedSqlRun> {
    const provider = this.requireProvider();
    const model = this.model!;
    const connection = this.requireConnection();
    if (!this.rag.hasIndex(connection.id)) {
      throw new DatabaseAgentError('SCHEMA_NOT_INDEXED', '请先索引数据库 Schema。', true);
    }
    const question = requireText(input.question, 'question', MAX_QUESTION_CHARS);
    const maxContextChars = normalizeInteger(
      input.maxContextChars ?? DEFAULT_CONTEXT_CHARS,
      'maxContextChars',
      1_000,
      MAX_CONTEXT_CHARS,
    );
    if (input.signal?.aborted) {
      throw new DatabaseAgentError('ABORTED', 'SQL 生成已取消。', false);
    }

    const context = this.rag.buildContext({
      connectionId: connection.id,
      query: question,
      maxChars: maxContextChars,
      limit: 12,
    });
    const contextText = context.text || this.fallbackSchemaContext(connection.id, maxContextChars);

    let response;
    try {
      response = await provider.chat({
        model,
        temperature: 0,
        maxTokens: 1_200,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: `用户问题：\n${question}\n\n可用 PostgreSQL Schema：\n${contextText}`,
          },
        ],
      });
    } catch (error) {
      throw mapLlmError(error);
    }

    const parsed = parseGeneratedSqlResponse(response.text);
    const safety = analyzeSqlSafety(parsed.sql, { readOnly: true });
    const executable = isExecutableSafety(safety);
    const timestamp = this.now();
    const run: GeneratedSqlRun = {
      runId: this.createRunId(),
      status: executable ? 'awaiting_execution' : 'blocked',
      question,
      sql: parsed.sql,
      explanation: parsed.explanation,
      assumptions: [...parsed.assumptions],
      evidence:
        context.documents.length > 0
          ? context.documents.map<GeneratedSqlEvidence>((item) => ({
              title: item.document.title,
              kind: item.document.kind,
              reasons: [...item.reasons],
            }))
          : this.fallbackSchemaEvidence(connection.id),
      safety,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(response.usage === undefined ? {} : { usage: { ...response.usage } }),
    };
    this.runs.set(run.runId, cloneRun(run));
    return cloneRun(run) as GeneratedSqlRun;
  }

  async executeGenerated(
    runId: string,
    options: ExecuteGeneratedOptions = {},
  ): Promise<ExecutedSqlRun> {
    const normalizedRunId = requireText(runId, 'runId', 300);
    const run = this.runs.get(normalizedRunId);
    if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。', false);
    if (run.status !== 'awaiting_execution') {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        `运行记录当前状态为 ${run.status}，不能执行。`,
        false,
      );
    }
    const connection = this.requireConnection();
    const safety = analyzeSqlSafety(run.sql, { readOnly: true });
    if (!isExecutableSafety(safety)) {
      const blocked = updateRun(run, {
        status: 'blocked',
        safety,
        updatedAt: this.now(),
      });
      this.runs.set(run.runId, blocked);
      throw new DatabaseAgentError('SQL_BLOCKED', safetyMessage(safety), false);
    }

    const executing = updateRun(run, { status: 'executing', safety, updatedAt: this.now() });
    this.runs.set(run.runId, executing);
    const limit = normalizeInteger(
      options.limit ?? this.defaultRowLimit,
      'limit',
      1,
      MAX_ROW_LIMIT,
    );
    let result;
    try {
      result = await this.driver.execute(
        { connectionId: connection.id, sql: run.sql, limit },
        connection,
      );
    } catch (error) {
      const normalized = asDatabaseAgentError(error);
      const failure = new DatabaseAgentError(
        'QUERY_FAILED',
        normalized.message,
        normalized.retryable,
        normalized.detail,
      );
      this.runs.set(
        run.runId,
        updateRun(executing, {
          status: 'failed',
          updatedAt: this.now(),
          error: toRunError(failure),
        }),
      );
      throw failure;
    }
    if (!result.ok) {
      const failure = new DatabaseAgentError(
        'QUERY_FAILED',
        result.error.message,
        result.error.retryable ?? false,
        result.error.detail,
      );
      this.runs.set(
        run.runId,
        updateRun(executing, {
          status: 'failed',
          updatedAt: this.now(),
          error: toRunError(failure),
        }),
      );
      throw failure;
    }

    const { error: _previousError, execution: _previousExecution, ...completedBase } = executing;
    void _previousError;
    void _previousExecution;
    const completed: ExecutedSqlRun = {
      ...completedBase,
      status: 'completed',
      safety,
      execution: result.data,
      updatedAt: this.now(),
    };
    this.runs.set(run.runId, cloneRun(completed));
    return cloneRun(completed) as ExecutedSqlRun;
  }

  getRun(runId: string): SqlRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  private requireProvider(): LlmProvider {
    if (!this.provider || !this.model) {
      throw new DatabaseAgentError('NOT_CONFIGURED', '请先配置模型 Provider 和模型名。', true);
    }
    return this.provider;
  }

  private requireConnection(): SavedConnection {
    if (!this.connection) {
      throw new DatabaseAgentError('NOT_CONFIGURED', '请先连接 PostgreSQL。', true);
    }
    return this.connection;
  }

  private fallbackSchemaContext(connectionId: string, maxChars: number): string {
    const summaries = this.rag.listTables({ connectionId, limit: 8 });
    const sections: string[] = [];
    for (const summary of summaries) {
      const description = this.rag.describeTable({
        connectionId,
        schema: summary.schema,
        table: summary.table,
        maxChars: Math.max(500, Math.floor(maxChars / Math.max(1, summaries.length))),
      });
      const next = [...sections, description.text].join('\n\n');
      if (next.length > maxChars) break;
      sections.push(description.text);
    }
    return sections.join('\n\n');
  }

  private fallbackSchemaEvidence(connectionId: string): GeneratedSqlEvidence[] {
    return this.rag.listTables({ connectionId, limit: 8 }).map((table) => ({
      title: table.title,
      kind: 'table',
      reasons: ['fallback_schema'],
    }));
  }
}

function normalizeConnection(input: PostgresConnectionInput, id: string): DatabaseConnectionConfig {
  const host = requireText(input.host, 'host', 500);
  const database = requireText(input.database, 'database', 300);
  const username = requireText(input.username, 'username', 300);
  const port = normalizeInteger(input.port ?? 5432, 'port', 1, 65_535);
  const name = input.name?.trim() || `${database}@${host}`;
  return {
    id: requireText(id, 'id', 300),
    name,
    engine: 'postgres',
    host,
    port,
    database,
    username,
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(input.ssl === undefined ? {} : { ssl: input.ssl }),
    readOnly: true,
    connectionTimeoutMs: normalizeInteger(
      input.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      'connectionTimeoutMs',
      100,
      300_000,
    ),
    statementTimeoutMs: normalizeInteger(
      input.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      'statementTimeoutMs',
      100,
      3_600_000,
    ),
  };
}

function buildSystemPrompt(): string {
  return [
    '你是 PostgreSQL 查询生成器。',
    '只输出一个 JSON 对象，字段必须是 sql、explanation、assumptions。',
    'sql 只能是一条只读 SELECT、只读 WITH 或 VALUES 语句。',
    '禁止 INSERT、UPDATE、DELETE、MERGE、CALL、CREATE、ALTER、DROP、TRUNCATE、COPY、SET、事务控制和多条语句。',
    '只能使用给出的表和字段；优先使用注释、主外键和业务语义。',
    '默认避免 SELECT *，并为明细查询提供合理 LIMIT。',
    '信息不足时仍给出最保守的查询，并把口径或时间假设写入 assumptions。',
    '不要输出 Markdown、代码围栏或 JSON 之外的文字。',
  ].join('\n');
}

function isExecutableSafety(safety: QuerySafetyReport): boolean {
  return (
    EXECUTABLE_STATEMENT_KINDS.has(safety.statementKind) &&
    safety.riskLevel === 'safe' &&
    !safety.blocked &&
    !safety.requiresConfirmation
  );
}

function safetyMessage(safety: QuerySafetyReport): string {
  const detail = safety.reasons.join(' ');
  return detail ? `生成的 SQL 已被安全策略阻止：${detail}` : '生成的 SQL 不符合只读执行策略。';
}

function mapLlmError(error: unknown): DatabaseAgentError {
  if (error instanceof DatabaseAgentError) return error;
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new DatabaseAgentError('ABORTED', 'SQL 生成已取消。', false);
    }
    return new DatabaseAgentError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  const normalized = asDatabaseAgentError(error);
  if (normalized.code === 'ABORTED') return normalized;
  return new DatabaseAgentError('LLM_REQUEST_FAILED', normalized.message, true);
}

function requireText(value: string, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} 不能为空。`, false);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 长度不能超过 ${maxLength} 个字符。`,
      false,
    );
  }
  return trimmed;
}

function normalizeInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 必须是 ${min} 到 ${max} 之间的整数。`,
      false,
    );
  }
  return value;
}

function emptySchemaStatus(stage: 'not_connected' | 'not_indexed'): SchemaIndexSnapshot {
  return {
    stage,
    ready: false,
    tableCount: 0,
    columnCount: 0,
    relationCount: 0,
    documentCount: 0,
    truncated: false,
  };
}

function cloneConnection(connection: SavedConnection): SavedConnection {
  return { ...connection };
}

function cloneRun(run: SqlRunSnapshot): SqlRunSnapshot {
  return {
    ...run,
    assumptions: [...run.assumptions],
    evidence: run.evidence.map((item) => ({ ...item, reasons: [...item.reasons] })),
    safety: {
      ...run.safety,
      reasons: [...run.safety.reasons],
      ...(run.safety.performanceWarnings === undefined
        ? {}
        : {
            performanceWarnings: run.safety.performanceWarnings.map((warning) => ({ ...warning })),
          }),
    },
    ...(run.usage === undefined ? {} : { usage: { ...run.usage } }),
    ...(run.error === undefined ? {} : { error: { ...run.error } }),
  };
}

function updateRun(run: SqlRunSnapshot, patch: Partial<SqlRunSnapshot>): SqlRunSnapshot {
  return cloneRun({ ...run, ...patch });
}

function toRunError(error: DatabaseAgentError): {
  code: DatabaseAgentError['code'];
  message: string;
  retryable: boolean;
} {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

async function mapInBatches<T, R>(
  values: T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    output.push(...(await Promise.all(values.slice(index, index + batchSize).map(mapper))));
  }
  return output;
}
