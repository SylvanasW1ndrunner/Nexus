# DBAgent 开发技能索引

本文记录当前为“先完成功能，最后统一开发前端界面”的开发模式创建的项目技能。

技能文件位于仓库 `skills/` 目录，采用 Codex Skill 标准结构。当前先作为项目级开发规程纳入版本管理；如需全局自动启用，可同步到用户级 `~/.codex/skills`。

## 技能列表

### dbagent-feature-first-development

用于每次进入新功能开发前的总控流程。

核心约束：

- 先开发核心能力和后端服务，最后统一开发前端 UI。
- 不恢复旧 IDE UI、旧 Agent 面板、旧终端、旧登录弹窗。
- 先读相关产品文档，再实现代码。
- 文档使用中文。
- 有意义的开发切片需要测试和提交。

### dbagent-core-db-development

用于数据库 IDE 核心能力开发。

覆盖范围：

- PostgreSQL 驱动与连接池。
- 远程连接、超时、取消、重连。
- SQL 执行、事务、回滚、复杂 SQL。
- Schema 抽取、EXPLAIN、查询历史、结果导出。
- 未来多数据库接入接口。

### dbagent-auth-config-usage-development

用于认证、配置、用量和 LLM provider 骨架。

覆盖范围：

- 本地 PostgreSQL 用户存储。
- 注册、登录、验证码登录、忘记密码。
- 设置、连接配置、密钥存储。
- BYOK 与订阅托管模式分支。
- 本地用量记录。

### dbagent-schema-rag-development

用于 Schema RAG 开发。

覆盖范围：

- 元数据抽取。
- schema 文档化。
- 分阶段索引。
- FTS、向量检索、图扩展、混合召回。
- 每连接独立 RAG 存储。

### dbagent-agent-tooling-development

用于 Agent 运行时和工具系统开发。

覆盖范围：

- Agent Orchestrator。
- ReAct / Plan&Execute 等策略。
- Tool Registry。
- 权限管理。
- LLM Router。
- Session、Memory、Checkpoint。
- MCP 与内置工具。

### dbagent-workspace-python-release-development

用于工作区、Python、终端、插件化能力和发布验证。

覆盖范围：

- workspace 文件结构。
- Python system / venv / conda / embedded / docker 合约。
- Python 脚本运行、取消、超时。
- 终端进程服务。
- 工作区技能/插件发现。
- 打包、发布、诊断报告。

## 使用规则

1. 功能开发任务先触发 `dbagent-feature-first-development` 做方向校准。
2. 根据实际模块再触发一个具体技能。
3. 每个技能只保留必要流程，不复制完整产品文档，避免文档漂移。
4. 产品设计以 `docs/product/` 为准；技能只负责把开发流程固化。
5. 如果产品文档变更，优先更新产品文档，再同步调整技能。

## 后续维护

- 当某个模块进入稳定实现阶段，可以为其增加 `references/` 文件，沉淀更细的接口约定和测试矩阵。
- 当前不创建前端 UI 技能；等功能层完成后，再基于新的 UI 规格创建专门的前端重建技能。
- 如果后续启用插件市场或团队开发规范，可将这些技能拆分为团队共享包。
