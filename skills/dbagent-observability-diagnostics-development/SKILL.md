---
name: dbagent-observability-diagnostics-development
description: Use when implementing or reviewing DBAgent/Nexus observability, audit logs, agent traces, SQL history, diagnostic report generation, redaction, health status, recovery state, or user-support evidence for backend features.
---

# DBAgent 可观测与诊断开发

用于让后端能力在真实用户机器上可解释、可排错、可恢复。每个长任务、外部依赖、危险操作和持久化能力都应留下足够但脱敏的证据。

## 必读文档

- 错误恢复和诊断报告：`docs/product/09-error-recovery.md`
- Agent trace、工具调用日志、成本观测：`docs/product/03-agent-design.md`
- SQL 历史和传统操作审计：`docs/product/06-classic-features.md`
- 配置、MCP、Provider 和 IPC：`docs/product/04-config-design.md`
- 用量记录和 gateway：`docs/product/10-usage-and-subscription.md`
- 开发规范日志章节：`docs/product/05-development-guide.md`

## 设计目标

- 用户能知道任务进行到哪一步、为什么失败、还能不能继续。
- 开发者能用日志定位问题，而不需要用户提供数据库内容或密钥。
- 崩溃或中断后，恢复流程能读取稳定状态。
- 诊断包可交付给支持人员，但默认不含敏感数据。

## 观测对象

- 数据库连接：连接、断开、重连、健康检查、查询耗时、取消、rollback。
- SQL 执行：SQL 类型、风险级别、影响行数估计、耗时、错误码；不要默认记录完整结果集。
- Agent：session、iteration、tool call、permission decision、retry、abort、token usage。
- RAG：索引阶段、进度、检索耗时、命中对象 ID、on-demand indexing。
- MCP：server start/stop、health、restart、tool timeout、stderr 摘要。
- Python/terminal：process id、cwd、命令摘要、exit code、stdout/stderr 截断、产物路径。
- 配置：版本、迁移、损坏恢复、原子写失败。
- Auth/usage：登录状态、token refresh 结果、用量记录状态；不记录 JWT 和验证码。

## 实现要求

- 使用结构化日志，字段稳定，便于过滤。
- 每条日志都应有模块名、operation、request/session id、status、durationMs。
- 所有日志和诊断包必须经过 redaction：key、token、password、secret、authorization、connection URL。
- 长任务必须暴露 progress、cancel、done、failed 事件或等价状态。
- 持久化任务要能区分 pending、running、done、failed、aborted、recovered。
- 诊断包必须记录应用版本、OS、关键配置摘要、近期脱敏日志、崩溃快照和测试过的健康检查结果。

## 测试要求

- 测试 redaction：真实格式的 API key、JWT、连接串、Authorization header 必须被遮蔽。
- 测试失败可观测：异常路径有错误码、日志、状态更新。
- 测试恢复状态：running 状态异常退出后能被标记为 interrupted 或 recovered。
- 测试诊断包：包含必要文件，不包含 secret patterns。

## 输出格式

```markdown
## 可观测与诊断设计

目标能力：

观测事件：

日志字段：

持久化状态：

脱敏规则：

诊断包内容：

测试计划：

已知限制：
```
