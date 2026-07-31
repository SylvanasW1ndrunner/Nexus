<div align="center">

# SchemaNaut

### 用自然语言提问，得到 SQL，把控制权留给你

**可嵌入、开源的 PostgreSQL AI SQL Agent。**

[![状态：Alpha](https://img.shields.io/badge/status-alpha-f59e0b)](CHANGELOG.md)
[![许可证：Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-3b82f6)](LICENSE)
[![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](packages/sdk/src/index.ts)

[English](README.md) · [CLI 指南](docs/cli/README.zh-CN.md) · [SDK 指南](docs/sdk/README.zh-CN.md) · [API 参考](docs/sdk/api-reference.zh-CN.md) · [参与贡献](CONTRIBUTING.md)

</div>

SchemaNaut 把一段自然语言需求变成数据库任务：检索相关 Schema 与业务知识、规划工作、生成 SQL、在必要时申请许可、交给数据库执行，并根据真实错误继续修正。

它为嵌入和自动化而设计。核心入口是 TypeScript SDK 与本地 REST API，同时提供交互式 CLI 和刻意保持轻量的 WebUI；它不是数据库 IDE。

> SchemaNaut `0.1.x` 仍处于 Alpha 阶段，PostgreSQL 是首个完整 Connector。在没有自行配置数据库权限、Secret 管理和审核流程前，请勿把它当作生产安全边界。

## v1 包含什么

| 能力              | 实际行为                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| 知识增强 AI SQL   | 分层 Schema 目录、Project/Skill 业务约定、混合检索，以及 Agent 成功执行 DDL 后自动刷新知识          |
| 自适应 Agent 循环 | 单一的计划式 ReAct 循环，持续探索、执行、观察、修正并验证完成；不存在让用户选择的“策略模式”         |
| 持久 Session      | SQLite 保存隔离对话、计划、产物、Token 用量、检查点和用户级长期偏好；支持自动与手动上下文压缩       |
| Project 上下文    | 选定项目根目录，使用 `.schemanaut/AGENT.md`、项目 Skills、MCP 配置、SQL 脚本与产物目录              |
| 明确权限          | `read`、`edit`、`full` 三级权限；超出当前模式的动作可通过回调申请单次许可                           |
| 渐进式 Skills     | 系统、用户、Project、Session 四级标准 Markdown `SKILL.md`；未激活前只把目录信息提供给模型           |
| 标准 MCP Client   | 基于官方 MCP SDK，支持 stdio、Streamable HTTP、SSE 兼容、动态工具发现、生命周期、取消和 Secret 引用 |
| Project Tools     | Project 范围文件、可选宿主网络工具、`full` 模式下的有界 Shell，以及上下文独立、能力相同的子 Agent   |
| 查询结果分离      | 聚合和筛选交给数据库；SDK/API 单独返回最多 1,000 行，模型临时投影最多 100 行且不超过 64 KiB       |
| 使用入口          | TypeScript SDK、本地 REST API、交互式 CLI 与轻量本地 WebUI                                          |

AI 数据库治理与运维属于后续产品阶段。v1 **不包含**治理运维 Agent，也不宣称能够自主完成 DBA 修复。

## 工作方式

```mermaid
flowchart LR
    User["应用 / CLI / REST"] --> Session["Session + Project"]
    Session --> Agent["计划式 ReAct Agent"]
    Agent --> Discover["Skills + 动态 Tool 发现"]
    Discover --> Knowledge["Schema 知识"]
    Discover --> Extensions["内置 Tools + MCP"]
    Agent --> Policy["read / edit / full"]
    Policy --> PostgreSQL["PostgreSQL 执行 SQL"]
    PostgreSQL --> Results["有界查询结果（最多 1,000 行）"]
    Results --> Preview["模型临时投影（最多 100 行 / 64 KiB）"]
    Preview --> Agent
    Results --> Output["独立结果载荷"]
    Agent --> Output["已验证回答 + SQL + 有用事件 + 产物"]
```

知识库内部 Hash、节点 ID、排序分数和评测轨迹不会进入常规模型输入或用户输出。

## 安装

环境要求：

- Node.js 22.13 或更高版本（持久化 Session 使用 `node:sqlite`；无需 `--experimental-sqlite` 启动参数，但 Node 22 仍将该模块标为实验性）
- PostgreSQL
- OpenAI-compatible 模型 Endpoint 或 Anthropic Messages Endpoint
- Agent 工作流需要模型支持 Tool Calling

公开 npm 包尚未发布。现在可以从仓库构建可安装包：

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

`pnpm test:npm-package:functional` 会在接受该归档前校验 `SHA256SUMS.txt`、
发行版本元数据、密钥扫描、隔离本地安装、SDK/REST/CLI 行为和 TypeScript 声明。

计划发布的包名是 `@nwlworkshop/schemanaut`。
下文统一使用 `npx schemanaut`，它会从当前项目的本地安装中解析 CLI。
只有明确需要全局命令时，才使用 `npm install --global ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz`。

## 最快体验：交互式 CLI

初始化项目：

```bash
npx schemanaut init ./my-data-project
```

设置模型和 PostgreSQL 连接后开始对话：

```powershell
$env:SCHEMANAUT_LLM_BASE_URL = "https://your-openai-compatible-endpoint/v1"
$env:SCHEMANAUT_LLM_API_KEY = "..."
$env:SCHEMANAUT_LLM_MODEL = "your-model"
$env:SCHEMANAUT_DATABASE_URL = "postgresql://user:password@127.0.0.1:5432/app"

npx schemanaut chat -C ./my-data-project
```

使用本地 Ollama 时可填写 `http://127.0.0.1:11434/v1`，API Key 可以省略。

常用交互命令：

```text
/mode read|edit|full
/new
/resume <session-id>
/sessions
/skills
/<skill> [任务]
/compact [关注点]
/trace on|off
/mcp list
/mcp start <server-id>
/mcp stop <server-id>
/exit
```

Agent 运行时继续输入普通文字，会作为新要求加入当前任务。`Ctrl+C` 只取消本次运行，Session 仍会保留。

## 嵌入 SDK

```ts
import { DatabaseAgentRuntime, createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('必须设置 LLM_API_KEY');

const runtime = new DatabaseAgentRuntime({
  tenantId: 'team-a',
  projectDirectory: process.cwd(),
  provider: createProviderFromPreset('siliconflow', {
    apiKey,
  }),
  model: process.env.LLM_MODEL!,
  approvalProvider: async ({ mode, tool, toolCall }) => {
    console.log(`请求许可：${mode} -> ${tool.name}`, toolCall.arguments);
    return false;
  },
});

try {
  await runtime.connect({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME!,
    username: process.env.DB_USER!,
    password: process.env.DB_PASSWORD,
    readOnly: true,
  });

  await runtime.indexSchema();

  const run = await runtime.runAgent({
    userId: 'user-1',
    message: '查询最近 7 天每天的已支付订单金额。',
    mode: 'read',
    onEvent: (event) => {
      console.log(event.type, event.message);
    },
  });

  console.log(run.result.finalText);
  console.table(run.queryResults[0]?.rows ?? []);
  console.log(run.result.session.id);

  const continued = await runtime.runAgent({
    sessionId: run.result.session.id,
    message: '再和之前 7 天做对比。',
    mode: 'read',
  });

  console.log(continued.result.finalText);
} finally {
  await runtime.close();
}
```

如果需要在进程重启后继续对话，请保存 `run.result.session.id`。

`runAgent()` 是可信 SDK 集成入口，会返回包含 Tool 执行记录在内的完整 Run。面向应用展示 Session 时使用 `listAgentSessions()` 和 `getAgentSession()`；其结果不会包含 Tool 消息、内部检索标识、Skill 指令和评测细节。

查询行通过 `run.queryResults` 单独返回，不写入对话、Session 历史或用户偏好。Project、Skills、MCP、有界查询结果、取消、模型直调与底层数据库 Runtime 见 [SDK 指南](docs/sdk/README.zh-CN.md)。

## 三级权限

| 模式   | 无需许可即可运行                                 | 需要申请单次许可                          |
| ------ | ------------------------------------------------ | ----------------------------------------- |
| `read` | 查看 Schema、执行只读 SQL                        | 数据修改、DDL、破坏性或管理动作           |
| `edit` | 包含 `read`，并允许行数据修改和 Project 文件编辑 | DDL、破坏性 Schema 变更、Shell 和管理动作 |
| `full` | 读取、编辑、DDL、破坏性、Shell 和管理工具        | 不会仅因为权限模式而申请许可              |

一次批准只对当前 Tool Call 生效。拒绝会成为 Agent 的观察结果，Agent 可以改走更安全的路径，或如实说明无法完成的部分。

未提供 `approvalProvider` 时，Runtime 会使用内置许可 Broker。UI 或 API 宿主可以在 Agent 等待期间通过 `listAgentApprovals()` 和 `resolveAgentApproval()` 处理请求，默认最长等待五分钟；自定义回调会替代这条 Broker 管理链路。

三级模式是应用层策略，不能代替 PostgreSQL 自身权限。务必使用与场景匹配的最小权限数据库账号。

## Project、Skills 与 MCP

`schemanaut init` 会创建：

```text
my-data-project/
├── .schemanaut/
│   ├── AGENT.md
│   ├── settings.json
│   ├── mcp.json
│   └── skills/
├── sql/
└── artifacts/
```

- 将长期有效的项目约定写入 `.schemanaut/AGENT.md`，不要写入凭据。
- 将项目 Skill 放在 `.schemanaut/skills/<name>/SKILL.md`。
- 在 `.schemanaut/mcp.json` 中配置 MCP Server；敏感环境变量和 Header 必须使用 Secret 引用，并由宿主应用解析。
- Session 是持久对话状态，Project 是可复用目录上下文；两者相关，但不是同一个概念。

## 本地 REST API 与 WebUI

启动只监听本机的服务：

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

打开 <http://127.0.0.1:3721>。AI SQL 主链路是：

1. `POST /v1/setup`
2. `POST /v1/schema/index`
3. 使用 `POST /v1/agent/run` 获取一次性 JSON，或使用 `POST /v1/agent/run/stream` 接收语义化 SSE 事件

两个 Agent 接口最终都返回面向用户、已去除内部细节的 `AiSqlAgentRunView`，而不是 SDK 的完整集成记录。数据库行位于独立、临时的 `queryResults` 载荷中，不会嵌入 Session 消息。公开管理接口覆盖 Session 列表/读取/删除/追加要求、Skill 列表/刷新、待处理许可，以及 MCP 配置和生命周期。API 还提供“生成/执行/重新执行”、Session 压缩、上下文检查点、模型调用、数据库 Query Job、结果、资源和指标。详见 [API 参考](docs/sdk/api-reference.zh-CN.md)。

## 开发

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:ai-sql
pnpm test:ai-sql:performance
pnpm test:postgres
pnpm test:npm-package:functional
```

真实模型测试需要显式开启，并可能消耗付费 Token：

```bash
pnpm test:functional:live
pnpm test:performance:live
```

凭据只能存放在已忽略的环境文件或外部 Secret Store 中，禁止提交到仓库。

三类复杂 PostgreSQL 场景、性能阈值、报告位置和完整发布验收顺序见[测试链路](docs/test-pipeline.md)。

## 当前边界

- v1 只有 PostgreSQL 是完整数据库 Connector。
- Project 约定和 Skills 是 v1 公开的业务规则入口；资源绑定业务知识的稳定 CRUD API 尚未开放。
- CLI 接收 OpenAI-compatible Endpoint；SDK 与 REST Setup API 也支持 Anthropic Messages 原生协议。
- WebUI 是轻量本地配置和试用界面，不是 IDE。
- Agent 交互结果最多返回 1,000 行，只存在于当前响应与进程内缓存；恢复 Session 不恢复数据库行，需要时重新执行 SQL 或使用显式数据库导出。
- 默认 Runtime 支持 MCP Secret 引用，但不配置 MCP OAuth，也不提供凭据保险库。
- 只有宿主显式设置 `enableShellTool: true` 时才会注册 `shell_run`。它需要 `full` 模式，使用 Project 范围内的工作目录和精简环境变量，但仍继承宿主进程的操作系统权限，并不是操作系统沙箱。
- MCP Server 默认只加载配置，不自动启动。应显式启动已审核的 Server；只有可信宿主才应开启 `autoStartMcp`。
- Agent 效果仍取决于所选模型的推理与 Tool Calling 能力。
- AI 治理与运维仍是路线图内容，不属于 v1。

## 文档

- [SDK 指南](docs/sdk/README.zh-CN.md)
- [SDK API 参考](docs/sdk/api-reference.zh-CN.md)
- [CLI 指南](docs/cli/README.zh-CN.md)
- [产品总体功能设计](docs/product-functional-overview.md)
- [Agent 与扩展运行时](docs/agent/README.md)
- [测试链路](docs/test-pipeline.md)
- [AI SQL 工程文档](docs/ai-sql/README.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)

## 许可证

SchemaNaut 使用 [Apache License 2.0](LICENSE)。
