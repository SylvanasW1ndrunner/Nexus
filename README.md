# DBAgent

DBAgent 是一个面向中国开发者和企业环境的 AI 数据库运行时，核心能力是自然语言转 SQL，以及安全边界内的数据库管理与运维诊断。

产品以 TypeScript SDK 和 REST API 为核心。CLI 用来启动和诊断服务，WebUI 用来配置、试用和查看运行状态。

## 当前版本

可以直接使用：

- 连接 PostgreSQL 只读账号。
- 使用统一连接档案接入 TCP、JDBC、HTTP/云 SDK 和自定义 Connector。
- 维护可追溯的数据库、数仓和集群资源关系图。
- 动态描述 `supported / conditional / unsupported / unknown` 四态能力。
- 通过同步或异步 Query Job 执行、轮询、取消和分批读取结果。
- 使用粘性事务、Savepoint、提交、回滚及失败事务恢复。
- 采集会话、活动查询、锁、容量和复制状态，并执行经过授权的原子运维动作。
- 提取并索引 Schema。
- 通过统一 Gateway 调用 OpenAI-compatible、国内云、本地私有模型和 Anthropic 原生协议。
- 支持同步、流式、异步批量、Tool Calling、结构化输出、Embedding 和 Rerank 合同。
- 接入时通过 Provider 模型目录与元数据构建能力档案，不发送验证 Prompt。
- 提供策略路由、预算、缓存、重试、限流、熔断和调用指标。
- 调用模型生成 SQL。
- 返回 SQL、解释、假设、Schema 证据和安全报告。
- 用户显式确认后执行单条只读 SQL。
- 通过仓库内 SDK、REST API、CLI 和轻量 WebUI 访问。

核心包已经包含 MCP stdio 接入、Skill 导入与匹配、Agent 权限审批、审计评测，以及健康、慢查询、锁和长事务诊断；这些能力还没有接入主 SDK/API。

当前版本不是生产就绪版本。配置和 Secret 仍主要保存在进程内存。

## 本地运行

要求 Node.js 20.11+、pnpm 9+、PostgreSQL 只读账号和一个 OpenAI-compatible 模型。

```bash
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:3721>。更换端口：

```bash
node apps/server/dist/cli.js --port 3722
```

## 测试

本地功能回归与平台性能：

```bash
pnpm test
pnpm test:llm-platform:performance
pnpm test:database-platform:contracts
pnpm test:database-platform:performance
pnpm test:public-contracts
pnpm test:public-contracts:performance
pnpm test:resource-state
pnpm test:resource-state:performance
pnpm test:npm-package:functional
```

真实 PostgreSQL 功能验收：

```bash
pnpm test:postgres
```

需要真实 PostgreSQL 和硅基流动 API 的联合验收：

```bash
pnpm test:functional:live
pnpm test:performance:live
```

真实测试显式读取 `.env` 中的 `TEST_SILICONFLOW_API_KEY` 和 `TEST_SILICONFLOW_MODEL`，会产生模型费用；功能测试只重建专用的 `dbagent_core_db_test` 数据库。产品 SDK、API 和 WebUI 不提供主动模型验证入口。

## npm 试用包

作为 Node.js SDK 安装：

```bash
npm install @nwlworkshop/dbagent
```

生成本地安装包：

```bash
pnpm package:npm
```

运行生成的包：

```bash
npx --yes --package ./release/DBAgent-v0.1.0/dbagent-v0.1.0.tgz dbagent
```

发布到 npm 后可直接运行：

```bash
npx --yes @nwlworkshop/dbagent
```

## REST API

当前接口：

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 服务健康检查 |
| `GET /v1/capabilities` | 能力与安全限制 |
| `GET /v1/llm/provider-presets` | 获取模型 Provider 预设 |
| `POST /v1/llm/setup` | 配置模型并读取模型目录与元数据 |
| `GET /v1/llm/models` | 查看模型档案 |
| `GET /v1/llm/metrics` | 查看 Token、成本和延迟指标 |
| `POST /v1/llm/chat` | 同步模型调用 |
| `POST /v1/llm/chat/stream` | SSE 流式模型调用 |
| `POST /v1/llm/jobs` | 提交异步批量模型任务 |
| `GET/DELETE /v1/llm/jobs/:id` | 查询或取消模型任务 |
| `GET /v1/database/connectors` | 查看已注册 Connector 和能力 |
| `GET/POST /v1/database/profiles` | 查询或创建连接档案 |
| `GET/PATCH/DELETE /v1/database/profiles/:id` | 管理单个连接档案 |
| `POST /v1/database/profiles/:id/test\|connect\|reconnect\|disconnect\|discover` | 连接生命周期与资源发现 |
| `GET /v1/resources` | 按类型、引擎、范围和游标查询统一资源 |
| `GET /v1/resources/:id` | 查询单个资源 |
| `GET /v1/resources/:id/relations\|state\|observations` | 查询关系、派生状态和观测历史 |
| `POST /v1/resources/traverse` | 执行有深度和数量上限的关系图遍历 |
| `GET /v1/resource-events` | 分页查询资源变化事件 |
| `GET /v1/database/resources` | 兼容接口：查询数据库发现资源 |
| `POST /v1/database/queries` | 提交同步或异步 Query Job |
| `GET/DELETE /v1/database/queries/:id` | 查询或取消 Query Job |
| `GET /v1/database/results/:id` | 分页读取结果 |
| `POST /v1/database/transactions` | 创建粘性事务 |
| `POST /v1/database/observations` | 采集确定性运行状态 |
| `POST /v1/database/operations` | 执行经过授权的原子运维动作 |
| `GET /v1/database/audit\|metrics` | 查看审计和平台指标 |
| `POST /v1/database/connect` | 连接 PostgreSQL |
| `POST /v1/setup` | 兼容接口：配置模型并连接 PostgreSQL |
| `POST /v1/schema/index` | 索引 Schema |
| `POST /v1/query/generate` | 自然语言生成 SQL |
| `POST /v1/query/execute` | 显式执行生成结果 |
| `GET /v1/runs/:runId` | 查询运行记录 |

配置示例：

```bash
curl -X POST http://127.0.0.1:3721/v1/setup \
  -H "content-type: application/json" \
  -d '{
    "llm": {
      "baseUrl": "https://your-endpoint/v1",
      "apiKey": "YOUR_KEY",
      "model": "YOUR_MODEL"
    },
    "database": {
      "host": "127.0.0.1",
      "port": 5432,
      "database": "app",
      "username": "dbagent_readonly",
      "password": "YOUR_PASSWORD"
    }
  }'
```

## TypeScript SDK

仓库内 SDK：

```ts
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { DatabaseAgentRuntime } from '@dbagent/sdk';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'team-a',
  provider: new OpenAICompatibleProvider({
    id: 'primary',
    name: 'Primary model',
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
  }),
  model: process.env.LLM_MODEL!,
});

const modelReply = await runtime.llmChat(
  { messages: [{ role: 'user', content: '解释慢 SQL 的主要风险' }] },
  { taskType: 'database-diagnosis', timeoutMs: 30_000, maxRetries: 1 },
);

await runtime.connect({
  host: '127.0.0.1',
  database: 'app',
  username: 'dbagent_readonly',
  password: process.env.DB_PASSWORD,
});

await runtime.indexSchema();
const run = await runtime.generate({ question: '最近 7 天每天的已支付订单金额' });
if (run.status === 'awaiting_execution') {
  const result = await runtime.executeGenerated(run.runId);
  console.log(result.execution.rows);
}
```

统一数据库入口：

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/dbagent';

const runtime = new DatabaseAgentRuntime();
runtime.database.createProfile({
  id: 'production-readonly',
  name: 'Production PostgreSQL',
  connectorId: 'postgres-native',
  engine: 'postgres',
  endpoints: [{
    transport: 'tcp',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
  }],
  principal: 'dbagent_readonly',
  purpose: 'read-only',
  readOnly: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

await runtime.database.connect('production-readonly', {
  username: 'dbagent_readonly',
  password: process.env.DB_PASSWORD,
});
await runtime.database.discoverAll('production-readonly');

const job = await runtime.database.submit({
  profileId: 'production-readonly',
  sql: 'select current_database() as database_name',
  timeoutMs: 5_000,
});
if (job.result) {
  console.log((await runtime.database.readResult(job.result.id)).rows);
}

const tables = runtime.resources.query({
  kinds: ['table'],
  engine: 'postgres',
  limit: 100,
});
if (tables.items[0]) {
  console.log(runtime.resources.state(tables.items[0].id));
}

await runtime.close();
```

## 安全默认值

- 旧版 AI SQL 快捷入口强制只读；统一数据库入口按连接用途、能力、SQL 安全和授权上下文共同约束。
- 生成和执行分离。
- SQL 必须通过单语句、语句类型和风险检查。
- 查询结果有行数限制。
- Secret 不进入连接档案、资源、错误详情、审计和 API 响应。
- 写入、DDL 和运维动作需要相应能力、显式确认或批准上下文。
- MCP 工具经过命名空间、风险推断、权限和审批。
- Skill 只能调用声明且已注册的工具。

## 文档

- [总体功能设计](docs/product-functional-overview.md)
- [大模型能力工程文档](docs/foundation/01-llm-platform.md)
- [数据库接入与能力描述工程文档](docs/foundation/02-database-access.md)
- [统一资源与状态模型工程文档](docs/foundation/03-unified-resource-state.md)
- [公共类型与合同工程文档](docs/foundation/04-public-types-and-contracts.md)
