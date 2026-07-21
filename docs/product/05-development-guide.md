# 05 - SDK-first 开发指南

> 文档版本：v1.0
> 当前目标：完成可在本机试用的 Headless MVP
> 产品范围以 [11-headless-mvp.md](./11-headless-mvp.md) 为准。

## 1. 开发目标

当前阶段不继续扩展复杂 Electron IDE。开发顺序改为：

1. 复用并稳定现有 core 包。
2. 提供可嵌入的 TypeScript SDK Runtime。
3. 用本地 HTTP Server 暴露稳定 REST 合同。
4. 用无框架静态 WebUI 完成试用闭环。
5. 验证正确率和安全边界后，再增加 MCP、Verified Query 和运维工具。

每个能力必须能在没有正式前端的情况下执行和测试。

## 2. 技术基线

- Node.js 20+
- TypeScript strict / NodeNext / ESM
- pnpm workspace + Turbo
- Vitest
- PostgreSQL（MVP 唯一数据库）
- OpenAI-compatible LLM Provider
- Node 内置 `http` 和 `fetch`

MVP 不引入新的 Web 框架、前端框架、数据库 ORM、Agent 框架或向量数据库。已有 core 能力足以完成第一条垂直闭环；后续依赖仍按 `docs/engineering/open-source-first.md` 评估。

## 3. 目标仓库结构

```text
apps/
├── server/                 # 本地 REST + CLI + 静态参考 WebUI
└── desktop/                # 现有兼容宿主，当前不作为开发主线

packages/
├── sdk/                    # 公共 Headless Runtime 和传输无关合同
├── shared/                 # 现有稳定领域类型与兼容 IPC 类型
├── core-db/                # Driver、SQL 安全、执行与错误分类
├── core-rag/               # Schema 索引、检索与上下文
├── core-llm/               # Provider 合同与 OpenAI-compatible 实现
├── core-agent/             # 通用 Agent Loop、权限、审批与恢复
├── core-tools/             # 数据库、RAG、工作区和 MCP 工具适配
├── core-skills/            # Skill 定义与匹配
├── core-workspace/         # 后续工作空间扩展
├── core-auth/              # 后续团队/云端认证
└── core-usage/             # 本地用量与后续计量
```

### 3.1 依赖方向

```text
core-* / shared
      ↑
  @dbagent/sdk
      ↑
 apps/server
      ↑
 WebUI / REST client
```

- `core-*` 不依赖 SDK、Server、Electron 或 WebUI。
- SDK 可以组合 `core-db`、`core-rag`、`core-llm`，但不依赖 Electron。
- Server 只做 HTTP、配置装配、错误映射和静态文件服务。
- WebUI 只调用 REST API。
- Desktop 后续如果需要，应调用 SDK，而不是复制 Runtime 逻辑。

## 4. 公共合同规则

### 4.1 Runtime 方法

MVP SDK 至少提供：

```ts
interface DatabaseAgentRuntime {
  configureProvider(input: ProviderConfig): void;
  testConnection(input: PostgresConnectionInput): Promise<ConnectionTestResult>;
  connect(input: PostgresConnectionInput): Promise<ConnectionSnapshot>;
  disconnect(): Promise<void>;
  indexSchema(options?: IndexSchemaOptions): Promise<SchemaIndexSnapshot>;
  schemaStatus(): SchemaIndexSnapshot;
  generate(input: GenerateSqlInput): Promise<GeneratedSqlRun>;
  executeGenerated(runId: string, options?: ExecuteGeneratedOptions): Promise<ExecutedSqlRun>;
  getRun(runId: string): SqlRunSnapshot | undefined;
}
```

### 4.2 合同约束

- 所有外部输入在公共边界校验。
- 错误使用稳定 `code`，同时保留可读中文 `message`。
- Optional 字段遵守 `exactOptionalPropertyTypes`。
- 返回类型不包含 API Key、数据库密码、Provider 实例、连接池和 Prompt 全文。
- `generate()` 永不执行 SQL。
- `executeGenerated()` 只执行当前 Runtime 已保存、通过只读审计的生成记录。
- 所有长任务接受 `AbortSignal`。

### 4.3 运行状态

```text
generating → awaiting_execution → executing → completed
     │               │               │
     └───────────────┴───────────────┴→ failed / aborted / blocked
```

运行记录必须保留问题、SQL、解释、假设、Schema 证据摘要、安全报告、状态、时间和结果摘要；不得保留凭证。

## 5. Headless MVP 垂直切片

### 5.1 产品场景

开发者在本机启动 Server，连接只读 PostgreSQL，通过 WebUI 或 API 输入业务问题，审核模型生成的 SQL 后显式执行并获得结果。

### 5.2 模块边界

| 行为 | 所属模块 |
|---|---|
| PostgreSQL 连接与查询 | `core-db` |
| SQL 风险判断 | `core-db` |
| Schema 文档和检索 | `core-rag` |
| LLM 请求 | `core-llm` |
| 生成/审批/执行编排 | `sdk` |
| HTTP、CLI、WebUI | `apps/server` |

### 5.3 安全边界

- 连接配置强制 `readOnly: true`。
- 模型只负责建议 SQL，不拥有数据库执行权限。
- Runtime 在执行前重新审计保存的 SQL。
- SQL 为空、多语句、写入、DDL、未知类型或需要确认时不得执行。
- 查询结果默认限制 200 行，最大不超过 1000 行。
- Server 默认仅绑定 loopback。
- Secret 只存在内存，不写配置文件、日志和 API 响应。

### 5.4 测试

确定性测试：

- 连接前禁止索引、生成和执行。
- 索引前禁止生成。
- 模型结构化 JSON、Markdown code fence 和非法响应解析。
- 只读 SELECT / WITH 可进入待执行状态。
- 写入、多语句和未知 SQL 被阻止。
- 运行 id 不存在、重复执行、执行失败和中止。
- Server 路由、非法 JSON、请求体上限、404 和错误映射。
- WebUI 静态入口和健康检查。

真实门控测试：

- 真实 PostgreSQL 连接、Catalog 抽取和查询执行。
- 真实 OpenAI-compatible 模型生成 SQL。
- 发布前组合运行“真实模型 + 真实 PostgreSQL”。

## 6. 里程碑

### H0：路线与合同

- [x] 产品改为 Headless / SDK-first。
- [x] 明确极简 WebUI 和不做清单。
- [x] 定义 MVP Runtime 与 REST 合同。
- [x] 增加 SDK 和 Server 代码骨架。

入口验收：文档不存在“必须先完成复杂 IDE 才能试用”的依赖。

### H1：可试用 MVP

#### SDK

- [x] `@dbagent/sdk` 包和导出类型。
- [x] Provider 配置与只读 PostgreSQL 生命周期。
- [x] Schema 抽取、索引和状态。
- [x] 结构化 NL2SQL 生成。
- [x] 保存生成记录、安全阻断和显式执行。
- [x] 单元测试和 fake adapter 场景测试。

#### Server

- [x] Node HTTP Server 和 CLI。
- [x] `/health`、`/v1/capabilities`、`/v1/setup`。
- [x] Schema、生成、执行和 run 查询路由。
- [x] 统一错误响应和请求体限制。
- [x] loopback 默认绑定。

#### WebUI

- [x] 单页面配置模型与 PostgreSQL。
- [x] 索引状态和提问入口。
- [x] SQL、解释、假设、证据和风险展示。
- [x] 显式执行和结果表格。
- [x] 不使用 React、Monaco 或独立状态框架。

入口验收：用户运行一条开发命令后，可在浏览器完成真实 PostgreSQL 自然语言查数。

2026-07-21 状态：H1 代码、默认门禁、编译后 Server smoke 和真实 PostgreSQL 门禁已通过；真实模型 + 测试库组合门禁已经接入，但必须由试用者确认允许把测试 Schema 上下文发送给所选模型服务后显式运行。

### H2：可嵌入 Beta

- [ ] MCP Server adapter。
- [ ] HTTP SDK / Python 生成客户端。
- [ ] Verified Query 持久化和反馈接口。
- [ ] OpenAPI 文档。
- [ ] SSE 运行事件、取消和持久化历史。
- [ ] 固定 NL2SQL 评测集与发布门禁。

H2 不得提前阻塞 H1 试用。

### H3：数据库运维 Agent

- [ ] EXPLAIN 解释和索引建议。
- [ ] 慢 SQL、锁、会话和长事务诊断。
- [ ] 只读健康检查 Runbook。
- [ ] Plugin/MCP 权限 manifest。
- [ ] 写操作预览、审批和审计加强。

### H4：团队与商业化

- [ ] 团队共享语义知识和 Verified SQL。
- [ ] RBAC、审计、SSO、集中 Secret。
- [ ] 私有化、高可用和 OEM 授权。
- [ ] 国产数据库适配和企业支持。

## 7. 现有代码迁移规则

- 不删除现有 Electron、IPC、Agent、RAG、Workspace 和恢复能力。
- 不继续以桌面窗口、三栏布局或安装包作为当前里程碑入口验收。
- 未提交的现有改动属于开发者工作，不覆盖、不回退。
- 新 Runtime 优先复用现有 core 包，不从 desktop main 导入业务实现。
- 当 SDK 稳定后，再把 Desktop main 的重复组合逻辑逐步迁移到 SDK。
- 旧 IDE 能力保留测试，避免重构造成回归，但不扩大 MVP。

## 8. 开源优先结论

本 MVP 不新增第三方框架：

- HTTP 使用 Node 内置 `http`，因为路由极少且仅本地运行。
- WebUI 使用静态 HTML/CSS/JS，避免为参考客户端引入前端构建链。
- LLM 复用现有 OpenAI-compatible Provider。
- Schema RAG 复用现有词法与关系索引。
- SQL 安全和 PostgreSQL 执行复用现有 `core-db`。

这不是长期拒绝 Fastify、官方 MCP SDK、OpenAPI 工具或向量数据库。H2/H3 引入前必须评估许可证、体积、离线行为、Windows/Linux 和安全边界。

## 9. 代码规范

- TypeScript strict，不使用无说明的 `any`。
- 公开类型通过包入口导出。
- core 包不得依赖 Electron。
- Runtime 不读取全局环境变量；环境变量只由 Server 装配层读取。
- 所有可注入 adapter 都用接口，不把第三方 SDK 类型暴露到公共合同。
- 日志只记录运行 id、状态、耗时和错误码，不记录 Prompt、SQL 结果或凭证。
- 单个实现切片保持可审查，避免同时重写多个现有 core 包。

## 10. 验证顺序

每个切片依次执行：

1. 新包的 `typecheck`。
2. 新包的单元测试。
3. 相关 core 包测试。
4. 全仓 `pnpm typecheck`。
5. 全仓 `pnpm test`。
6. `pnpm smoke`。
7. 真实 PostgreSQL 门控测试。
8. 有 API key 时运行真实模型组合测试。

若外部依赖不可用，必须明确标记未运行的门控，不得用 mock 成功代替真实验收。

## 11. MVP 完成定义

只有同时满足以下条件，H1 才能称为“可试用 MVP”：

- SDK、REST 和 WebUI 走同一 Runtime。
- 真实 PostgreSQL 可连接、索引和执行安全查询。
- 真实模型可根据 Schema 生成结构化 SQL。
- 写 SQL、多语句和未知 SQL 在本地确定性阻断。
- API Key、密码不落盘、不回显、不进日志。
- 新增测试、类型检查和 smoke 通过。
- 中文文档包含启动、试用、限制和故障排查。
- 用户能在十分钟内完成第一次查询。
