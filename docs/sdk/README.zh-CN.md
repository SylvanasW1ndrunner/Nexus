# SchemaNaut SDK 使用指南

[English](README.md) · [API 参考](api-reference.zh-CN.md) · [项目首页](../../README.zh-CN.md)

本文说明 `@nwlworkshop/schemanaut` 对外提供的 Node.js/TypeScript SDK。

> 公开包名已经确定，但尚未发布到 npm。Alpha 阶段请先从源码生成并安装本地压缩包。

## 1. 环境与安装

- Node.js 22.5 或更高版本
- ESM 应用，或能够使用 ESM 的构建工具
- PostgreSQL：当前首个完整参考 Connector
- 运行 Agent 时需要具备 Tool Calling 能力的模型

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

安装包包含 JavaScript、TypeScript 类型声明、CLI、中英文 README 与 SDK 文档、许可证和第三方声明。

## 2. Runtime 生命周期

`DatabaseAgentRuntime` 是主要入口。典型生命周期如下：

1. 创建模型 Provider 与 Runtime。
2. 测试或打开数据库连接。
3. 构建 Schema 知识索引。
4. 运行 Agent，或直接生成 SQL。
5. 查看结果、审计、资源和指标。
6. 应用退出时调用 `close()`。

```ts
import {
  DatabaseAgentRuntime,
  createProviderFromPreset,
} from '@nwlworkshop/schemanaut';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'local-team',
  provider: createProviderFromPreset('siliconflow', {
    apiKey: process.env.LLM_API_KEY,
  }),
  model: process.env.LLM_MODEL!,
});

try {
  // 使用 runtime。
} finally {
  await runtime.close();
}
```

未提供 `sessionDatabasePath` 时，Agent Session 默认保存在当前工作目录的 `.schemanaut/schemanaut.db`。

## 3. 模型 Provider

### Provider 预设

内置预设包括 `siliconflow`、`deepseek`、`zhipu`、`moonshot`、`ollama` 和 `vllm`。

```ts
import { createProviderFromPreset } from '@nwlworkshop/schemanaut';

const cloud = createProviderFromPreset('deepseek', {
  apiKey: process.env.LLM_API_KEY,
  timeoutMs: 60_000,
  maxRetries: 1,
});

const local = createProviderFromPreset('ollama', {
  baseUrl: 'http://127.0.0.1:11434/v1',
});
```

预设声明协议已知能力。`discoverLlmModels()` 只读取 Provider 的模型目录和元数据接口，不会向模型发送能力验证 Prompt。

### 通用 OpenAI-compatible 接口

```ts
import { OpenAICompatibleProvider } from '@nwlworkshop/schemanaut';

const provider = new OpenAICompatibleProvider({
  id: 'private-gateway',
  name: 'Private gateway',
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY,
  allowUnauthenticated: false,
  timeoutMs: 60_000,
  maxRetries: 1,
});
```

私有无鉴权接口可设置 `allowUnauthenticated: true`。

### Anthropic Messages

```ts
import { AnthropicProvider } from '@nwlworkshop/schemanaut';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

### 运行中配置或替换 Provider

```ts
runtime.configureProvider(provider, 'your-model-id');
const models = await runtime.discoverLlmModels();
const status = runtime.status();
```

## 4. PostgreSQL 快捷入口

高层快捷入口适合直接使用首个参考 Connector。

```ts
const input = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME!,
  username: process.env.DB_USER!,
  password: process.env.DB_PASSWORD,
  ssl: false,
  readOnly: true,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
};

const test = await runtime.testConnection(input);
console.log(test.latencyMs, test.readOnly);

const connection = await runtime.connect(input);
console.log(connection.id);
```

`connect()` 会先关闭上一个快捷连接。密码只传给 Connector，不进入公开连接档案。

## 5. 构建与刷新知识索引

```ts
const snapshot = await runtime.indexSchema({ maxTables: 500 });
console.log(snapshot);
```

公开快捷入口单次允许索引 1–1,000 个关系对象，默认 200。知识层根据发现的资源和关系构建分层目录与检索索引。

Agent 内置 SQL 工具修改 Schema 后会刷新当前索引。若 Schema 由 SchemaNaut 外部修改，请在下一次 Agent 运行前重新调用 `indexSchema()`。通过 `schemaStatus()` 检查是否就绪。

可选的检索配置可以把 Embedding 和 Rerank 绑定到已经注册的模型 Provider：

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model: process.env.LLM_MODEL!,
  retrievalProfile: {
    id: 'bilingual-schema',
    version: 1,
    backend: { type: 'memory', bm25K1: 1.2, bm25B: 0.75 },
    embedding: {
      providerInstanceId: 'private-gateway',
      modelId: process.env.EMBEDDING_MODEL!,
      dimensions: 1024,
      normalization: 'l2',
      distanceMetric: 'cosine',
      requestTemplateVersion: '1',
    },
    defaultLimit: 8,
    defaultMaxContextTokens: 1_500,
    graphHops: 1,
    rrfK: 60,
  },
});
```

Embedding 模型应同时适配用户自然语言与数据库中的标识符。SDK 不强制使用仅面向中文的 Embedding 模型。

## 6. 运行 AI SQL Agent

```ts
const first = await runtime.runAgent({
  userId: 'user-42',
  message: '从 Kafka 事件表的 JSON value 中提取渠道，统计本周每天的支付金额。',
  mode: 'read',
  maxIterations: 12,
  maxToolExecutionMs: 30_000,
});

console.log(first.selectedSkill);
console.log(first.result.status);
console.log(first.result.finalText);
console.table(first.result.toolExecutions);
```

Agent 只接收完成任务所需的 Tool 返回。目录 Hash、内部节点 ID 和树索引保留在知识实现内部，不进入模型侧检索结果。

### 继续 Session

```ts
const continued = await runtime.runAgent({
  sessionId: first.result.session.id,
  message: '按渠道再拆分，并说明异常波动。',
  mode: 'read',
});
```

`session` 与 `sessionId` 只能提供一个。

### 权限与批准

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model,
  approvalProvider: async ({ mode, tool, toolCall, sessionId }) => {
    return await requestApprovalInYourApplication({
      mode,
      toolName: tool.name,
      arguments: toolCall.arguments,
      sessionId,
    });
  },
});
```

`approvalProvider` 可以返回布尔值，也可以返回：

```ts
{
  approved: true,
  requestId: 'approval-123',
  approvedBy: 'operator-7',
  approvedAt: new Date().toISOString(),
  reason: '已通过变更流程复核',
}
```

未配置批准回调时，超出当前 `read`、`edit` 或 `full` 模式的动作不会得到批准。

## 7. Session 历史与上下文压缩

SQLite 存储保留完整消息历史。上下文压缩只改变模型当前工作视图。

```ts
const compacted = await runtime.compactAgentSession({
  sessionId: first.result.session.id,
  focus: '保留精确 SQL、精确结果、用户决定和未完成事项。',
});

const checkpoints = await runtime.agentContextCheckpoints(
  first.result.session.id,
  20,
);
```

当活跃 Prompt 接近所选模型的物理窗口时，Runtime 也会自动压缩。模型总结失败时，确定性回退策略会继续维持对话。

Session Store 通过 `runtime.sessions` 对外提供：

```ts
const recent = await runtime.sessions.list({ userId: 'user-42', limit: 20 });
const session = await runtime.sessions.load(first.result.session.id);
const exported = await runtime.sessions.export(first.result.session.id, 'json');
const forked = await runtime.sessions.fork({
  id: first.result.session.id,
  fromMessageIndex: first.result.session.messages.length - 1,
  title: '另一种分析路径',
});
```

它还支持更新、归档、删除、用户偏好和上下文检查点查询。完整方法见 API 参考。

## 8. 确定性的 SQL 生成与执行

`generate()` 使用检索到的 Schema 上下文，但不会执行结果。

```ts
const generated = await runtime.generate({
  question: '查询本月已支付金额最高的 10 个活跃客户',
  maxContextChars: 12_000,
});

console.log({
  sql: generated.sql,
  explanation: generated.explanation,
  assumptions: generated.assumptions,
  evidence: generated.evidence,
  safety: generated.safety,
});
```

只有 `awaiting_execution` 状态的运行记录才能传给 `executeGenerated()`：

```ts
if (generated.status === 'awaiting_execution') {
  const executed = await runtime.executeGenerated(generated.runId, {
    limit: 200,
  });
  console.table(executed.execution.rows);
}
```

这个快捷入口有意只允许单条只读语句。数据修改或 DDL 应使用与权限模式匹配的 `runAgent()`。

## 9. 直接调用模型

### 同步 Chat

```ts
const reply = await runtime.llmChat(
  {
    messages: [{ role: 'user', content: '解释这个执行计划。' }],
  },
  {
    taskType: 'query-plan-explanation',
    userId: 'user-42',
    timeoutMs: 30_000,
    maxRetries: 1,
    cache: { enabled: true, ttlMs: 60_000 },
  },
);
```

### 流式调用

```ts
for await (const event of runtime.llmStream({
  messages: [{ role: 'user', content: '分析这个锁等待图。' }],
})) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
}
```

### 异步批量

```ts
const job = runtime.submitLlmBatch(
  [
    { messages: [{ role: 'user', content: '总结查询 A' }] },
    { messages: [{ role: 'user', content: '总结查询 B' }] },
  ],
  { concurrency: 2 },
);

const current = runtime.getLlmJob(job.id);
runtime.cancelLlmJob(job.id);
```

通过 `llmModels()`、`discoverLlmModels()` 和 `llmMetrics()` 获取模型目录与调用指标。

## 10. 统一数据库 Runtime

`runtime.database` 是数据库、数仓和集群共用的 Connector 中立入口。当前安装包默认注册 PostgreSQL TCP Connector。

```ts
const now = new Date().toISOString();

runtime.database.createProfile({
  id: 'analytics-readonly',
  name: 'Analytics PostgreSQL',
  connectorId: 'postgres-native',
  engine: 'postgres',
  endpoints: [{
    transport: 'tcp',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME!,
  }],
  principal: process.env.DB_USER!,
  purpose: 'read-only',
  readOnly: true,
  createdAt: now,
  updatedAt: now,
});

await runtime.database.connect('analytics-readonly', {
  username: process.env.DB_USER!,
  password: process.env.DB_PASSWORD,
});

await runtime.database.discoverAll('analytics-readonly');

const job = await runtime.database.submit({
  profileId: 'analytics-readonly',
  sql: 'select current_database() as database_name',
  executionMode: 'sync',
  timeoutMs: 5_000,
  rowLimit: 100,
});

if (job.result) {
  const page = await runtime.database.readResult(job.result.id, {
    limit: 100,
  });
  console.table(page.rows);
}
```

同一个 Runtime 还提供能力解析、健康检查、查询取消、粘性事务与 Savepoint、状态观测、原子运维操作、审计事件、指标和资源快照。

## 11. 资源与状态

`runtime.resources` 与 `runtime.database.resources` 指向同一个 Registry。

```ts
const tables = runtime.resources.query({
  kinds: ['table'],
  engine: 'postgres',
  limit: 100,
});

for (const table of tables.items) {
  const state = runtime.resources.state(table.id);
  const relations = runtime.resources.relationsFor(table.id);
  console.log(table.canonicalName, state, relations);
}
```

Registry 支持资源、关系、观测、图遍历、派生事实、生命周期事件、快照、恢复和受控身份绑定。

## 12. 取消与错误

高层 Agent、生成和压缩调用都支持 `AbortSignal`。

```ts
const controller = new AbortController();
const pending = runtime.runAgent({
  message: '分析全部查询模式。',
  mode: 'read',
  signal: controller.signal,
});

controller.abort();
await pending;
```

高层 Runtime 错误使用 `DatabaseAgentError`：

```ts
import { DatabaseAgentError } from '@nwlworkshop/schemanaut';

try {
  await runtime.generate({ question: '' });
} catch (error) {
  if (error instanceof DatabaseAgentError) {
    console.error(error.code, error.retryable, error.message, error.detail);
  }
}
```

数据库 Runtime 错误使用 `DatabaseAccessRuntimeError`，Provider 错误使用 `LlmProviderError`。

## 13. Secret 与部署规则

- 从环境变量或自己的 Secret Manager 读取凭据。
- 禁止把凭据写入连接档案、资源、Session 消息、审计事件和日志。
- 当前本地服务必须保持回环地址监听，它不是已经加固的多租户网关。
- Agent 权限模式要与最小权限数据库账号配合使用。
- 会执行变更的应用应记录并检查 `toolExecutions`、数据库审计事件和指标。
- 进程退出前调用 `close()`，释放数据库和 SQLite 句柄。

## 14. 继续阅读

- [完整 SDK API 参考](api-reference.zh-CN.md)
- [REST API 概览](../../README.zh-CN.md#对外使用方式)
- [AI SQL 设计](../ai-sql/README.md)
- [数据库接入工程设计](../foundation/02-database-access.md)
- [公共类型与合同](../foundation/04-public-types-and-contracts.md)
