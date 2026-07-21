# 2026-07-21 Headless Runtime MVP 开发切片

## 基本信息

- 切片名称：SDK-first NL2SQL 本地可试用闭环
- 负责人角色：当前开发会话
- 关联产品文档：`docs/product/00-overview.md`、`docs/product/05-development-guide.md`、`docs/product/11-headless-mvp.md`
- 关联工程文档：`docs/engineering/adr/0001-headless-sdk-first.md`

## 业务场景

开发者运行本地 Server，在浏览器配置 OpenAI-compatible 模型和只读 PostgreSQL；系统索引真实 Schema，基于自然语言生成带证据的 SQL。用户审阅后明确点击执行，得到有限行数的结构化结果。

## 模块边界

- 新增：`packages/sdk`、`apps/server`。
- 复用：`packages/core-db`、`packages/core-rag`、`packages/core-llm`、`packages/shared`。
- 保留但不扩大：`apps/desktop` 与旧 IDE 路线。
- 公开合约：`DatabaseAgentRuntime`、运行类型、错误码和 REST 路由。
- typed IPC：不涉及；本切片以 SDK/HTTP 为入口。
- 第三方依赖：无新增依赖。
- 官方插件候选：Server 本身不是插件；H2 的 MCP adapter 和数据库 driver 适合独立候选。

## 开源优先评估

- 对标：Vanna 的 Python SDK/API/参考 UI 分层，以及常见 Text-to-SQL 产品的 Schema Context、Verified Query 与安全执行思路。
- 决策：借鉴 Headless 和薄 UI 产品形态，复用仓库已有 core 能力，不在 MVP 引入完整 RAG/Agent/Web 框架。
- 原因：三人团队需要降低前端、打包和供应链成本；现有 TypeScript core 已能覆盖单 PostgreSQL 闭环。
- 后续：MCP SDK、向量索引、reranker 和评测框架进入 H2 时单独评估许可证、离线、跨平台与数据出境边界。

## 实现要求与结果

- 成功路径：配置、连接、索引、生成、审计、保存 run、显式执行、展示结果已完成。
- 失败路径：统一错误码、HTTP 状态、run 失败状态已完成。
- 超时/取消：连接与语句超时已完成；生成取消由 SDK `AbortSignal` 支持；HTTP 级取消留 H2。
- 持久化/恢复：MVP 仅内存；进程重启后重新配置与索引。
- 权限/安全：双重 SQL 审计、数据库只读会话、生成 SQL 与执行分离、行数限制、loopback 限制。
- 日志与脱敏：当前不记录 Prompt、结果或 Secret；API 响应不回显 Secret。

## 测试要求

- 单元测试：模型输出解析、Runtime 状态机、安全阻断、Server 路由。
- 真实 PostgreSQL：Catalog 抽取、Schema RAG、只读会话和显式执行。
- LLM 门控：`DBAGENT_RUN_SDK_MVP_LIVE=1` 时运行真实模型 + PostgreSQL 组合用例。
- 打包测试：不涉及 Electron；验证 TypeScript 构建和编译后 CLI 启动。

## 验收标准

- [x] 功能可从 SDK、REST、CLI 和 WebUI 调用。
- [x] core 与 SDK 不依赖 Electron。
- [x] 公共类型与错误合同已落盘。
- [x] 新能力未引入第三方依赖。
- [x] SQL 安全边界有确定性测试。
- [x] 真实 PostgreSQL 门控已接入。
- [x] 真实 LLM + PostgreSQL 门控已接入。
- [x] 中文产品、模块、ADR 和试用文档已同步。

## 明确不在本切片完成

- MCP Server、Python SDK、OpenAPI、SSE。
- Verified Query 与运行历史持久化。
- 写操作、DDL、自动运维与审批流。
- 多数据库、账号系统、支付和团队部署。
- 复杂桌面或 Web IDE。
