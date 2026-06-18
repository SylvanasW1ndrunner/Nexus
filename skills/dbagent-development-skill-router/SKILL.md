---
name: dbagent-development-skill-router
description: Use when starting or triaging DBAgent/Nexus development work from docs/product and deciding which existing DBAgent development skills, product documents, tests, and documentation gates should be applied while frontend UI work is deferred.
---

# DBAgent 开发 Skill 路由

用于在开始一个 DBAgent/Nexus 开发任务前选择正确的开发流程。此 skill 不替代模块 skill，而是负责快速路由，避免遗漏产品文档、测试门槛和当前“先功能、后前端”的约束。

## 当前开发模式

- 先完成所有后端、核心服务、IPC 合同、测试夹具、真实依赖验证。
- 暂不重建 renderer UI；旧 IDE UI、旧 Agent 面板、旧终端 UI 不作为验收入口。
- 所有新增工程文档、模块文档、测试说明和 release note 先用中文。
- 每个切片都要能脱离最终 UI 通过 core API、main service、typed IPC、测试夹具或脚本验证。

## 路由规则

按任务目标选择最少必要 skill：

- 规划下一步开发：`dbagent-product-backend-planning`、`dbagent-slice-design`。
- 执行一个后端切片：`dbagent-feature-first-development`、`dbagent-backend-slice-execution`。
- 数据库、SQL、RAG：`dbagent-db-sql-rag-development`、`dbagent-schema-rag-development`、`dbagent-classic-db-ide-development`。
- Agent、工具、LLM、MCP：`dbagent-agent-tooling-development`、`dbagent-mcp-plugin-market-development`、`dbagent-config-provider-secrets-development`。
- 认证、配置、用量、订阅：`dbagent-auth-config-usage-development`。
- 工作空间、Python、终端、打包：`dbagent-workspace-python-release-development`。
- 错误恢复、诊断、安全：`dbagent-resilience-recovery-development`、`dbagent-observability-diagnostics-development`、`dbagent-security-boundary-review`。
- 接口和 IPC：`dbagent-contract-ipc-development`。
- 测试和验收：`dbagent-quality-gate-testing`、`dbagent-real-integration-testing`、`dbagent-headless-capability-validation`、`dbagent-regression-matrix-maintenance`。
- 文档同步：`dbagent-docs-sync-development`、`dbagent-module-doc-authoring`。
- 版本提交和发布：`dbagent-release-version-discipline`、`dbagent-dependency-packaging-review`。

## 文档入口

只读取和任务相关的产品文档：

- 总路线：`docs/product/00-overview.md`、`docs/product/05-development-guide.md`。
- 数据库与传统 IDE：`docs/product/06-classic-features.md`。
- Schema RAG：`docs/product/02-rag-design.md`。
- Agent、工具、Skill、MCP：`docs/product/03-agent-design.md`。
- 配置、Provider、密钥：`docs/product/04-config-design.md`。
- 工作空间和 Python：`docs/product/08-workspace-design.md`。
- 错误恢复：`docs/product/09-error-recovery.md`。
- 登录、用量、订阅：`docs/product/10-usage-and-subscription.md`。

## 开始任务前

1. 运行 `git status --short --branch`，确认未提交改动范围。
2. 明确用户场景、所属模块、对外合同、安全边界、测试入口。
3. 选择对应 skill 并读取其 `SKILL.md`。
4. 若涉及新依赖，先执行依赖/打包影响评估。
5. 若涉及真实系统风险，先定义环境门控和真实依赖测试。

## 输出

给出简短路由结果：

```markdown
使用 skill：

来源文档：

开发切片：

必须验证：

不做范围：
```
