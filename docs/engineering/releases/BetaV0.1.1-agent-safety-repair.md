# BetaV0.1.1 Agent 安全预检与修复契约

## 变更摘要

- `core-agent` 新增任务级敏感信息导出安全预检。
- Agent 运行状态新增 `safety_blocked`。
- 工具执行记录新增 `failureKind` 与 `retryable`。
- 审计日志记录工具失败分类，便于后续恢复、诊断和用户级评测。
- `core-tools` 业务场景评测新增 PII 阻止与 SQL 修复场景。

## 用户价值

数据工程师和分析师使用 Agent 查询数据库时，系统现在可以在更早阶段阻止直接导出敏感个人信息的任务，降低误操作风险。同时，Agent 遇到常见 SQL 错误时，测试框架可以验证它是否真的修复并重新执行，而不是只生成一个看起来合理的最终回答。

## 验证记录

本版本切片完成后运行：

- core-agent 类型检查。
- core-tools 类型检查。
- core-agent 与 core-tools ESLint。
- core-agent 安全预检、工具失败分类、ReactAgent 回归测试。
- core-tools Agent/RAG 业务场景回归测试。
- 本地真实 PostgreSQL 集成门禁。

## 发布风险

- 当前安全策略是后端任务入口规则，尚未覆盖结果级 PII 脱敏。
- 当前 live LLM 门禁还需要增加安全负例和 SQL 自修复负例。
- 前端 UI 仍按既定策略冻结，后续统一重建。
