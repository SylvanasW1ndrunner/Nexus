# SchemaNaut SDK 使用指南

[English](README.md) · [API 参考](api-reference.zh-CN.md) · [项目首页](../../README.zh-CN.md)

本文说明如何通过 TypeScript SDK、本地 REST API 与 CLI 使用 SchemaNaut v1。所有示例均以当前源码 API 为准。

SchemaNaut v1 是 AI SQL Agent，不是数据库 IDE，也不是 AI 治理运维 Agent。

## 1. 环境与安装

- Node.js 22.13 或更高版本（持久化 Session 使用 `node:sqlite`；无需 `--experimental-sqlite` 启动参数，但 Node 22 仍将该模块标为实验性）
- ESM 应用，或能够使用 ESM 的构建工具
- PostgreSQL
- OpenAI-compatible Endpoint 或 Anthropic Messages Endpoint
- 使用 `runAgent()` 时，模型需要支持 Tool Calling

公开 npm 包尚未发布。现在可以在仓库中构建并安装：

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

计划发布的包名是 `@nwlworkshop/schemanaut`。
CLI 示例统一使用 `npx schemanaut`，从当前项目的本地安装中解析命令。

## 2. Runtime、Project 与 Session

三个概念的生命周期不同：

- `DatabaseAgentRuntime` 管理模型 Provider、当前数据库连接、知识索引、Tools、Skills、MCP Client、有界交互结果和 Session 入口。
- Project 是选定的目录，保存可复用的项目约定和扩展，通过 `projectDirectory` 指定。
- Session 是一段隔离、持久的对话；消息、任务计划、产物、已激活 Tools 与 Skills、Token 用量和上下文检查点保存在一起。

默认 Session 状态位于 `defaultAgentStateDatabasePath()` 返回的操作系统用户数据目录，而不是 Project 内部：

- Windows：`%LOCALAPPDATA%\SchemaNaut\schemanaut.db`
- Linux/macOS 回退路径：`~/.local/share/SchemaNaut/schemanaut.db`

应用需要独立状态库时，请设置 `sessionDatabasePath`。
多个 Project 可以安全共用同一个状态库。Runtime 会把 Session Store 绑定到规范化后的 `projectDirectory`；列表、读取、更新、归档、删除、分叉、导出、压缩、检查点、Skill 查询、恢复以及 REST/CLI Session 操作都会在 SQLite 查询层按 Project 过滤。其他 Project 访问时得到与 Session 不存在相同的结果。

一次性初始化 Project：

```ts
import { initializeAgentProject } from '@nwlworkshop/schemanaut';

const project = await initializeAgentProject('/srv/acme-data');
console.log(project.configDirectory);
```

目录结构：

```text
acme-data/
├── .schemanaut/
│   ├── AGENT.md
│   ├── settings.json
│   ├── mcp.json
│   └── skills/
├── sql/
└── artifacts/
```

`.schemanaut/AGENT.md` 用于长期有效的项目约定，禁止写入凭据。Session 会绑定 Project，不能通过另一个 Project 的 Runtime 恢复。

## 3. 创建与关闭 Runtime

```ts
import { DatabaseAgentRuntime, createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('必须设置 LLM_API_KEY');

const runtime = new DatabaseAgentRuntime({
  tenantId: 'acme',
  projectDirectory: '/srv/acme-data',
  sessionDatabasePath: '/srv/acme-state/schemanaut.db',
  provider: createProviderFromPreset('siliconflow', {
    apiKey,
  }),
  model: process.env.LLM_MODEL!,
});

try {
  // 在这里连接数据库、构建索引并运行任务。
} finally {
  await runtime.close();
}
```

应用退出时调用 `close()`。它会取消 Broker 中待处理的许可、停止运行中的 MCP Server、断开 PostgreSQL 快捷连接并关闭统一数据库 Runtime。

## 4. 配置模型 Provider

### 预设

内置 OpenAI-compatible 预设包括 `siliconflow`、`deepseek`、`zhipu`、`moonshot`、`ollama` 和 `vllm`：

```ts
import { createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('必须设置 LLM_API_KEY');

const cloud = createProviderFromPreset('deepseek', {
  apiKey,
});

const local = createProviderFromPreset('ollama', {
  baseUrl: 'http://127.0.0.1:11434/v1',
});
```

预设能力是元数据，不是通过消息进行的实时能力测试。`runtime.discoverLlmModels()` 只查询 Provider 的模型列表或元数据接口，不发送能力探测 Prompt。

### OpenAI-compatible Gateway 与中转站

大多数中转站与官方 OpenAI-compatible 服务的差异只有 Endpoint、模型名和认证方式，可直接自定义：

```ts
import { OpenAICompatibleProvider } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('必须设置 LLM_API_KEY');

const provider = new OpenAICompatibleProvider({
  id: 'company-gateway',
  name: 'Company gateway',
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey,
  timeoutMs: 60_000,
  maxRetries: 1,
});
```

只有可信且确实不需要密钥的 Endpoint 才应设置 `allowUnauthenticated: true`。

### Anthropic Messages

```ts
import { AnthropicProvider } from '@nwlworkshop/schemanaut';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

也可以在 Runtime 创建后配置 Provider 与模型：

```ts
runtime.configureProvider(provider, 'model-id');
const models = await runtime.discoverLlmModels();
const status = runtime.status();
```

## 5. 连接 PostgreSQL 并构建 Schema 索引

```ts
const connectionInput = {
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

const test = await runtime.testConnection(connectionInput);
console.log(test.latencyMs, test.readOnly);

const connection = await runtime.connect(connectionInput);
const schema = await runtime.indexSchema({ maxTables: 500 });
console.log(connection.id, schema.tableCount, schema.columnCount);
```

`connect()` 会替换上一个快捷连接。`indexSchema()` 每次接受 1–1,000 个关系对象，默认值为 200。可在 Runtime 参数中设置 `schemaSnapshotDirectory` 持久化成功索引；相对路径基于选定 Project 根目录解析。

快照文件属于应用数据，并不是加密 Secret Store。目录中会以明文保存 Schema 名称、注释、业务 Glossary 文本及派生向量。嵌入 SchemaNaut 的宿主必须限制目录访问权限，并自行制定备份、保留与安全删除策略。

知识层采用数据库 → Schema → 关系 → 列的层级结构，支持精确/全文检索、关系扩展，以及可选的 Embedding 与 Reranker。Embedding 模型应同时覆盖用户语言和数据库标识符；SchemaNaut 不强制使用中文专用模型。

通过内置 Agent SQL Tool 成功执行 DDL 后，当前索引会自动刷新。默认统一 PostgreSQL 路径还会在 SQL 生成和 Agent 运行前比较稳定的 Schema 修订值，因此外部 DDL 会自动触发刷新。使用自定义兼容 `driver` 的宿主仍需在外部 Schema 变化后调用 `indexSchema()`。

## 6. 运行计划式 AI SQL Agent

```ts
const run = await runtime.runAgent({
  userId: 'user-42',
  message: '从 Kafka 事件 JSON 中提取渠道，统计本周每天的支付金额。',
  mode: 'read',
  maxIterations: 12,
  maxToolExecutionMs: 30_000,
  onEvent: async (event) => {
    console.log(event.type, event.message);
    if (event.sql) console.log(event.sql);
  },
});

console.log(run.activatedSkills);
console.log(run.result.status);
console.log(run.result.finalText);
console.log(run.result.session.id);
console.log(run.result.completion);
```

SDK 是可信集成入口：`runAgent()` 返回完整 `AiSqlAgentRun`，其中包括 Tool 执行记录，以及存在时的上下文压缩报告。面向用户展示时应使用下文的 Session 公开管理方法；本地 REST API 始终返回已去除内部细节的投影视图。

`runAgent()` 使用单一的自适应计划式 ReAct 循环：

1. 理解目标；
2. 在有价值时创建或更新任务计划；
3. 只发现并激活当前需要的 Skills 与 Tools；
4. 检索 Schema 或查看小型数据样例；
5. 生成并执行 SQL；
6. 观察数据库错误或结果并更换路径；
7. 根据任务证据验证完成情况后再输出。

Agent 不提供让用户选择的策略。`activatedSkills` 是返回 Session 中实际激活的 Skill 名称。

`onEvent` 只接收面向用户的语义事件：

```text
goal-understood
plan-updated
exploring
sql-prepared
approval-required
sql-executed
correcting
artifact-created
completed
needs-user-input
```

内部推理、知识 Hash、节点 ID、排序分数和评测轨迹不会投影到这个事件流。

## 7. 内置 Project Tools 与子 Agent

除数据库和知识工具外，Runtime 还注册通用工具：

- `workspace_list`、`workspace_read`、`workspace_search` 读取 Project 文件；
- `workspace_write`、`workspace_edit` 创建或修改 Project 文件，并登记产物；
- 只有宿主设置 `enableShellTool: true` 时，`shell_run` 才会运行有界命令；
- 只有宿主提供 `webAdapter` 时才注册 `web_search` 和 `web_fetch`；
- `subagent_spawn`、`subagent_list`、`subagent_wait`、`subagent_stop` 管理有界子任务。

专用文件工具会拒绝绝对路径、Project 外路径和符号链接逃逸。`shell_run` 默认不注册；启用后，其工作目录必须位于 Project 内，子进程只接收精简的常规系统环境变量，但仍继承 SchemaNaut 宿主进程的操作系统权限，并不是操作系统沙箱。

宿主 Web Adapter 同时是网络策略边界，必须由它落实目标地址白名单、认证、限流和 SSRF 防护。

子 Agent 拥有相同的通用 Runtime 能力和 Project 引用，但使用独立对话上下文，只处理被委派的目标。主 Agent 接收状态、摘要和产物引用，而不是子 Agent 的完整上下文。

## 8. 权限与许可

`runAgent()` 接受 `read`、`edit` 或 `full`：

| 模式   | 自动拥有的能力                                                    |
| ------ | ----------------------------------------------------------------- |
| `read` | 查看 Schema、执行只读 SQL                                         |
| `edit` | 包含 `read`，并允许行数据修改、Project 文件修改和其他非破坏性编辑 |
| `full` | 包含 `edit`，并允许 DDL、破坏性动作、Shell 和管理动作             |

Tool 需要更高权限时会调用 `approvalProvider`：

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model,
  approvalProvider: async ({ mode, tool, toolCall, sessionId }) => {
    const approved = await showApprovalDialog({
      mode,
      sessionId,
      toolName: tool.name,
      arguments: toolCall.arguments,
    });

    return approved
      ? {
          approved: true,
          requestId: crypto.randomUUID(),
          approvedBy: 'operator-7',
          approvedAt: new Date().toISOString(),
        }
      : false;
  },
});
```

批准只对当前 Tool Call 生效。拒绝会作为观察结果返回 Agent，Agent 可以重新规划，或说明还需要什么权限。

未提供 `approvalProvider` 时，Runtime 会安装内置许可 Broker。这是 WebUI 或 REST 宿主最直接的接入方式：

```ts
const pending = runtime.listAgentApprovals();

if (pending[0]) {
  const resolved = runtime.resolveAgentApproval(pending[0].id, true, {
    resolvedBy: 'operator-7',
    reason: '已在管理界面审核。',
  });
  console.log(resolved);
}
```

`listAgentApprovals()` 只返回待处理请求。Broker 默认最多等待五分钟；参数预览会脱敏，并限制在 2,000 字符以内。自定义 `approvalProvider` 会替代 Broker，因此这些管理方法不会再返回由 Broker 持有的请求。

应用层模式不能覆盖数据库授权。请使用最小权限 PostgreSQL 账号；连接设置 `readOnly: true` 后，即使 Agent 模式为 `edit` 或 `full` 也不能写入。

## 9. 继续、追加要求与压缩 Session

通过 ID 恢复 Session：

```ts
const continued = await runtime.runAgent({
  sessionId: run.result.session.id,
  message: '按渠道拆分，并和上周做对比。',
  mode: 'read',
});
```

`session` 与 `sessionId` 只能提供一个。不同 Session 的对话、计划和产物相互隔离。查询行根本不属于 Session 状态：它们只在当前运行中单独返回，进程重启后即不存在。Session ID 同样受 Project 边界约束，即使可信宿主使用底层 `runtime.sessions`，也不能读取或修改其他 Project 的 Session。提供 `userId` 后，用户明确表达的偏好可以被提炼并供同一用户的其他 Session 使用；Tool 输出和数据库样例永远不是偏好来源。可通过 `runtime.sessions.listPreferences()`、`upsertPreference()` 和 `deletePreference()` 管理。

任务仍在运行时，可追加新的用户要求，而不是启动第二个 Run。即使是新建 Session，事件也会提供 Session ID：

```ts
let steered = false;

const running = runtime.runAgent({
  message: '分析每周支付收入并解释异常变化。',
  mode: 'read',
  onEvent: (event) => {
    if (!steered && event.type === 'exploring') {
      steered = runtime.steerAgentSession(event.sessionId, '排除内部测试租户。');
    }
  },
});

const steeredRun = await running;
```

如果该 Session 当前没有正在运行的任务，`steerAgentSession()` 返回 `false`。

应用界面和 API 应使用公开管理门面：

```ts
const sessions = await runtime.listAgentSessions({
  userId: 'user-42',
  query: '收入',
  archived: false,
  limit: 20,
  offset: 0,
});

const view = await runtime.getAgentSession(run.result.session.id);
const deleted = await runtime.deleteAgentSession('obsolete-session-id');
```

Session 列表项公开的 `conversationMessageCount` 只统计用户/助手消息。`getAgentSession()` 返回 `AgentSessionView`：包含用户/助手消息、公开的计划证据、产物、已激活 Skill 目录项、Token 用量和基本 Project 信息；不会包含 Tool 消息与调用、知识 Hash 与树节点 ID、Skill 正文指令及其他仅供集成使用的状态。`runtime.sessions.load()` 仍是可信宿主读取完整 Session 的底层 API。

SchemaNaut 始终保留原始 Session 记录。当模型上下文接近上限时，它可以遮蔽旧 Tool 输出，并为模型工作上下文创建语义检查点。也可以手动触发：

```ts
const compacted = await runtime.compactAgentSession({
  sessionId: run.result.session.id,
  focus: '保留精确 SQL、确认过的口径、决定和未完成事项。',
});

const checkpoints = await runtime.agentContextCheckpoints(run.result.session.id, 20);
```

常用 Session Store 方法：

```ts
const recent = await runtime.sessions.list({
  userId: 'user-42',
  archived: false,
  query: '收入',
  limit: 20,
});
const session = await runtime.sessions.load(run.result.session.id);
const markdown = await runtime.sessions.export(run.result.session.id, 'markdown');
const fork = await runtime.sessions.fork({
  id: run.result.session.id,
  fromMessageIndex: run.result.session.messages.length - 1,
  title: '另一种口径',
});
```

Session 持久化会脱敏可识别的 Secret，但仍禁止把凭据主动写进消息。

## 10. 独立、有界的查询结果

聚合、筛选、连接、窗口计算和异常检测应留在 PostgreSQL 中。`runAgent()` 将数据库数据放在 Agent 结果旁边单独返回：

```ts
for (const result of run.queryResults) {
  console.log(result.columns);
  console.table(result.rows); // 最多 1,000 行
  console.log({ returned: result.returnedRowCount, hasMore: result.hasMore });
}
```

SDK/API/CLI 每次执行最多得到 1,000 行。Agent 只会在本次模型调用的临时观察中看到最多两行。两者都不会写入对话消息、持久 Session、Agent Run 历史或用户偏好。`hasMore: true` 表示数据库产生的行数超过交互上限。

进程内缓存也只保存这份有界交互载荷，并会自动过期，因此恢复 Session 不会恢复历史查询行。需要再次查看时重新执行 SQL。需要完整导出时，使用底层数据库 Query/导出链路，或让 Agent 创建导出产物；数据库结果应直接流向目标文件，不能绕经对话。

## 11. Skills

SchemaNaut 使用标准 Markdown Skill Bundle：

```text
.schemanaut/skills/order-revenue/
└── SKILL.md
```

```markdown
---
name: order-revenue
description: 按项目确认的业务口径计算已支付订单收入。
license: Apache-2.0
metadata:
  owner: data-team
---

# 订单收入

使用 paid_at 作为支付时间，排除测试租户，所有聚合交给 PostgreSQL。
```

父目录与 Frontmatter 中的 `name` 必须一致，只能使用小写字母、数字和单个连字符。

Skill 覆盖优先级：

```text
session > project > user > system
```

来源：

- system：SchemaNaut 内置；
- user：默认位于 `~/.schemanaut/skills/<name>/SKILL.md`；
- project：`<project>/.schemanaut/skills/<name>/SKILL.md`；
- Session：内存 Overlay，随单个 Session 写入其 SQLite 记录。

Runtime 构造参数 `sessionSkills` 是复制给每个新 Session 的默认模板；`runAgent({ sessionSkills })` 可以只为一个新 Session 覆盖该模板。恢复 Session 始终使用自身已持久化的 Overlay；同时传入 `session`/`sessionId` 与 `sessionSkills` 会被拒绝，不会静默替换。

初始模型目录只包含 `name`、`description` 和 `scope`。只有 Agent 激活 Skill 后才加载 Markdown 正文。可通过 `/order-revenue 任务内容` 或 `/project:order-revenue 任务内容` 显式调用。

```ts
const runtime = new DatabaseAgentRuntime({
  // 只作为新 Session 的默认模板。
  sessionSkills: [
    {
      content: `---
name: temporary-rule
description: 在当前 Session 应用临时报表规则。
---

这个任务统一使用 UTC 时间边界。`,
    },
  ],
});

const run = await runtime.runAgent({
  message: '/temporary-rule 生成报表',
  sessionSkills: [
    {
      content: `---
name: temporary-rule
description: 只在这个新 Session 使用另一条临时规则。
---

使用租户本地自然日。`,
    },
  ],
});
const sharedSkills = await runtime.listAgentSkills();
const effectiveSessionSkills = await runtime.listAgentSkills({
  sessionId: run.result.session.id,
});
const refreshed = await runtime.refreshSkills();
console.table(sharedSkills);
console.table(effectiveSessionSkills);
console.log(refreshed.changed, refreshed.revision);
```

`listAgentSkills()` 只返回 System/User/Project 公共目录，因此不会泄露任一 Session Overlay。显式传入同 Project 的 `sessionId`，才返回该 Session 的模型安全有效目录。`refreshSkills()` 只刷新公共目录；Session Overlay 保持为不可变 Session 快照。`runtime.skills` 是公共 Registry，提供 `list()`、`get()`、`inspect()`、`load()`、`search()`、`invoke()`、`issues()` 和 `conflicts()`，供可信宿主诊断。

v1 仅通过 Runtime 构造参数或新建 Session 的 `runAgent()` 调用导入 Session Overlay。REST 与 CLI 管理界面可以列出和刷新 Skills，但不提供 Session Overlay 导入或替换入口。

## 12. MCP

SchemaNaut MCP Client 基于官方 Model Context Protocol SDK，支持：

- stdio；
- Streamable HTTP；
- 旧版 SSE 兼容；
- Tools、Resources、Resource Templates 与 Prompts；
- 分页与列表变更通知；
- 取消、超时、结果大小限制、健康状态和退出清理。

在 `.schemanaut/mcp.json` 中配置 Project Server：

```json
{
  "version": 1,
  "servers": [
    {
      "id": "catalog",
      "name": "Internal catalog",
      "source": "user",
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "autoStart": true,
      "headers": {
        "Authorization": { "ref": "mcp/catalog/authorization" }
      }
    }
  ]
}
```

敏感环境变量与 Header 必须使用引用，不能保存明文。由宿主解析：

```ts
const runtime = new DatabaseAgentRuntime({
  projectDirectory: '/srv/acme-data',
  mcpSecretResolver: async (ref) => {
    return await secretStore.get(ref);
  },
});
```

`autoStartMcp` 默认为 `false`。读取配置本身不会启动进程或建立远程连接。应显式启动已审核的 Server、调用 `startConfiguredMcpServers()`，或仅在可信宿主中设置 `autoStartMcp: true`。可以通过 Runtime 公开门面管理：

```ts
const server = await runtime.upsertMcpServer({
  id: 'local-tools',
  name: 'Local tools',
  transport: 'stdio',
  command: 'node',
  args: ['./mcp-server.mjs'],
  enabled: true,
  autoStart: false,
});

const started = await runtime.startMcpServer(server.id);
console.log(started.tools);
console.table(await runtime.listMcpServers());
await runtime.stopMcpServer(server.id);
await runtime.removeMcpServer(server.id);
```

`listMcpServers()` 只返回生命周期与健康摘要，刻意不包含命令、环境变量、Header 和 Secret 引用。`upsertMcpServer()` 可接收 stdio、Streamable HTTP 或 SSE 配置。`startConfiguredMcpServers()` 会启动已启用且标记 `autoStart` 的 Server。可信宿主如果需要 Resource、Prompt、详细健康状态或完整配置，仍可使用底层 `runtime.mcpConfig` 和 `runtime.mcp`。

动态发现默认开启。Agent 最初只看到发现工具，需要时才激活匹配的 MCP Tool，避免把所有 Tool Schema 塞进每轮 Prompt。

## 13. 确定性的“先生成、再执行”

应用需要自己控制执行边界时，使用 `generate()`：

```ts
const generated = await runtime.generate({
  question: '查询本月已支付金额最高的 10 个客户。',
});

console.log(generated.sql);
console.log(generated.safety);
console.log(generated.evidence);

if (generated.status === 'awaiting_execution') {
  const executed = await runtime.executeGenerated(generated.runId, {
    limit: 100,
  });
  console.table(executed.execution.rows);
}
```

生成 SQL 的 Run 元数据会持久化到 Project 隔离的 SQLite 状态库并跨 Runtime 重启恢复，但结果行不会持久化。`executionResultAvailable` 只在即时执行响应中为 `true`。恢复后的已完成 Run 会返回 `executionResultAvailable: false`；重新连接同一数据库后，调用 `reexecuteGenerated(runId, { limit })` 可取得新的有界结果。

该路径只执行一条只读语句。行数据修改或 DDL 应使用匹配权限模式的 `runAgent()`。

## 14. 模型直调与底层数据库 API

同一个 Runtime 还提供：

- `llmChat()`、`llmStream()` 和 `submitLlmBatch()`；
- `llmModels()`、`discoverLlmModels()` 和 `llmMetrics()`；
- `runtime.database`：连接档案、资源、Query Job、分页结果、取消和事务；
- `runtime.resources`：统一资源图与状态快照。

这些是集成基础能力，并不代表 v1 包含治理运维 Agent。

签名和限制见 [API 参考](api-reference.zh-CN.md)。

## 15. 本地 REST API

启动服务：

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

配置模型和数据库：

```bash
curl -X POST http://127.0.0.1:3721/v1/setup \
  -H "content-type: application/json" \
  -d '{
    "llm": {
      "protocol": "openai-compatible",
      "baseUrl": "https://your-endpoint/v1",
      "apiKey": "...",
      "model": "your-model"
    },
    "database": {
      "host": "127.0.0.1",
      "port": 5432,
      "database": "app",
      "username": "app_reader",
      "password": "..."
    }
  }'

curl -X POST http://127.0.0.1:3721/v1/schema/index \
  -H "content-type: application/json" \
  -d '{ "maxTables": 500 }'

curl -X POST http://127.0.0.1:3721/v1/agent/run \
  -H "content-type: application/json" \
  -d '{
    "userId": "user-42",
    "mode": "read",
    "message": "查询最近 7 天每天的已支付订单金额。"
  }'
```

`POST /v1/agent/run` 返回 `AiSqlAgentRunView`，而不是 SDK 的完整 `AiSqlAgentRun`。其中的 Session 只包含面向用户的消息与状态，不暴露 Tool 消息/调用、检索内部信息、Skill 正文指令和评测数据。

如需实时进度，使用语义化 SSE 接口：

```bash
curl -N -X POST http://127.0.0.1:3721/v1/agent/run/stream \
  -H "content-type: application/json" \
  -d '{
    "userId": "user-42",
    "mode": "read",
    "message": "查询最近 7 天每天的已支付订单金额。"
  }'
```

每个进度帧使用 `event: <AgentUserEvent.type>`，`data:` 为事件 JSON。典型事件包括 `plan-updated`、`sql-prepared`、`sql-executed`、`correcting`、`approval-required` 和 `completed`。成功时以 `event: result` 结束，数据为 `AiSqlAgentRunView`；失败时以 `event: error` 结束，数据为 `{ "error": { "code", "message", "retryable" } }`。客户端断开会取消当前 Run。

Agent 管理接口：

| 范围    | 接口                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session | `GET /v1/agent/sessions`、`GET/DELETE /v1/agent/sessions/:id`、`POST /v1/agent/sessions/:id/steer`、`POST /v1/agent/sessions/:id/compact`、`GET /v1/agent/sessions/:id/context-checkpoints` |
| Skills  | `GET /v1/agent/skills`、`POST /v1/agent/skills/refresh`                                                                                                                                     |
| 许可    | `GET /v1/agent/approvals`、`POST /v1/agent/approvals/:id/resolve`，请求体为 `{ approved, resolvedBy?, reason? }`                                                                            |
| MCP     | `GET/POST /v1/agent/mcp`、`POST /v1/agent/mcp/:id/start`、`POST /v1/agent/mcp/:id/stop`、`DELETE /v1/agent/mcp/:id`                                                                         |

当 Stream 发出 `approval-required` 时，UI 可以在 Stream 保持连接期间读取并处理待许可请求。该流程依赖 Runtime 默认 Broker；如果 Server 使用自定义 `approvalProvider`，则由该回调自行负责许可交付。

服务只允许监听本机回环地址，同时校验 HTTP `Host`；浏览器请求必须同源，携带请求体的变更接口必须使用 JSON。通过 REST 管理进程型 stdio MCP 默认关闭，只有可信宿主显式启用 `allowProcessMcpManagement` 后才开放；远程 HTTP/SSE MCP 仍受标准配置校验。SchemaNaut 不提供用户账号、注册或登录体系；身份认证和 API 访问控制由嵌入它的宿主应用或网关负责。SchemaNaut 也不提供持久 Secret Vault。

嵌入式应用可以通过公开的 Server 子路径启动并关闭同一服务：

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/schemanaut';
import { startDatabaseAgentServer } from '@nwlworkshop/schemanaut/server';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'acme',
  projectDirectory: '/srv/acme-data',
});

const started = await startDatabaseAgentServer({
  runtime,
  host: '127.0.0.1',
  port: 3721,
  // 只有可信本机宿主明确允许 REST 客户端启动 stdio MCP
  // 子进程时才可设为 true。
  allowProcessMcpManagement: false,
});

console.log(started.url);

try {
  // 此处可以使用本地 REST 服务。
} finally {
  await started.close();
}
```

`startDatabaseAgentServer()` 会拒绝非回环地址。`started.close()` 会停止接收请求、取消活跃请求工作，并等待 Runtime 完成清理。只有可信本机嵌入宿主才可设置 `allowProcessMcpManagement: true`：已配置的 stdio MCP 命令会继承宿主进程的操作系统权限。不要为不可信浏览器、远程客户端或共享网关开启它。

## 16. 交互式 CLI

```bash
npx schemanaut init ./acme-data
npx schemanaut skills -C ./acme-data
npx schemanaut sessions -C ./acme-data
npx schemanaut chat -C ./acme-data
```

`chat` 读取：

```text
SCHEMANAUT_LLM_BASE_URL
SCHEMANAUT_LLM_API_KEY          # 本地 Ollama 可省略
SCHEMANAUT_LLM_MODEL
SCHEMANAUT_DATABASE_URL
SCHEMANAUT_MAX_SCHEMA_TABLES    # 可选，默认 500
SCHEMANAUT_STATE_DATABASE_PATH  # 可选
```

CLI 会先加载 `<project>/.env`，再读取这些变量；进程环境中的已有值优先。格式错误只报告行号和错误类别，不回显原文或变量值。因此，复制仓库中的 `.env.example` 即可得到与 CLI 一致的配置合同。

PostgreSQL URL 支持 `sslmode=disable|require|verify-ca|verify-full`。`require` 仅保证加密但不校验证书，`verify-ca` 校验证书链，`verify-full` 还会校验主机名。由于 Node 运行时无法可靠保证 PostgreSQL `prefer` 的降级语义，因此会明确拒绝该模式。

Chat 内命令：

```text
/mode read|edit|full
/new
/resume <session-id>
/sessions
/skills
/<skill> [任务]
/compact [关注点]
/mcp [list|start <id>|stop <id>]
/exit
```

运行中输入普通文字会追加到当前任务；`Ctrl+C` 取消本次运行并保留 Session 状态。

## 17. 取消、错误与 Secret

`runAgent()`、`generate()`、`compactAgentSession()`、模型直调和支持取消的底层操作均可传入 `AbortSignal`。

SDK 错误使用 `DatabaseAgentError`：

```ts
{
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}
```

宿主应用必须遵守：

- 模型密钥和数据库密码不得进入 Project 文件、Skills、Session 消息、SQL、日志和源码；
- MCP Secret 引用由外部 Secret Store 解析；
- 使用最小权限数据库账号；
- 需要用户或组织审批时，必须使用默认许可 Broker 或自定义 `approvalProvider`；
- 将 `full` 模式视为宿主命令执行权限，而不只是数据库 DDL 权限；
- 除非部署明确需要并信任，否则保持 `enableShellTool` 和 REST `allowProcessMcpManagement` 关闭；
- 用户提供的 Skills、MCP Server 和项目指令属于可执行配置，需要经过信任审核。

## 18. 继续阅读

- [SDK API 参考](api-reference.zh-CN.md)
- [Agent 与扩展运行时](../agent/README.md)
- [AI SQL 工程文档](../ai-sql/README.md)
- [产品总体功能设计](../product-functional-overview.md)
- [安全策略](../../SECURITY.md)
