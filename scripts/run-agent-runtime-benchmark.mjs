#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  LexicalToolSearchIndex,
  ToolExecutionRouter,
  ToolExposurePlanner,
  ToolRegistry,
  createAgentSession,
} from '../packages/core-agent/dist/index.js';
import { compileProjectContext } from '../packages/core-tools/dist/index.js';

const TOOL_COUNT = 1_000;
const PROJECT_FILE_COUNT = 1_000;
const SEARCH_TARGETS = [
  {
    namespace: 'database.kafka',
    name: 'kafka_payload_inspect',
    title: 'Kafka 消息体结构探查',
    description: 'Inspect JSON event payload fields and keys stored in Kafka value columns.',
    aliases: ['Kafka JSON 消息结构', 'event payload fields', 'value key extraction'],
    tags: ['kafka', 'json', 'event'],
    parameters: [
      { name: 'topic', description: 'Kafka topic name' },
      { name: 'valueColumn', description: 'JSON payload value column' },
    ],
    queries: [
      '解析 Kafka value 里的 JSON key',
      'inspect kafka payload fields',
      '消息体结构探查',
      'find event payload schema',
      'Kafka 事件有哪些字段',
    ],
  },
  {
    namespace: 'database.postgres',
    name: 'postgres_slow_query_analyze',
    title: 'PostgreSQL 慢查询分析',
    description: 'Analyze PostgreSQL query latency, expensive statements, and slow-query evidence.',
    aliases: ['PG slow query', '慢 SQL 分析', 'query latency'],
    tags: ['postgres', 'performance', 'latency'],
    parameters: [{ name: 'queryId', description: 'PostgreSQL statement or query identifier' }],
    queries: [
      '分析 PG 慢查询',
      'postgres slow statement investigation',
      '哪个 SQL 延迟最高',
      'inspect query latency in PostgreSQL',
      '数据库慢 SQL 排查',
    ],
  },
  {
    namespace: 'infrastructure.kubernetes',
    name: 'kubernetes_pod_logs',
    title: 'Kubernetes Pod 日志',
    description: 'Read bounded container logs for a Kubernetes pod and namespace.',
    aliases: ['K8s 容器日志', 'pod log reader', 'kubectl logs'],
    tags: ['kubernetes', 'k8s', 'logs'],
    parameters: [
      { name: 'namespace', description: 'Kubernetes namespace' },
      { name: 'pod', description: 'Pod name whose container logs are needed' },
    ],
    queries: [
      '看一下 K8s 容器日志',
      'read kubernetes pod logs',
      'kubectl logs for this pod',
      '查看命名空间里的 Pod 输出',
      '容器为什么启动失败 看日志',
    ],
  },
  {
    namespace: 'workspace',
    name: 'workspace_apply_patch',
    title: '工作区原子补丁',
    description: 'Apply validated exact replacements as one atomic patch to a project file.',
    aliases: ['文件补丁', 'atomic patch', 'exact replacement'],
    tags: ['workspace', 'file', 'patch'],
    parameters: [
      { name: 'path', description: 'Project-relative file path' },
      { name: 'edits', description: 'Exact text replacements applied atomically' },
    ],
    queries: [
      '给这个文件应用补丁',
      'apply an atomic file patch',
      '做多个精确文本替换',
      'edit file without partial writes',
      'workspace exact replacement tool',
    ],
  },
  {
    namespace: 'web',
    name: 'web_document_search',
    title: 'Web 文档搜索',
    description: 'Search current online documentation and web sources by query.',
    aliases: ['联网搜索', 'online docs', 'web search'],
    tags: ['web', 'search', 'documentation'],
    parameters: [{ name: 'query', description: 'Web documentation search query' }],
    queries: [
      '联网搜索最新文档',
      'search online docs',
      'find this API on the web',
      '查一下官网说明',
      'web search technical documentation',
    ],
  },
  {
    namespace: 'database.mysql',
    name: 'mysql_replication_status',
    title: 'MySQL 复制状态',
    description: 'Inspect MySQL replica lag, binlog coordinates, and replication health.',
    aliases: ['MySQL 主从状态', 'replica lag', 'binlog replication'],
    tags: ['mysql', 'replication', 'binlog'],
    parameters: [{ name: 'replica', description: 'MySQL replica connection' }],
    queries: [
      '查看 MySQL 主从延迟',
      'mysql replica lag status',
      'binlog 复制健康吗',
      'inspect replication coordinates',
      '数据库从库同步状态',
    ],
  },
  {
    namespace: 'warehouse.maxcompute',
    name: 'maxcompute_partition_list',
    title: 'MaxCompute 分区列表',
    description: 'List ODPS or MaxCompute table partitions and partition metadata.',
    aliases: ['ODPS partitions', 'MaxCompute 分区', '数仓表分区'],
    tags: ['maxcompute', 'odps', 'partition'],
    parameters: [{ name: 'table', description: 'MaxCompute table whose partitions are listed' }],
    queries: [
      '列出 MaxCompute 表分区',
      'show ODPS partitions',
      '数仓这张表有哪些分区',
      'list partition metadata',
      '查询 maxcompute partition',
    ],
  },
  {
    namespace: 'database.security',
    name: 'database_user_grant',
    title: '数据库用户授权',
    description: 'Grant or revoke database roles and object privileges for a user.',
    aliases: ['用户权限管理', 'grant role', 'revoke privileges'],
    tags: ['database', 'user', 'permission'],
    parameters: [
      { name: 'user', description: 'Database user or role' },
      { name: 'privilege', description: 'Privilege to grant or revoke' },
    ],
    queries: [
      '给数据库用户授权',
      'grant a role to this user',
      '撤销表访问权限',
      'revoke database privileges',
      '管理账号的对象权限',
    ],
  },
  {
    namespace: 'database.schema',
    name: 'schema_relation_search',
    title: 'Schema 表关系检索',
    description: 'Search table relationships, foreign keys, and the Schema relation graph.',
    aliases: ['表关系查询', 'foreign key search', 'relation graph', 'database table relations'],
    tags: ['schema', 'table', 'relationship'],
    parameters: [{ name: 'relation', description: 'Table or relation name' }],
    queries: [
      '查这个表关联了哪些表',
      'search foreign key relations',
      'Schema 关系图',
      'find related database tables',
      '表之间的依赖关系',
    ],
  },
  {
    namespace: 'database.sql',
    name: 'sql_explain_plan',
    title: 'SQL 执行计划',
    description: 'Generate and inspect an EXPLAIN query plan without executing a write.',
    aliases: ['EXPLAIN 分析', 'query plan', '执行计划'],
    tags: ['sql', 'explain', 'plan'],
    parameters: [{ name: 'sql', description: 'SQL statement to explain' }],
    queries: [
      '看一下 SQL 执行计划',
      'explain this query',
      '生成 query plan',
      '为什么这条 SQL 扫描很慢',
      'inspect EXPLAIN output',
    ],
  },
  {
    namespace: 'process',
    name: 'process_background_poll',
    title: '后台进程进度轮询',
    description: 'Poll incremental stdout, stderr, and status for a background process handle.',
    aliases: [
      '后台任务进度',
      '命令运行状态',
      '命令是否完成',
      'process output',
      'poll command status',
    ],
    tags: ['process', 'background', 'output'],
    parameters: [{ name: 'processId', description: 'Background process handle' }],
    queries: [
      '看看后台任务进度',
      'poll process output',
      '命令运行完了吗',
      'read incremental stdout',
      '查询后台进程状态',
    ],
  },
  {
    namespace: 'artifact',
    name: 'artifact_export_csv',
    title: '结果导出 CSV',
    description: 'Export a bounded or streamed result into a CSV artifact.',
    aliases: ['导出 CSV', '逗号分隔文件', 'export result file', 'CSV artifact'],
    tags: ['artifact', 'csv', 'export'],
    parameters: [{ name: 'resultId', description: 'Result handle to export as CSV' }],
    queries: [
      '把查询结果导出成 CSV',
      'export result to csv',
      '生成逗号分隔文件',
      'save these rows as an artifact',
      '下载 CSV 结果',
    ],
  },
  {
    namespace: 'mcp',
    name: 'mcp_resource_read',
    title: 'MCP Resource 读取',
    description: 'Read a resource URI exposed by a connected Model Context Protocol server.',
    aliases: ['MCP 资源读取', 'read MCP resource', 'resource URI'],
    tags: ['mcp', 'resource', 'protocol'],
    parameters: [{ name: 'uri', description: 'MCP resource URI' }],
    queries: [
      '读取 MCP 服务的资源',
      'read this MCP resource URI',
      '获取模型上下文协议资源',
      'open resource from MCP server',
      'MCP resource 内容是什么',
    ],
  },
  {
    namespace: 'agent',
    name: 'subagent_delegate',
    title: '子 Agent 任务委派',
    description: 'Delegate a bounded task to an independent child Agent context.',
    aliases: ['子 Agent 委派', '独立上下文', '并行任务', 'delegate task', 'parallel research agent'],
    tags: ['subagent', 'delegate', 'parallel'],
    parameters: [{ name: 'task', description: 'Goal delegated to the child Agent' }],
    queries: [
      '委派一个子 Agent 去调查',
      'delegate this task to a child agent',
      '并行开一个独立上下文',
      'spawn a research subagent',
      '让另一个 Agent 处理子任务',
    ],
  },
  {
    namespace: 'governance.lineage',
    name: 'table_lineage_trace',
    title: '表级数据血缘追踪',
    description: 'Trace upstream and downstream lineage for a table or dataset.',
    aliases: ['表血缘', 'data lineage', 'upstream downstream'],
    tags: ['governance', 'lineage', 'table'],
    parameters: [{ name: 'table', description: 'Table or dataset for lineage tracing' }],
    queries: [
      '追踪这张表的数据血缘',
      'show upstream data lineage',
      '有哪些下游表依赖它',
      'trace dataset dependencies',
      '查询表级 lineage',
    ],
  },
  {
    namespace: 'governance.quality',
    name: 'data_quality_null_scan',
    title: '数据质量空值扫描',
    description: 'Scan selected columns for null ratios and missing-value quality issues.',
    aliases: ['空值检测', 'null quality scan', 'missing value ratio'],
    tags: ['quality', 'null', 'data'],
    parameters: [{ name: 'columns', description: 'Columns checked for null values' }],
    queries: [
      '检查字段空值比例',
      'run a null quality scan',
      '哪些列缺失数据很多',
      'calculate missing value ratio',
      '数据质量空值检测',
    ],
  },
  {
    namespace: 'database.postgres',
    name: 'index_bloat_inspect',
    title: 'PostgreSQL 索引膨胀检查',
    description: 'Inspect index bloat, dead tuples, and reclaim candidates in PostgreSQL.',
    aliases: ['索引膨胀', 'index bloat', 'dead tuples'],
    tags: ['postgres', 'index', 'bloat'],
    parameters: [{ name: 'index', description: 'PostgreSQL index to inspect for bloat' }],
    queries: [
      '检查 PostgreSQL 索引膨胀',
      'inspect index bloat',
      '哪些索引有很多 dead tuples',
      'find reclaim candidates',
      'PG 索引空间浪费情况',
    ],
  },
  {
    namespace: 'stream.kafka',
    name: 'kafka_topic_offsets',
    title: 'Kafka Topic 消费位点',
    description: 'Read topic offsets, consumer-group positions, and Kafka consumer lag.',
    aliases: ['Kafka 消费位点', 'consumer lag', 'topic offsets'],
    tags: ['kafka', 'offset', 'consumer'],
    parameters: [
      { name: 'topic', description: 'Kafka topic' },
      { name: 'consumerGroup', description: 'Consumer group whose lag is inspected' },
    ],
    queries: [
      '看 Kafka 消费位点',
      'show topic offsets',
      'consumer group lag 多大',
      '查询消费者积压',
      'inspect kafka consumer positions',
    ],
  },
  {
    namespace: 'warehouse.jobs',
    name: 'warehouse_job_status',
    title: '数仓作业运行状态',
    description: 'Inspect ETL or warehouse job runs, failures, and current execution status.',
    aliases: ['数仓作业状态', '数据开发任务进度', 'ETL job status', 'pipeline run'],
    tags: ['warehouse', 'etl', 'job'],
    parameters: [{ name: 'jobId', description: 'Warehouse or ETL job identifier' }],
    queries: [
      '查看数仓作业状态',
      'is the ETL job still running',
      '哪个 pipeline run 失败了',
      'inspect warehouse job failure',
      '查询数据开发任务进度',
    ],
  },
  {
    namespace: 'database.postgres',
    name: 'transaction_lock_graph',
    title: '事务锁等待图',
    description: 'Build a blocking-session graph for transaction locks and deadlock diagnosis.',
    aliases: ['锁等待', 'blocking sessions', 'deadlock graph'],
    tags: ['transaction', 'lock', 'deadlock'],
    parameters: [{ name: 'connection', description: 'Database connection for lock diagnosis' }],
    queries: [
      '看一下事务锁等待',
      'find blocking database sessions',
      '生成 deadlock graph',
      '谁阻塞了这个事务',
      'diagnose lock contention',
    ],
  },
];
const SEARCH_QUALITY_CASES = searchQualityCases();
const reportPath = resolve('reports/agent-runtime/performance.json');
const registry = createToolCatalog();
const descriptors = registry.listDescriptors();
const session = createAgentSession({
  id: 'agent-runtime-benchmark',
  title: 'Agent runtime benchmark',
  mode: 'read',
  now: () => '2026-08-01T00:00:00.000Z',
});

const indexBuildMs = measure(30, () => new LexicalToolSearchIndex(descriptors));
const index = new LexicalToolSearchIndex(descriptors);
let timedQueryIndex = 0;
const searchMs = measure(200, () => {
  const benchmarkCase = SEARCH_QUALITY_CASES[timedQueryIndex % SEARCH_QUALITY_CASES.length];
  timedQueryIndex += 1;
  index.search(benchmarkCase.query, { limit: 8 });
});
const searchQuality = evaluateSearchQuality(index, SEARCH_QUALITY_CASES);
const planner = new ToolExposurePlanner();
const exposurePlanMs = measure(300, () => {
  const plan = planner.plan({
    registry,
    dynamicDiscovery: true,
    pinnedTools: ['tool_0', 'tool_2'],
    activations: [
      {
        toolName: 'tool_777',
        catalogRevision: registry.catalogRevision,
        taskPhase: 'benchmark',
        activatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    taskPhase: 'benchmark',
  });
  assert(plan.modelTools.some((tool) => tool.name === 'tool_777'));
});

const router = new ToolExecutionRouter(registry);
const routerCalls = Array.from({ length: 20 }, (_, index) => ({
  id: `call-${index}`,
  name: `tool_${index * 2}`,
  arguments: { input: `value-${index}` },
}));
const routerBatchMs = await measureAsync(50, async () => {
  const outcomes = await router.execute({ calls: routerCalls, context: { session } });
  assert(outcomes.every((outcome) => outcome.status === 'success'));
});

const projectDirectory = await createProjectFixture();
let projectCompilationMs;
try {
  projectCompilationMs = await measureAsync(10, async () => {
    const result = await compileProjectContext({ rootPath: projectDirectory });
    assert.equal(result.scannedFileCount, PROJECT_FILE_COUNT + 3);
    assert(result.compiledInstructions.includes('benchmark project instruction'));
  });
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}

const metrics = {
  toolIndexBuildMs: stats(indexBuildMs),
  toolSearchMs: stats(searchMs),
  exposurePlanMs: stats(exposurePlanMs),
  readonlyRouterBatchMs: stats(routerBatchMs),
  projectCompilationMs: stats(projectCompilationMs),
  toolSearchQuality: searchQuality.metrics,
};
const thresholds = {
  toolIndexBuildP95Ms: 150,
  toolSearchP95Ms: 20,
  exposurePlanP95Ms: 100,
  readonlyRouterBatchP95Ms: 100,
  projectCompilationP95Ms: 1_500,
  recallAt5: 0.95,
  recallAt8: 0.98,
  mrrAt5: 0.85,
};
const gates = {
  toolIndexBuild: gate(metrics.toolIndexBuildMs.p95, thresholds.toolIndexBuildP95Ms),
  toolSearch: gate(metrics.toolSearchMs.p95, thresholds.toolSearchP95Ms),
  exposurePlan: gate(metrics.exposurePlanMs.p95, thresholds.exposurePlanP95Ms),
  readonlyRouterBatch: gate(
    metrics.readonlyRouterBatchMs.p95,
    thresholds.readonlyRouterBatchP95Ms,
  ),
  projectCompilation: gate(
    metrics.projectCompilationMs.p95,
    thresholds.projectCompilationP95Ms,
  ),
  toolSearchRecallAt5: qualityGate(metrics.toolSearchQuality.recallAt5, thresholds.recallAt5),
  toolSearchRecallAt8: qualityGate(metrics.toolSearchQuality.recallAt8, thresholds.recallAt8),
  toolSearchMrrAt5: qualityGate(metrics.toolSearchQuality.mrrAt5, thresholds.mrrAt5),
};
const passed = Object.values(gates).every((item) => item.passed);
const report = {
  kind: 'agent-runtime-performance',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
  },
  dataset: {
    toolCount: TOOL_COUNT,
    routerBatchSize: routerCalls.length,
    projectFileCount: PROJECT_FILE_COUNT + 3,
    searchQualityCaseCount: SEARCH_QUALITY_CASES.length,
  },
  sampleCounts: {
    toolIndexBuild: indexBuildMs.length,
    toolSearch: searchMs.length,
    exposurePlan: exposurePlanMs.length,
    readonlyRouterBatch: routerBatchMs.length,
    projectCompilation: projectCompilationMs.length,
  },
  metrics,
  thresholds,
  gates,
  searchQualityCases: searchQuality.cases,
  passed,
  notes: [
    'Deterministic local benchmark; model, network, database and process execution time are excluded.',
    'Raw samples are retained so regressions can be distinguished from percentile rounding.',
  ],
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!passed) throw new Error(`Agent runtime performance gate failed: ${reportPath}`);
process.stdout.write(`${JSON.stringify({ reportPath, passed, metrics }, null, 2)}\n`);

function createToolCatalog() {
  const catalog = new ToolRegistry();
  const noiseToolCount = TOOL_COUNT - SEARCH_TARGETS.length;
  for (let index = 0; index < noiseToolCount; index += 1) {
    const name = `tool_${index}`;
    catalog.register(
      {
        namespace: index % 2 === 0 ? 'workspace' : 'database',
        name,
        title: `Tool ${index}`,
        description: `Generic benchmark capability ${index}`,
        aliases: [],
        tags: ['benchmark'],
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string', description: `input ${index}` } },
          required: ['input'],
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: index % 2 === 0,
        exposure: index < 4 ? 'direct' : 'deferred',
        execution: { concurrency: index % 2 === 0 ? 'read' : 'write' },
      },
      () => ({ ok: true, name }),
    );
  }
  for (const target of SEARCH_TARGETS) {
    catalog.register(
      {
        namespace: target.namespace,
        name: target.name,
        title: target.title,
        description: target.description,
        aliases: target.aliases,
        tags: target.tags,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            target.parameters.map((parameter) => [
              parameter.name,
              { type: 'string', description: parameter.description },
            ]),
          ),
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        readonly: true,
        exposure: 'deferred',
        execution: { concurrency: 'read' },
      },
      () => ({ ok: true, name: target.name }),
    );
  }
  assert.equal(catalog.list().length, TOOL_COUNT);
  return catalog;
}

function evaluateSearchQuality(index, cases) {
  const evaluated = cases.map((item) => {
    const matches = index.search(item.query, { limit: 8 });
    const position = matches.findIndex((match) => match.tool.flatName === item.expected);
    return {
      query: item.query,
      expected: item.expected,
      rank: position < 0 ? null : position + 1,
      top: matches.slice(0, 5).map((match) => match.tool.flatName),
    };
  });
  const recallAt = (limit) =>
    evaluated.filter((item) => item.rank !== null && item.rank <= limit).length /
    evaluated.length;
  const mrrAt5 =
    evaluated.reduce(
      (sum, item) => sum + (item.rank !== null && item.rank <= 5 ? 1 / item.rank : 0),
      0,
    ) / evaluated.length;
  return {
    metrics: {
      recallAt5: round(recallAt(5)),
      recallAt8: round(recallAt(8)),
      mrrAt5: round(mrrAt5),
    },
    cases: evaluated,
  };
}

function searchQualityCases() {
  const cases = SEARCH_TARGETS.flatMap((target) =>
    target.queries.map((query) => ({ query, expected: target.name })),
  );
  assert(cases.length >= 100, 'Tool-search quality corpus must contain at least 100 cases.');
  return cases;
}

async function createProjectFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-agent-runtime-benchmark-'));
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(
    join(directory, 'AGENTS.md'),
    'benchmark project instruction\n',
    'utf8',
  );
  await writeFile(join(directory, 'package.json'), '{"packageManager":"pnpm@10"}\n', 'utf8');
  await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  await Promise.all(
    Array.from({ length: PROJECT_FILE_COUNT }, (_, index) =>
      writeFile(join(directory, 'src', `module-${index}.ts`), `export const n${index} = ${index};\n`),
    ),
  );
  return directory;
}

function measure(samples, operation) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return values;
}

async function measureAsync(samples, operation) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return values;
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.map(round),
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function gate(observedMs, thresholdMs) {
  return { observedMs: round(observedMs), thresholdMs, passed: observedMs <= thresholdMs };
}

function qualityGate(observed, threshold) {
  return { observed, threshold, passed: observed >= threshold };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
