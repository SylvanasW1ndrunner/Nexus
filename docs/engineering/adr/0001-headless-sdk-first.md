# ADR-0001：产品主线调整为 Headless Runtime / SDK-first

- 状态：已接受
- 日期：2026-07-21
- 决策者：DBAgent 团队

## 背景

原产品路线以 Electron 数据库 IDE 为主入口，里程碑包含复杂三栏工作台、SQL 编辑器、表设计器、Schema 树、工作空间和大量桌面交互。对三人创业团队而言，前端开发、跨平台打包和传统 IDE 功能会持续占用资源，但不能直接形成自然语言转 SQL 与数据库运维的核心壁垒。

现有代码已经将 `core-db`、`core-rag`、`core-llm`、`core-agent`、`core-tools` 等能力拆成不依赖 Electron 的包，也已存在无 UI Agent 服务边界，因此可以在保留已有成果的情况下调整产品主线。

## 决策

1. DBAgent 的主体改为可嵌入式 AI Database Agent Runtime。
2. TypeScript SDK 和本地 REST API 成为首要公共入口。
3. CLI、MCP、WebUI 和 Desktop 都作为同一 Runtime 的薄适配层。
4. 当前 H1 MVP 只验证 PostgreSQL 只读自然语言查数：Schema 索引、SQL 生成、本地审计、人工执行和结果。
5. WebUI 使用单页静态实现，只承担配置、提问、审核、执行和结果查看。
6. 现有 Electron 与 IDE 能力不删除，但停止作为当前里程碑的入口验收和功能扩展主线。
7. 商业化从“代付模型费用”调整为团队治理、评测、共享知识、私有化、国产数据库适配和 OEM 授权。

## 结果

正向影响：

- 三人团队可以集中投入准确率、安全、数据库适配和接入体验。
- 核心能力可被 SaaS、内部平台和外部 Agent 复用。
- WebUI 成本显著降低，且不会成为业务逻辑唯一入口。
- 私有化、MCP 和 OEM 与核心架构自然兼容。

代价与风险：

- 主要用户从普通分析师转向开发者、平台团队、DBA 和软件厂商。
- API 稳定性、文档、示例和版本兼容成为新的主要体验成本。
- 缺少复杂 UI 会降低直接面向个人终端用户的传播效果。
- SDK、REST、CLI、MCP 仍可能形成多入口维护压力，必须坚持薄适配层。

## 迁移策略

- 保留所有 core 包和现有测试。
- 新增 `@dbagent/sdk` 组合核心能力。
- 新增本地 Server/CLI 和静态 WebUI。
- 新能力不从 `apps/desktop` 导入实现。
- SDK 稳定后，Desktop 可逐步改为调用 SDK。
- 当前未提交的 Agent 审批流改动保持原样，不纳入本次迁移覆盖范围。

## 验证

- SDK、REST 和 WebUI 必须走同一 Runtime。
- 默认 CI 覆盖状态机、模型输出解析、SQL 阻断、HTTP 错误和 Secret 脱敏。
- 真实 PostgreSQL 与真实 OpenAI-compatible 模型使用显式门控测试。
- MVP 完成定义以 `docs/product/11-headless-mvp.md` 为准。
