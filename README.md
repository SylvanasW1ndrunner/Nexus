# DBAgent

DBAgent 是一个面向中国开发者和企业环境的 AI 数据库运行时，核心能力是自然语言转 SQL，以及安全边界内的数据库管理与运维诊断。

产品以 TypeScript SDK 和 REST API 为核心。CLI 用来启动和诊断服务，WebUI 用来配置、试用和查看运行状态。

## 当前版本

可以直接使用：

- 连接 PostgreSQL 只读账号。
- 提取并索引 Schema。
- 调用 OpenAI-compatible 模型生成 SQL。
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

## npm 试用包

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
| `POST /v1/setup` | 配置模型并连接 PostgreSQL |
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
  provider: new OpenAICompatibleProvider({
    id: 'primary',
    name: 'Primary model',
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
  }),
  model: process.env.LLM_MODEL!,
});

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

公开 npm 包导出完整 SDK 属于下一里程碑。

## 安全默认值

- 数据库连接强制只读。
- 生成和执行分离。
- SQL 必须通过单语句、语句类型和风险检查。
- 查询结果有行数限制。
- MCP 工具经过命名空间、风险推断、权限和审批。
- Skill 只能调用声明且已注册的工具。

## 文档

- [总体功能设计](docs/product-functional-overview.md)
