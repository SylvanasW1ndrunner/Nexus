#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BASE_TOOL_MANIFEST,
  LexicalToolSearchIndex,
  ToolExposurePlanner,
  ToolRegistry,
  PermissionManager,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolInvocationRuntime,
} from '../packages/core-agent/dist/index.js';
import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
} from '../packages/core-llm/dist/index.js';
import { compileProjectContext } from '../packages/core-tools/dist/index.js';
import { BatchingModelTurnObserver } from '../packages/core-agent/dist/kernel/model-turn-coordinator.js';
import { transitionAgentRunState } from '../packages/core-agent/dist/kernel/agent-state-machine.js';
import { decideSchedule } from '../packages/core-agent/dist/tools/tool-scheduler.js';

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
    name: 'workspace_patch_apply_benchmark',
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
    aliases: [
      '子 Agent 委派',
      '独立上下文',
      '并行任务',
      'delegate task',
      'parallel research agent',
    ],
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
const NORMATIVE_PROTOCOL = Object.freeze({
  minimumWarmupMs: 10_000,
  minimumJournalSamplesPerLevel: 1_000,
  minimumSchedulerSamplesPerLevel: 500,
  concurrencyLevels: [1, 8],
  retainedHeapTurns: 100,
  deltaChunkCount: 10_000,
  deltaPacedIntervalMs: 10,
});
const profileName = process.env.SCHEMANAUT_AGENT_BENCHMARK_PROFILE === 'contract'
  ? 'contract'
  : 'normative';
const profile = profileName === 'contract'
  ? {
      warmupMs: 50,
      journalSamples: 8,
      schedulerSamples: 20,
      fakeProviderSamples: 20,
      durableBatchSamples: 1,
      deltaChunkCount: 40,
      progressUpdateCount: 80,
      deltaPacedIntervalMs: NORMATIVE_PROTOCOL.deltaPacedIntervalMs,
      indexBuildSamples: 2,
      searchSamples: 20,
      exposureSamples: 20,
      projectSamples: 2,
    }
  : {
      warmupMs: NORMATIVE_PROTOCOL.minimumWarmupMs,
      journalSamples: NORMATIVE_PROTOCOL.minimumJournalSamplesPerLevel,
      schedulerSamples: NORMATIVE_PROTOCOL.minimumSchedulerSamplesPerLevel,
      fakeProviderSamples: NORMATIVE_PROTOCOL.minimumSchedulerSamplesPerLevel,
      durableBatchSamples: 3,
      deltaChunkCount: NORMATIVE_PROTOCOL.deltaChunkCount,
      progressUpdateCount: NORMATIVE_PROTOCOL.deltaChunkCount,
      deltaPacedIntervalMs: NORMATIVE_PROTOCOL.deltaPacedIntervalMs,
      indexBuildSamples: 30,
      searchSamples: 200,
      exposureSamples: 300,
      projectSamples: 10,
    };
const SEARCH_QUALITY_CASES = searchQualityCases();
const reportPath = resolve(
  process.env.SCHEMANAUT_AGENT_BENCHMARK_REPORT_PATH ??
    'reports/agent-runtime/performance.json',
);
const registry = createToolCatalog();
const descriptors = registry.listDescriptors();
const invocationCalls = Array.from({ length: 20 }, (_, index) => ({
  name: `tool_${index * 2}`,
  arguments: { input: `value-${index}` },
}));
const environment = await describeEnvironment();
const registeredReferenceId = process.env.SCHEMANAUT_AGENT_BENCHMARK_REFERENCE_ID?.trim() || null;
const referenceMachine = {
  registeredId: registeredReferenceId,
  observedId: environment.machineId,
  absoluteGatesApplied: registeredReferenceId !== null && registeredReferenceId === environment.machineId,
  decision: registeredReferenceId !== null && registeredReferenceId === environment.machineId
    ? 'registered-reference-machine'
    : 'relative-baseline-only',
};

const benchmarkDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-agent-runtime-layered-'));
let storagePragmas;
let warmup;
let schedulerProfiles;
let journalProfiles;
let fakeProviderProfiles;
let durableInvocationBatchMs;
let retainedHeap;
let writeAmplification;
try {
  const journalFixture = await prepareOrdinaryJournalFixture(
    join(benchmarkDirectory, 'ordinary-events.db'),
  );
  storagePragmas = await journalFixture.journal.inspectStoragePragmas();
  warmup = await warmRuntime(profile.warmupMs, journalFixture, invocationCalls);
  schedulerProfiles = {
    concurrency1: schedulerProfile(profile.schedulerSamples, invocationCalls, 1),
    concurrency8: schedulerProfile(profile.schedulerSamples, invocationCalls, 8),
  };
  journalProfiles = {
    concurrency1: await journalCommitProfile(
      profile.journalSamples, 1, journalFixture, 'journal-c1',
    ),
    concurrency8: await journalCommitProfile(
      profile.journalSamples, 8, journalFixture, 'journal-c8',
    ),
  };
  fakeProviderProfiles = {
    concurrency1: await fakeProviderProfile(profile.fakeProviderSamples, 1, invocationCalls),
    concurrency8: await fakeProviderProfile(profile.fakeProviderSamples, 8, invocationCalls),
  };
  durableInvocationBatchMs = await measureCommittedInvocationBatches(
    profile.durableBatchSamples,
    registry,
    invocationCalls,
    benchmarkDirectory,
  );
  retainedHeap = await measureRetainedHeap(NORMATIVE_PROTOCOL.retainedHeapTurns);
  writeAmplification = {
    delta: {
      synchronous: await measureDeltaWriteAmplification({
        chunkCount: profile.deltaChunkCount,
        intervalMs: 0,
        databasePath: join(benchmarkDirectory, 'delta-sync.db'),
      }),
      paced: await measureDeltaWriteAmplification({
        chunkCount: profile.deltaChunkCount,
        intervalMs: profile.deltaPacedIntervalMs,
        databasePath: join(benchmarkDirectory, 'delta-paced.db'),
      }),
    },
    progress: await measureToolProgressWriteAmplification({
      updateCount: profile.progressUpdateCount,
      databasePath: join(benchmarkDirectory, 'tool-progress.db'),
    }),
  };
} finally {
  await rm(benchmarkDirectory, { recursive: true, force: true });
}

const indexBuildMs = measure(profile.indexBuildSamples, () => new LexicalToolSearchIndex(descriptors));
const index = new LexicalToolSearchIndex(descriptors);
let timedQueryIndex = 0;
const searchMs = measure(profile.searchSamples, () => {
  const benchmarkCase = SEARCH_QUALITY_CASES[timedQueryIndex % SEARCH_QUALITY_CASES.length];
  timedQueryIndex += 1;
  index.search(benchmarkCase.query, { limit: 8 });
});
const searchQuality = evaluateSearchQuality(index, SEARCH_QUALITY_CASES);
const planner = new ToolExposurePlanner();
const benchmarkActivationDescriptor = registry.listDescriptors().find(({ flatName }) => flatName === 'tool_777');
if (benchmarkActivationDescriptor === undefined) throw new Error('Benchmark activation Tool is unavailable.');
const exposurePlanMs = measure(profile.exposureSamples, () => {
  const plan = planner.plan({
    registry,
    activeTools: [{
      name: 'tool_777',
      toolRevision: benchmarkActivationDescriptor.toolRevision,
      handlerRevision: benchmarkActivationDescriptor.handlerRevision,
    }],
  });
  assert(plan.modelTools.some((tool) => tool.name === 'tool_777'));
});
const projectDirectory = await createProjectFixture();
let projectCompilationMs;
try {
  projectCompilationMs = await measureAsync(profile.projectSamples, async () => {
    const result = await compileProjectContext({ rootPath: projectDirectory });
    assert.equal(result.scannedFileCount, PROJECT_FILE_COUNT + 3);
    assert(result.compiledInstructions.includes('benchmark project instruction'));
  });
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}

const auxiliaryMetrics = {
  toolIndexBuildMs: stats(indexBuildMs),
  toolSearchMs: stats(searchMs),
  exposurePlanMs: stats(exposurePlanMs),
  projectCompilationMs: stats(projectCompilationMs),
  toolSearchQuality: searchQuality.metrics,
};
const auxiliaryThresholds = {
  toolIndexBuildP95Ms: 150,
  toolSearchP95Ms: 20,
  exposurePlanP95Ms: 100,
  projectCompilationP95Ms: 1_500,
  recallAt5: 0.95,
  recallAt8: 0.98,
  mrrAt5: 0.85,
};
const auxiliaryGates = {
  toolIndexBuild: gate(auxiliaryMetrics.toolIndexBuildMs.p95, auxiliaryThresholds.toolIndexBuildP95Ms),
  toolSearch: gate(auxiliaryMetrics.toolSearchMs.p95, auxiliaryThresholds.toolSearchP95Ms),
  exposurePlan: gate(auxiliaryMetrics.exposurePlanMs.p95, auxiliaryThresholds.exposurePlanP95Ms),
  projectCompilation: gate(auxiliaryMetrics.projectCompilationMs.p95, auxiliaryThresholds.projectCompilationP95Ms),
  toolSearchRecallAt5: qualityGate(auxiliaryMetrics.toolSearchQuality.recallAt5, auxiliaryThresholds.recallAt5),
  toolSearchRecallAt8: qualityGate(auxiliaryMetrics.toolSearchQuality.recallAt8, auxiliaryThresholds.recallAt8),
  toolSearchMrrAt5: qualityGate(auxiliaryMetrics.toolSearchQuality.mrrAt5, auxiliaryThresholds.mrrAt5),
};
const schedulerWorstP95 = Math.max(
  schedulerProfiles.concurrency1.p95Ms,
  schedulerProfiles.concurrency8.p95Ms,
);
const journalWorstP95 = Math.max(
  journalProfiles.concurrency1.p95Ms,
  journalProfiles.concurrency8.p95Ms,
);
const fakeProviderWorstP95 = Math.max(
  fakeProviderProfiles.concurrency1.p95Ms,
  fakeProviderProfiles.concurrency8.p95Ms,
);
const absoluteGates = referenceMachine.absoluteGatesApplied
  ? {
      schedulerKernel: gate(schedulerWorstP95, 25),
      journalCommit: gate(journalWorstP95, 10),
    }
  : null;
const measuredGates = {
  ...auxiliaryGates,
  retainedHeap: {
    passed: retainedHeap.status === 'measured' &&
      retainedHeap.slopeMiBPer10Turns <= 0.5 && retainedHeap.finalDeltaFromTurn50MiB <= 10,
    slopeThresholdMiBPer10Turns: 0.5,
    finalDeltaThresholdMiB: 10,
  },
  deltaSynchronousAmplification: {
    passed: writeAmplification.delta.synchronous.passed,
    observedWrites: writeAmplification.delta.synchronous.journalWriteCount,
    maximumWrites: writeAmplification.delta.synchronous.maximumJournalWrites,
  },
  deltaPacedAmplification: {
    passed: writeAmplification.delta.paced.passed,
    observedWrites: writeAmplification.delta.paced.journalWriteCount,
    maximumWrites: writeAmplification.delta.paced.maximumJournalWrites,
  },
  toolProgressAmplification: {
    passed: writeAmplification.progress.passed,
    observedWrites: writeAmplification.progress.journalWriteCount,
    maximumWrites: writeAmplification.progress.maximumJournalWrites,
  },
};
const passed = Object.values(measuredGates).every((item) => item.passed) &&
  (absoluteGates === null || Object.values(absoluteGates).every((item) => item.passed));
const qualificationReasons = normativeQualificationReasons({
  profileName,
  warmup,
  schedulerProfiles,
  journalProfiles,
  writeAmplification,
  environment,
});
const report = {
  kind: 'agent-runtime-layered-performance',
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  protocol: {
    profile: profileName,
    build: { kind: 'release-dist-imports', importsCompiledDist: true },
    normative: NORMATIVE_PROTOCOL,
    actual: {
      warmupMs: warmup.actualMs,
      journalSamplesPerLevel: profile.journalSamples,
      schedulerSamplesPerLevel: profile.schedulerSamples,
      deltaChunkCount: profile.deltaChunkCount,
      deltaPacedIntervalMs: profile.deltaPacedIntervalMs,
      progressUpdateCount: profile.progressUpdateCount,
    },
    storage: { journalMode: 'wal', synchronous: 'full', projectLayout: 'single-local-project' },
  },
  environment,
  referenceMachine,
  dataset: {
    toolCount: TOOL_COUNT,
    invocationBatchSize: invocationCalls.length,
    projectFileCount: PROJECT_FILE_COUNT + 3,
    searchQualityCaseCount: SEARCH_QUALITY_CASES.length,
  },
  measurements: {
    schedulerKernel: {
      scope: 'Canonical completed Tool Call facts are converted to immutable scheduling facts and reduced by the pure Tool scheduler.',
      excludes: ['Handler execution', 'SQLite/Journal I/O', 'Provider decoding', 'network'],
      includesHandler: false,
      includesJournalIo: false,
      includesProvider: false,
      absoluteThresholdP95Ms: 25,
      absoluteGate: absoluteGates?.schedulerKernel ?? null,
      profiles: schedulerProfiles,
    },
    journalCommit: {
      scope: 'One ordinary Agent event plus its command receipt committed through SqliteAgentJournal.',
      excludes: ['Tool Handler execution', 'Provider decoding', 'network'],
      storagePragmas,
      absoluteThresholdP95Ms: 10,
      absoluteGate: absoluteGates?.journalCommit ?? null,
      profiles: journalProfiles,
    },
    fakeProviderBaseline: {
      scope: 'In-process deterministic JSON Provider response decoded and validated by ModelExecutionGateway; no network, Journal, scheduler, or Handler.',
      profiles: fakeProviderProfiles,
    },
    durableInvocationBatch: {
      classification: 'informational',
      scope: 'Twenty already-committed read Tool invocations pass through validation, authorization, Handler execution, durable lifecycle transitions, and Observation commits.',
      includesHandler: true,
      includesJournalIo: true,
      includesProviderDecode: false,
      gate: null,
      ...timingProfile(durableInvocationBatchMs),
    },
    retainedHeap,
    writeAmplification,
    auxiliary: auxiliaryMetrics,
  },
  relativeToFakeProvider: {
    basis: 'worst P95 across concurrency 1 and 8 on this machine',
    schedulerP95Ratio: roundTiming(schedulerWorstP95 / Math.max(fakeProviderWorstP95, 0.001)),
    schedulerAddedP95Ms: roundTiming(schedulerWorstP95 - fakeProviderWorstP95),
    schedulerP95Ms: roundTiming(schedulerWorstP95),
    fakeProviderP95Ms: roundTiming(fakeProviderWorstP95),
    journalP95Ratio: roundTiming(journalWorstP95 / Math.max(fakeProviderWorstP95, 0.001)),
  },
  gates: { measured: measuredGates, absoluteReferenceOnly: absoluteGates },
  qualification: {
    normative: qualificationReasons.length === 0,
    reasons: qualificationReasons,
  },
  auxiliaryThresholds,
  searchQualityCases: searchQuality.cases,
  passed,
  notes: [
    'The 25ms scheduler threshold is never applied to Handler or durable SQLite work.',
    'Absolute scheduler and Journal thresholds are applied only when the registered reference machine ID exactly matches this machine fingerprint.',
    'Non-reference machines report their local measurements relative to the deterministic Fake Provider baseline.',
    'The durable invocation batch is informational and has no gate.',
    'Raw timing and retained-heap samples are retained in this report.',
  ],
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!passed) throw new Error(`Agent runtime performance gate failed: ${reportPath}`);
process.stdout.write(`${JSON.stringify({
  reportPath,
  passed,
  qualified: report.qualification.normative,
  referenceMachine: referenceMachine.decision,
  schedulerP95Ms: schedulerWorstP95,
  journalP95Ms: journalWorstP95,
  durableBatchP95Ms: report.measurements.durableInvocationBatch.p95Ms,
}, null, 2)}\n`);

function createToolCatalog() {
  const catalog = new ToolRegistry();
  catalog.publishBaselineInvocations(BASE_TOOL_MANIFEST.map(({ name, schemaRevision }) => {
    const definition = {
      name,
      title: `Baseline ${name}`,
      description: `Benchmark fixture for baseline Tool ${name}.`,
      aliases: [],
      tags: ['benchmark', 'baseline'],
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: { type: 'object' },
      dangerLevel: 'safe',
      readonly: true,
      exposure: 'direct',
      access: 'read',
      recoveryClass: 'read',
      source: 'runtime',
      toolRevision: schemaRevision,
      handlerRevision: `benchmark:${name}@1`,
      intentRevision: 'prepared-tool-intent.v1',
      limits: benchmarkToolLimits(),
      permission: { actions: ['read'] },
      execution: { concurrency: 'read', timeoutMs: 60_000 },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    };
    return { definition, runtime: benchmarkToolRuntime(definition, () => ({ status: 'ok', summary: `${name} benchmark fixture completed.` })) };
  }));
  const noiseToolCount = TOOL_COUNT - SEARCH_TARGETS.length - BASE_TOOL_MANIFEST.length;
  for (let index = 0; index < noiseToolCount; index += 1) {
    const name = `tool_${index}`;
    const definition = {
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
        outputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        exposure: index < 4 ? 'direct' : 'deferred',
        access: 'read',
        recoveryClass: 'read',
        source: 'benchmark',
        toolRevision: `benchmark:${name}:schema@1`,
        handlerRevision: `benchmark:${name}@1`,
        intentRevision: 'prepared-tool-intent.v1',
        limits: benchmarkToolLimits(),
        execution: { concurrency: 'read', timeoutMs: 60_000 },
        failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      };
    catalog.registerInvocation(definition, benchmarkToolRuntime(definition, () => ({ ok: true, name })));
  }
  for (const target of SEARCH_TARGETS) {
    const definition = {
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
        outputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        exposure: 'deferred',
        access: 'read',
        recoveryClass: 'read',
        source: 'benchmark',
        toolRevision: `benchmark:${target.name}:schema@1`,
        handlerRevision: `benchmark:${target.name}@1`,
        intentRevision: 'prepared-tool-intent.v1',
        limits: benchmarkToolLimits(),
        execution: { concurrency: 'read', timeoutMs: 60_000 },
        failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      };
    catalog.registerInvocation(definition, benchmarkToolRuntime(definition, () => ({ ok: true, name: target.name })));
  }
  assert.equal(catalog.list().length, TOOL_COUNT);
  return catalog;
}

function benchmarkToolLimits() { return { timeoutMs: 60_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 }; }
function benchmarkToolRuntime(definition, execute) { return { revision: { toolName: definition.name, toolRevision: definition.toolRevision, handlerRevision: definition.handlerRevision, intentRevision: definition.intentRevision }, prepare: (input, context) => ({ input, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: context.intentRevision, targetIdentity: null, generation: context.generation, action: { summary: `Run benchmark Tool ${definition.name}.` }, permission: { toolName: definition.name, dangerLevel: 'safe', readonly: true, access: 'read', recoveryClass: 'read', actions: ['read'], paths: [], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [] }, access: 'read', recoveryClass: 'read', concurrency: 'read', resourceKeys: [`benchmark:${definition.name}`], limits: context.limits }), execute }; }

async function measureCommittedInvocationBatches(samples, registry, calls, directory) {
  const values = [];
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const { runtime } = await prepareCommittedInvocationBatch(
      registry,
      calls,
      join(directory, `invocation-${sampleIndex}.db`),
      sampleIndex,
    );
    const startedAt = performance.now();
    const observations = await runtime.executeEligible();
    values.push(performance.now() - startedAt);
    assert.equal(observations.length, calls.length);
    assert(observations.every(({ outcome }) => outcome === 'succeeded'), JSON.stringify(observations));
  }
  return values;
}

async function prepareCommittedInvocationBatch(registry, calls, filePath, sampleIndex) {
  const projectId = 'benchmark-project';
  const sessionId = `benchmark-session-${sampleIndex}`;
  const journal = new SqliteAgentJournal({ filePath });
  const created = await journal.createRun({
    projectId,
    sessionId,
    clientRequestId: `benchmark-request-${sampleIndex}`,
    input: 'Benchmark Tool Invocation scheduling.',
  });
  const lease = await journal.acquireRunLease({
    projectId,
    runId: created.runId,
    ownerId: `benchmark-worker-${sampleIndex}`,
    ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId,
    sessionId,
    runId: created.runId,
    commandId: `benchmark-start-run-${sampleIndex}`,
    lease: leaseRef,
    expectedRunRevision: 1,
  });
  const turnId = `benchmark-turn-${sampleIndex}`;
  await journal.startTurn({
    projectId,
    sessionId,
    runId: created.runId,
    turnId,
    commandId: `benchmark-start-turn-${sampleIndex}`,
    lease: leaseRef,
    expectedRunRevision: 2,
  });
  await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId,
    sessionId,
    runId: created.runId,
    turnId,
    commandId: `benchmark-commit-attempt-${sampleIndex}`,
    lease: leaseRef,
    expectedRunRevision: 3,
    expectedTurnRevision: 1,
    // The benchmark's deterministic in-process model route is locally supplied,
    // so its synthetic usage belongs to the BYOK ledger rather than managed usage.
    billingMode: 'byok',
    attempt: await invocationAttempt(calls, sampleIndex),
  });
  const snapshot = registry.captureSnapshot();
  const runtime = new ToolInvocationRuntime({
    journal,
    registry: snapshot,
    allowedTools: snapshot.list().flatMap(({ name }) => {
      const revision = snapshot.invocationRevision(name);
      return revision === undefined ? [] : [{ name, revision }];
    }),
    permissionManager: new PermissionManager(),
    binding: {
      projectId,
      sessionId,
      runId: created.runId,
      turnId,
      lease,
      mode: 'full-access',
    },
  });
  return { runtime, journal };
}

async function measureToolProgressWriteAmplification({ updateCount, databasePath }) {
  const progressRegistry = new ToolRegistry();
  const definition = {
    namespace: 'benchmark',
    name: 'progress_benchmark',
    title: 'Progress benchmark',
    description: 'Exercises the production Tool Handler progress path.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    dangerLevel: 'safe',
    readonly: true,
    exposure: 'direct',
    access: 'read',
    recoveryClass: 'read',
    source: 'benchmark',
    toolRevision: 'progress_benchmark.v1',
    handlerRevision: 'progress-benchmark@1',
    intentRevision: 'prepared-tool-intent.v1',
    limits: benchmarkToolLimits(),
    permission: { actions: ['read'] },
    execution: { concurrency: 'read', timeoutMs: 60_000 },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
  };
  progressRegistry.registerInvocation(definition, benchmarkToolRuntime(definition, (_arguments, context) => {
      for (let index = 0; index < updateCount; index += 1) {
        context.reportProgress('x');
      }
      return { completed: true };
    }));
  const { runtime, journal } = await prepareCommittedInvocationBatch(
    progressRegistry,
    [{ name: 'progress_benchmark', arguments: {} }],
    databasePath,
    'progress',
  );
  const startedAt = performance.now();
  const observations = await runtime.executeEligible();
  const elapsedMs = performance.now() - startedAt;
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.outcome, 'succeeded');
  const events = await journal.readProject('benchmark-project', 0, Math.max(1_000, updateCount));
  const progressEvents = events.filter(({ type }) => type === 'tool.progress');
  const totalSemanticBytes = Math.max(0, (updateCount * 2) - 1);
  const maximumJournalWrites = Math.ceil(totalSemanticBytes / 4_096) + 1;
  return {
    status: 'supported',
    fixture: 'synchronous-1-character-updates',
    scope: 'Production ToolInvocationExecutionContext.reportProgress through ToolInvocationRuntime and the sealed SQLite Tool lifecycle authority.',
    requiredUpdateCount: NORMATIVE_PROTOCOL.deltaChunkCount,
    actualUpdateCount: updateCount,
    byteThreshold: 4_096,
    timeThresholdMs: 40,
    totalSemanticBytes,
    journalWriteCount: progressEvents.length,
    maximumJournalWrites,
    batchBytes: progressEvents.map(({ payload }) =>
      Buffer.byteLength(payload.summary, 'utf8')),
    terminalOutcome: observations[0]?.outcome ?? 'missing',
    elapsedMs: round(elapsedMs),
    passed:
      progressEvents.length > 0 &&
      progressEvents.length < updateCount &&
      progressEvents.length <= maximumJournalWrites &&
      progressEvents.every(({ payload }) =>
        Buffer.byteLength(payload.summary, 'utf8') <= 4_096),
  };
}

async function invocationAttempt(calls, sampleIndex) {
  const response = {
    id: `benchmark-response-${sampleIndex}`,
    model: 'benchmark-model',
    status: 'completed',
    output: calls.map((call, index) => ({
      id: `benchmark-item-${sampleIndex}-${index}`,
      type: 'function_call',
      call_id: `benchmark-call-${sampleIndex}-${index}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const route = {
    routeId: 'benchmark-route',
    connectionId: 'benchmark-connection',
    providerId: 'benchmark-provider',
    modelId: 'benchmark-model',
    protocol: 'openai-responses',
    codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384,
    maxInputTokens: 12_288,
    maxOutputTokens: 4_096,
    metadata: { source: 'benchmark', revision: '1', digest: 'benchmark-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec(route.protocol, route.codecRevision);
  assert(codec, 'OpenAI Responses codec must be available for the benchmark.');
  const session = createModelSession({
    route,
    generation: {},
    codec,
    client: { execute: () => Promise.resolve({ kind: 'json', response }) },
  });
  const execution = await new ModelExecutionGateway({
    createAttemptId: () => `benchmark-attempt-${sampleIndex}`,
  }).executeAttempt(session, {
    model: route.modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Benchmark invocation batch.' }] }],
  });
  return execution.attempt;
}

async function prepareOrdinaryJournalFixture(filePath) {
  const projectId = 'journal-benchmark-project';
  const sessionId = 'journal-benchmark-session';
  const journal = new SqliteAgentJournal({ filePath });
  const created = await journal.createRun({
    projectId,
    sessionId,
    clientRequestId: 'journal-benchmark-request',
    input: 'Measure one ordinary Journal event commit.',
  });
  const lease = await journal.acquireRunLease({
    projectId,
    runId: created.runId,
    ownerId: 'journal-benchmark-worker',
    ttlMs: 3_600_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId,
    sessionId,
    runId: created.runId,
    commandId: 'journal-benchmark-start',
    lease: leaseRef,
    expectedRunRevision: 1,
  });
  return { journal, projectId, sessionId, runId: created.runId, lease: leaseRef };
}

async function warmRuntime(minimumMs, journalFixture, calls) {
  const startedAt = performance.now();
  let schedulerIterations = 0;
  let journalCommits = 0;
  while (performance.now() - startedAt < minimumMs) {
    schedulerDecision(calls, schedulerIterations % 2 === 0 ? 1 : 8);
    schedulerIterations += 1;
    if (schedulerIterations % 128 === 0 || journalCommits === 0) {
      await commitOrdinaryEvent(journalFixture, `warmup-${journalCommits}`, journalCommits);
      journalCommits += 1;
    }
  }
  return {
    requiredMs: NORMATIVE_PROTOCOL.minimumWarmupMs,
    configuredMs: minimumMs,
    actualMs: round(performance.now() - startedAt),
    schedulerIterations,
    journalCommits,
  };
}

function schedulerProfile(samples, calls, concurrency) {
  const rawSamplesMs = measure(samples, () => schedulerDecision(calls, concurrency));
  return {
    concurrency,
    sampleCount: rawSamplesMs.length,
    ...timingProfile(rawSamplesMs),
  };
}

function schedulerDecision(calls, concurrency) {
  const invocations = calls.map((call, actionOrdinal) => ({
    invocationId: `scheduled-${actionOrdinal}-${call.name}`,
    actionOrdinal,
    recoveryClass: 'read',
    access: 'read',
    concurrency: 'read',
    resourceKeys: [`benchmark:${actionOrdinal}:${call.name}`],
    state: 'authorized',
  }));
  const decision = decideSchedule({ invocations, maxConcurrency: concurrency });
  assert.equal(decision.state, 'ExecutingTools');
  assert.equal(decision.invocationIds.length, Math.min(concurrency, calls.length));
  return decision;
}

async function journalCommitProfile(samples, concurrency, fixture, prefix) {
  const rawSamplesMs = await measureConcurrent(samples, concurrency, async (sampleIndex) => {
    await commitOrdinaryEvent(fixture, `${prefix}-${sampleIndex}`, sampleIndex);
  });
  return {
    concurrency,
    sampleCount: rawSamplesMs.length,
    ...timingProfile(rawSamplesMs),
  };
}

async function commitOrdinaryEvent(fixture, commandSuffix, sampleIndex) {
  const digest = createHash('sha256').update(`${commandSuffix}:${sampleIndex}`).digest('hex');
  const committed = await fixture.journal.commit({
    projectId: fixture.projectId,
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    commandId: `ordinary-${commandSuffix}`,
    lease: fixture.lease,
    expectedRunRevision: 2,
    events: [{ type: 'artifact.expired', payload: { artifactId: `artifact_${digest}` } }],
  });
  assert.equal(committed.events.length, 1);
}

async function fakeProviderProfile(samples, concurrency, calls) {
  const rawSamplesMs = await measureConcurrent(samples, concurrency, async (sampleIndex) => {
    const attempt = await invocationAttempt(calls, `fake-${concurrency}-${sampleIndex}`);
    assert.equal(attempt.blocks.length, calls.length);
  });
  return {
    concurrency,
    sampleCount: rawSamplesMs.length,
    ...timingProfile(rawSamplesMs),
  };
}

async function measureConcurrent(samples, concurrency, operation) {
  const values = new Array(samples);
  for (let offset = 0; offset < samples; offset += concurrency) {
    const batchSize = Math.min(concurrency, samples - offset);
    await Promise.all(Array.from({ length: batchSize }, async (_, batchIndex) => {
      const sampleIndex = offset + batchIndex;
      const startedAt = performance.now();
      await operation(sampleIndex);
      values[sampleIndex] = performance.now() - startedAt;
    }));
  }
  return values;
}

async function measureRetainedHeap(turns) {
  if (typeof globalThis.gc !== 'function') {
    return {
      status: 'not-run',
      reason: 'Run Node with --expose-gc to measure retained heap.',
      requiresExposeGc: true,
      turns,
      rawRetainedHeapBytes: [],
      slopeMiBPer10Turns: null,
      finalDeltaFromTurn50MiB: null,
    };
  }
  const calls = [{ name: 'tool_0', arguments: { input: 'heap' } }];
  const rawRetainedHeapBytes = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    let state = transitionAgentRunState({ state: 'created' }, { type: 'run-started' });
    state = transitionAgentRunState(state, { type: 'context-ready' });
    state = transitionAgentRunState(state, { type: 'model-attempt-started' });
    const attempt = await invocationAttempt(calls, `heap-${turn}`);
    assert.equal(attempt.blocks.length, 1);
    state = transitionAgentRunState(state, { type: 'model-attempt-committed', hasActions: true });
    const authorized = schedulerDecision(calls, 1);
    state = transitionAgentRunState(state, { type: 'schedule-decided', decision: authorized });
    const applying = decideSchedule({
      invocations: [{ invocationId: 'heap-invocation', actionOrdinal: 0, recoveryClass: 'read', access: 'read', concurrency: 'read', resourceKeys: ['benchmark:heap'], state: 'succeeded' }],
      maxConcurrency: 1,
    });
    state = transitionAgentRunState(state, { type: 'schedule-decided', decision: applying });
    const ready = decideSchedule({
      invocations: [{ invocationId: 'heap-invocation', actionOrdinal: 0, recoveryClass: 'read', access: 'read', concurrency: 'read', resourceKeys: ['benchmark:heap'], state: 'observed' }],
      maxConcurrency: 1,
    });
    state = transitionAgentRunState(state, { type: 'schedule-decided', decision: ready });
    state = transitionAgentRunState(state, { type: 'turn-observed' });
    assert.equal(state.state, 'Preparing');
    globalThis.gc();
    rawRetainedHeapBytes.push(process.memoryUsage().heapUsed);
  }
  const tail = rawRetainedHeapBytes.slice(50);
  const slopeBytesPerTurn = linearSlope(tail);
  const turn50 = rawRetainedHeapBytes[49] ?? rawRetainedHeapBytes[0] ?? 0;
  const final = rawRetainedHeapBytes.at(-1) ?? turn50;
  return {
    status: 'measured',
    scope: '100 isolated state-machine Turns using the deterministic Fake Provider; no Journal is opened, so SQLite file cache is excluded by construction.',
    requiresExposeGc: true,
    turns,
    rawRetainedHeapBytes,
    slopeMiBPer10Turns: round((slopeBytesPerTurn * 10) / (1024 * 1024)),
    finalDeltaFromTurn50MiB: round((final - turn50) / (1024 * 1024)),
  };
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

async function measureDeltaWriteAmplification({ chunkCount, intervalMs, databasePath }) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE delta_batches (sequence INTEGER PRIMARY KEY, payload_json TEXT NOT NULL);
  `);
  const insert = database.prepare(
    'INSERT INTO delta_batches (sequence, payload_json) VALUES (?, ?)',
  );
  let journalWriteCount = 0;
  const batchSizes = [];
  let sequence = 0;
  const observer = new BatchingModelTurnObserver({
    maxBytes: 4_096,
    maxDelayMs: 40,
    sink: {
      publish(fact) {
        assert.equal(fact.type, 'model-delta-batch');
        database.exec('BEGIN IMMEDIATE');
        try {
          insert.run(sequence, JSON.stringify(fact));
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        sequence += 1;
        journalWriteCount += 1;
        batchSizes.push(fact.events.length);
        return Promise.resolve();
      },
    },
  });
  let totalSerializedBytes = 0;
  const startedAt = performance.now();
  let firstArrivalAt = startedAt;
  let lastArrivalAt = startedAt;
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const arrivedAt = performance.now();
      if (index === 0) firstArrivalAt = arrivedAt;
      lastArrivalAt = arrivedAt;
      const event = {
        type: 'decoded-delta',
        attemptId: 'write-amplification-attempt',
        routeId: 'write-amplification-route',
        occurredAt: index,
        event: { type: 'text-delta', text: 'x', blockOrdinal: 0 },
      };
      totalSerializedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      await observer.onEvent(event);
      if (intervalMs > 0) {
        const nextArrivalAt = startedAt + ((index + 1) * intervalMs);
        const waitMs = nextArrivalAt - performance.now();
        if (waitMs > 0) await delay(waitMs);
      }
    }
    await observer.flush();
    await observer.close();
  } finally {
    database.close();
  }
  const elapsedMs = performance.now() - startedAt;
  const arrivalSpanMs = Math.max(0, lastArrivalAt - firstArrivalAt);
  const byteBound = Math.floor(totalSerializedBytes / 4_096) + 1;
  const timeBound = intervalMs === 0 ? 0 : Math.ceil(arrivalSpanMs / 40) + 1;
  const maximumJournalWrites = Math.min(chunkCount, byteBound + timeBound);
  return {
    fixture: intervalMs === 0 ? 'synchronous-1-character-chunks' : 'paced-1-character-chunks',
    scope: 'Production BatchingModelTurnObserver feeding a minimal SQLite WAL/FULL transaction sink; this isolates transaction amplification from Agent event validation cost.',
    requiredChunkCount: NORMATIVE_PROTOCOL.deltaChunkCount,
    actualChunkCount: chunkCount,
    intervalMs,
    byteThreshold: 4_096,
    timeThresholdMs: 40,
    totalSerializedBytes,
    arrivalSpanMs: round(arrivalSpanMs),
    journalWriteCount,
    maximumJournalWrites,
    batchSizes,
    elapsedMs: round(elapsedMs),
    passed: journalWriteCount <= maximumJournalWrites && journalWriteCount < chunkCount,
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function describeEnvironment() {
  const workspaceDisk = await statfs(resolve('.'));
  const disk = detectDisk();
  const powerMode = detectPowerMode();
  const descriptor = {
    hostname: hostname(),
    architecture: arch(),
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
    sqlite: process.versions.sqlite ?? 'unknown',
    diskIdentity: disk.identity,
  };
  return {
    ...descriptor,
    machineId: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
    disk: {
      ...disk,
      workspacePath: resolve('.'),
      filesystemTotalBytes: Number(workspaceDisk.blocks) * Number(workspaceDisk.bsize),
      filesystemFreeBytes: Number(workspaceDisk.bfree) * Number(workspaceDisk.bsize),
    },
    powerMode,
  };
}

function detectDisk() {
  const declaredMedium = process.env.SCHEMANAUT_AGENT_BENCHMARK_DISK_MEDIUM?.trim();
  const declaredIdentity = process.env.SCHEMANAUT_AGENT_BENCHMARK_DISK?.trim();
  if (declaredMedium || declaredIdentity) {
    return {
      identity: declaredIdentity || 'declared-disk',
      medium: declaredMedium || 'unreported',
      source: 'benchmark-environment',
    };
  }
  if (platform() !== 'win32') {
    return { identity: 'unreported', medium: 'unverified', source: 'unavailable' };
  }
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-PhysicalDisk | Sort-Object DeviceId | Select-Object -First 1 FriendlyName,MediaType,BusType | ConvertTo-Json -Compress',
    ], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const value = JSON.parse(output);
    return {
      identity: [value.FriendlyName, value.BusType].filter(Boolean).join(' / ') || 'unreported',
      medium: String(value.MediaType || 'unverified').toLowerCase(),
      source: 'windows-physical-disk',
    };
  } catch {
    return { identity: 'unreported', medium: 'unverified', source: 'unavailable' };
  }
}

function detectPowerMode() {
  const declared = process.env.SCHEMANAUT_AGENT_BENCHMARK_POWER_MODE?.trim();
  if (declared) return { value: declared, source: 'benchmark-environment' };
  if (platform() !== 'win32') return { value: 'unreported', source: 'unavailable' };
  try {
    return {
      value: execFileSync('powercfg.exe', ['/GETACTIVESCHEME'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true,
      }).trim(),
      source: 'windows-powercfg',
    };
  } catch {
    return { value: 'unreported', source: 'unavailable' };
  }
}

function normativeQualificationReasons({
  profileName,
  warmup,
  schedulerProfiles,
  journalProfiles,
  writeAmplification,
  environment,
}) {
  const reasons = [];
  if (profileName !== 'normative') reasons.push('contract profile is explicitly non-normative');
  if (warmup.actualMs < NORMATIVE_PROTOCOL.minimumWarmupMs) reasons.push('warmup shorter than 10 seconds');
  for (const profile of Object.values(schedulerProfiles)) {
    if (profile.sampleCount < NORMATIVE_PROTOCOL.minimumSchedulerSamplesPerLevel) {
      reasons.push(`scheduler concurrency ${profile.concurrency} has fewer than 500 samples`);
    }
  }
  for (const profile of Object.values(journalProfiles)) {
    if (profile.sampleCount < NORMATIVE_PROTOCOL.minimumJournalSamplesPerLevel) {
      reasons.push(`Journal concurrency ${profile.concurrency} has fewer than 1000 samples`);
    }
  }
  if (writeAmplification.delta.synchronous.actualChunkCount < NORMATIVE_PROTOCOL.deltaChunkCount) {
    reasons.push('synchronous delta fixture has fewer than 10000 chunks');
  }
  if (writeAmplification.delta.paced.actualChunkCount < NORMATIVE_PROTOCOL.deltaChunkCount) {
    reasons.push('paced delta fixture has fewer than 10000 chunks');
  }
  if (writeAmplification.progress.status !== 'supported') {
    reasons.push('production Tool progress batching path is unavailable');
  } else if (writeAmplification.progress.actualUpdateCount < NORMATIVE_PROTOCOL.deltaChunkCount) {
    reasons.push('Tool progress fixture has fewer than 10000 updates');
  } else if (!writeAmplification.progress.passed) {
    reasons.push('production Tool progress batching exceeded its write bound');
  }
  if (!['ssd', 'nvme'].some((token) => environment.disk.medium.includes(token))) {
    reasons.push('local SSD medium was not verified');
  }
  if (environment.powerMode.value === 'unreported') reasons.push('power mode was not reported');
  return reasons;
}

function timingProfile(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    rawSamplesMs: values.map(roundTiming),
    minMs: roundTiming(sorted[0] ?? 0),
    p50Ms: roundTiming(percentile(sorted, 0.5)),
    p95Ms: roundTiming(percentile(sorted, 0.95)),
    maxMs: roundTiming(sorted.at(-1) ?? 0),
  };
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
    evaluated.filter((item) => item.rank !== null && item.rank <= limit).length / evaluated.length;
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
  await writeFile(join(directory, 'AGENTS.md'), 'benchmark project instruction\n', 'utf8');
  await writeFile(join(directory, 'package.json'), '{"packageManager":"pnpm@10"}\n', 'utf8');
  await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  await Promise.all(
    Array.from({ length: PROJECT_FILE_COUNT }, (_, index) =>
      writeFile(
        join(directory, 'src', `module-${index}.ts`),
        `export const n${index} = ${index};\n`,
      ),
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
    await operation(index);
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

function roundTiming(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
