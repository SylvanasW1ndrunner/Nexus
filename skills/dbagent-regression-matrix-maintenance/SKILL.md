---
name: dbagent-regression-matrix-maintenance
description: Use when creating or updating DBAgent/Nexus cross-module regression matrices, milestone acceptance checklists, user-scenario test coverage, real dependency gates, or release readiness evidence during backend-first development.
---

# DBAgent 回归矩阵维护

用于把产品文档中的里程碑、真实业务场景和当前实现状态转成可执行的验收矩阵。目标是防止功能只在单测里可用，却无法支撑真实用户工作流。

## 适用场景

- 完成一个后端切片后，需要记录它覆盖了哪些用户场景。
- 准备版本发布、beta 包、版本分支或 release 文件夹。
- 新增真实依赖测试，例如 PostgreSQL、Python、终端、MCP、LLM Provider。
- 修复线上或验收反馈问题，需要补回归用例。

## 输入来源

- 路线和里程碑：`docs/product/00-overview.md`、`docs/product/05-development-guide.md`。
- 模块场景：`docs/product/02-rag-design.md`、`03-agent-design.md`、`06-classic-features.md`、`08-workspace-design.md`、`10-usage-and-subscription.md`。
- 恢复要求：`docs/product/09-error-recovery.md`。
- 已有测试：`packages/*/test/`、`apps/desktop/src/**/__tests__` 或同级测试文件。
- 工程记录：`docs/engineering/modules/`、`docs/engineering/releases/`。

## 矩阵字段

每条验收项至少记录：

- 场景 ID：稳定编号，例如 `DB-SQL-001`。
- 用户任务：真实用户要完成的动作。
- 涉及模块：core 包、main service、IPC、持久化或外部系统。
- 验收入口：core API、service、IPC、fixture、脚本或打包 smoke。
- 成功断言：输出、状态、事件、持久化和日志。
- 失败断言：无效输入、权限拒绝、超时、取消、网络/进程故障。
- 真实依赖：PostgreSQL、Python、shell、MCP、LLM、文件系统、打包产物。
- 自动化状态：已自动化、环境门控、手动、缺口。
- 证据：测试文件、命令、release note 或 issue。

## 维护规则

- 默认以真实业务路径组织，不按内部函数名组织。
- 涉及 SQL 的场景必须包含复杂查询、事务、回滚、权限和性能风险。
- 涉及进程的场景必须包含 stdin/stdout、非零退出、超时、取消和大输出。
- 涉及凭证的场景必须证明不会进入 renderer、日志、快照或错误消息。
- 如果缺少自动化，写明环境门控或手动验证步骤，不能留空。

## 输出模板

```markdown
| ID | 用户任务 | 模块 | 验收入口 | 成功断言 | 失败断言 | 真实依赖 | 自动化状态 | 证据 |
|---|---|---|---|---|---|---|---|---|
```
