# 01 - 产品入口与极简 WebUI

> 文档版本：v1.0
> 文件名保留 `ui-design` 以兼容旧引用；本文件现在定义所有产品入口，不再设计复杂数据库 IDE。

## 1. 目标

DBAgent 的用户体验首先由 SDK、API、CLI 和 MCP 决定。WebUI 是本地 REST API 的参考客户端，目标是让用户快速完成试用和安全审批，而不是承载专业 IDE 功能。

## 2. 入口优先级

| 入口 | 用户 | 作用 | 优先级 |
|---|---|---|---|
| TypeScript SDK | Node.js / SaaS 开发者 | 进程内嵌入 Runtime | P0 |
| REST API | 任意语言和内部平台 | 远程或本地调用 | P0 |
| Server CLI | 开发者 / DBA | 启动、配置、健康检查 | P0 |
| 极简 WebUI | 产品试用者 | 配置、提问、审批、结果 | P0 |
| MCP Server | AI 客户端 / Agent 平台 | 暴露受控数据库工具 | P1 |
| Python SDK | 数据团队 | OpenAPI 生成客户端 | P1 |
| Electron Desktop | 兼容和后续参考 | 非当前主入口 | P3 |

一个能力只有在 SDK 或 Runtime 层存在，才能被其他入口暴露。禁止在 WebUI、CLI 或 MCP 中实现独有业务规则。

## 3. MVP 用户路径

```text
启动本地 Server
  → 配置 LLM（OpenAI-compatible）
  → 配置只读 PostgreSQL
  → 测试并建立连接
  → 抽取与索引 Schema
  → 输入自然语言问题
  → 查看相关 Schema、SQL、解释、假设和风险
  → 显式点击执行
  → 查看结果或可行动错误
```

任何一步失败都应保留此前成功状态，允许用户修改配置后单步重试。

## 4. 极简 WebUI

### 4.1 页面结构

MVP 只包含一个主页面，按纵向步骤组织：

1. **运行状态**：Server、模型、数据库和 Schema 索引状态。
2. **模型配置**：Base URL、API Key、模型名；API Key 只提交给本地 Server，不回显。
3. **数据库配置**：Host、Port、Database、Username、Password、SSL；强制只读。
4. **提问区**：问题输入和“生成 SQL”按钮。
5. **审核区**：Schema 证据、SQL、解释、假设、安全等级和性能提示。
6. **执行区**：仅在 SQL 安全时显示“执行只读 SQL”；展示表格结果和耗时。

运行历史和高级设置不进入首版页面；必要信息通过 API 返回并可在浏览器开发工具或 CLI 查看。

### 4.2 必要状态

- 初始：尚未配置。
- 配置中：按钮禁用，显示具体步骤。
- 已连接但未索引。
- 已准备，可生成 SQL。
- SQL 生成中，可取消。
- 等待人工执行。
- 执行中。
- 完成。
- 失败：显示稳定错误码、中文信息和建议动作。

### 4.3 结果展示

- SQL 使用等宽字体和可复制文本块。
- 风险等级只使用安全、需审查、危险、阻止四种语义。
- Schema 证据显示命中的表/字段，不展示完整 Prompt。
- 结果表只处理有限行数；大结果通过后续导出接口解决。
- 不渲染模型返回的任意 HTML。

## 5. 明确不做的 UI

- 多栏 IDE 布局和可拖拽 Dock。
- Monaco SQL 工作台。
- Schema 树高级交互和对象编辑。
- 表设计器、ER 编辑器、视图/函数编辑器。
- BI 图表设计器和仪表盘。
- 插件市场、主题商店和复杂设置中心。
- Agent 思维链、子 Agent 动画和炫技式流程图。
- WebUI 中直接编辑或执行写 SQL。

## 6. SDK 体验

MVP SDK 应使核心流程保持短小：

```ts
const agent = new DatabaseAgentRuntime({ provider, model });
await agent.connect(postgresConfig);
await agent.indexSchema();

const run = await agent.generate({ question: '昨天每个城市的订单金额是多少？' });
if (run.safety.riskLevel === 'safe') {
  const result = await agent.executeGenerated(run.runId);
}
```

SDK 必须提供：

- 完整 TypeScript 类型和稳定错误码。
- 可注入 LLM Provider 和 Database Driver。
- 不依赖 Electron、DOM 或某个 HTTP 框架。
- 生成和执行两个独立方法。
- 可取消的 `AbortSignal`。
- 不把凭证写入返回对象或日志。

## 7. REST 体验

MVP REST 路由：

| 方法 | 路由 | 作用 |
|---|---|---|
| GET | `/health` | 进程与能力探活 |
| GET | `/v1/capabilities` | 返回数据库、入口和安全能力 |
| POST | `/v1/setup` | 在本地进程内配置模型与数据库并建立连接 |
| POST | `/v1/schema/index` | 抽取并索引当前连接 Schema |
| GET | `/v1/schema/status` | 查询索引状态 |
| POST | `/v1/query/generate` | 生成 SQL，不执行 |
| POST | `/v1/query/execute` | 显式执行指定生成记录 |
| GET | `/v1/runs/{runId}` | 查询运行记录 |

REST 的错误统一返回：

```json
{
  "error": {
    "code": "SCHEMA_NOT_INDEXED",
    "message": "请先索引数据库 Schema。",
    "retryable": true
  }
}
```

## 8. CLI 与 MCP

### 8.1 MVP CLI

- `dbagent-server --host 127.0.0.1 --port 3721`：启动本地服务。
- 配置优先来自环境变量或 API，不在命令历史中要求输入明文密钥。
- 启动时输出访问地址、版本和安全提示。

### 8.2 MCP（下一切片）

MCP Server 只映射 Runtime 已存在的能力：

- `dbagent_schema_search`
- `dbagent_generate_sql`
- `dbagent_execute_generated_sql`
- `dbagent_explain_sql`
- `dbagent_diagnose_query`

MCP 工具必须复用同一权限、审批和审计合同，不得绕过 Runtime 直接访问数据库。

## 9. 安全与部署

- MVP Server 默认只监听 `127.0.0.1`。
- API Key 和数据库密码仅保存在进程内存中，进程退出即清除。
- WebUI 不使用本地存储保存密钥。
- API 响应、异常和日志不得包含凭证。
- 所有执行接口只允许 Runtime 生成并保存在当前进程中的安全 SQL。
- 远程监听、鉴权、TLS 和多用户隔离不属于 MVP；如果绑定非 loopback 地址，Server 必须拒绝启动或要求未来的显式安全配置。

## 10. 验收

- 不安装桌面应用即可完成完整试用。
- 一个静态页面即可完成配置、生成、审批和执行。
- WebUI 没有任何独有业务逻辑。
- API 与 SDK 对同一请求返回一致的运行状态和安全报告。
- 浏览器刷新不会泄露 API Key 或密码；允许用户重新配置。
- 1280px 宽度下无需复杂布局即可使用。
- 错误信息包含稳定错误码、中文说明和重试建议。
