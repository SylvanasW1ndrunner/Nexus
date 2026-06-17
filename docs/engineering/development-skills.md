# DBAgent 开发 Skill 索引

本文记录当前根据 `docs/product/` 产品文档建立的开发 skill。当前开发模式是：先完成非 UI 功能层，最后统一重建前端界面。

## 存放位置

当前可自动发现的 skill 位于用户级目录：

`C:\Users\cdnzx\.codex\skills`

这些 skill 用于后续开发过程的自动触发和流程约束。项目内本文档只记录用途、边界和维护规则，不复制完整 skill 内容。

## Skill 列表

### dbagent-product-backend-planning

用途：根据 `docs/product/` 制定后端功能开发切片、里程碑顺序、验收标准和下一步开发范围。

触发场景：
- 制定功能开发计划。
- 决定下一阶段先做哪个后端模块。
- 将产品文档转成可提交、可测试的小切片。

核心约束：
- 不做 renderer UI 重建。
- 每个切片必须包含业务场景、模块边界、公开契约、安全边界、测试和中文文档。

### dbagent-db-sql-rag-development

用途：开发数据库适配、PostgreSQL 连接、SQL 执行、SQL 审计、事务回滚、性能分析、Schema RAG。

触发场景：
- `core-db`、`core-rag`、数据库工具、SQL 历史、SQL 导出、真实 PG 集成测试。
- 远程数据库网络问题、超时、取消、重连、SSL/SSH 边界。

核心约束：
- PostgreSQL 优先，但接口必须为后续 MySQL/Oracle/ClickHouse 等扩展保留边界。
- 数据库行为必须有真实 PostgreSQL 测试，不只依赖 mock。
- RAG 按连接隔离，断开连接默认清理对应索引。

### dbagent-agent-tooling-development

用途：开发 Agent runtime、ReAct/Plan 策略、Tool Registry、Permission Manager、Session、Memory、Checkpoint、MCP、内置工具。

新增约束：
- Skill 触发的 Agent run 必须强制执行 `allowed_tools`，不能只写在 prompt 里。
- 即使模型返回隐藏或未授权工具调用，也必须在 runtime 拒绝。

### dbagent-classic-db-ide-development

用途：开发传统数据库 IDE 的确定性能力，包括 Schema 树、SQL 编辑/执行契约、结果集、表数据浏览/编辑、表设计器、导入导出、查询历史和结果快照。

触发场景：
- 实现不依赖 Agent/LLM 的数据库日常操作。
- 开发表格编辑、DDL 预览、事务提交/回滚、导出 CSV/Excel/JSON、导入向导服务。
- 定义命令面板、Tab、历史、结果快照等后端模型。

核心约束：
- AI 是叠加值，传统能力是基本盘；这些服务必须可由非 UI 调用方直接测试。
- 大结果集必须分页或流式处理。
- 表数据编辑必须先生成 SQL 预览，提交失败必须 rollback 并保留编辑状态。

### dbagent-auth-config-usage-development

用途：开发认证、配置、密钥、LLM Provider、BYOK/订阅分支、本地用量记录。

新增约束：
- 当前 UI 延后，但登录、注册、验证码、忘记密码、测试账号、PostgreSQL 本地账号库必须通过服务或 IPC 测试可调用。
- 密码只存 hash，不存明文。

### dbagent-config-provider-secrets-development

用途：开发配置、Provider、密钥、配置迁移、导入导出和 typed IPC 契约。

触发场景：
- 实现 settings、connections、mcp、LLM providers、session override 的加载/保存/迁移。
- 支持 DeepSeek/OpenAI/SiliconFlow/Ollama/vLLM/Anthropic 等 Provider 模板和检测。
- 处理 keychain 引用、敏感字段脱敏、配置备份恢复。

核心约束：
- 配置优先级固定为 `Session > Connection > User > Application Default`。
- 密码、API key、SSH passphrase、JWT 等只能存 secret backend/keychain，JSON 只保存 ref。
- IPC handler 必须是薄层，真实逻辑放在服务包。

### dbagent-mcp-plugin-market-development

用途：开发 MCP Client、MCP 进程管理、市场安装、插件式扩展点、官方插件/工具和第三方扩展边界。

触发场景：
- 对接 Smithery 或其他 MCP 市场。
- 将 MCP tool 转成内部 Tool Registry 工具。
- 实现 MCP server 安装、启动、停止、重启、健康检查、权限声明和审计。

核心约束：
- built-in tool、user MCP、market MCP、workspace script tool、未来 plugin 都必须归一到同一 Tool Registry。
- MCP 失败必须隔离，不能拖垮应用或其他工具。
- 安装流程必须把 secret 写入 keychain，只在配置中保留 ref。

### dbagent-resilience-recovery-development

用途：开发自动保存、崩溃恢复、长任务 checkpoint、取消/重试、诊断报告、原子写、SQLite WAL、DB/LLM/MCP/Python 容错。

触发场景：
- 实现 Agent checkpoint/resume、LLM stream 部分恢复、DB reconnect/cancel、MCP timeout/restart、Python 进程失败隔离。
- 处理配置损坏、磁盘写失败、autosave 恢复、诊断报告脱敏。

核心约束：
- 任何用户输入、Agent 中间产物和长任务状态都必须有持久化点或明确丢弃策略。
- 外部依赖失败应降级，不应让应用整体崩溃。
- 日志必须能定位问题且不含 secret。

### dbagent-workspace-python-release-development

用途：开发 workspace、Python runtime、脚本执行、终端进程服务、插件化扩展点、诊断与发布。

新增约束：
- 终端必须作为真实进程/session 服务实现，不是 renderer 文本框。
- 测试必须证明交互式 stdin/stdout 可用。
- Python 不假设全局 PATH 可用，必须支持显式解释器路径和运行时检测。

### dbagent-quality-gate-testing

用途：为每个后端功能切片建立测试、文档、发布验收闸门。

触发场景：
- 提交前验证。
- 版本发布前检查。
- 给新功能补测试矩阵。
- 判断某个功能是否达到可交付标准。

核心约束：
- 默认测试不能依赖真实密钥。
- 真实 LLM 测试只能在显式环境变量开启时运行。
- PostgreSQL、进程 IO、Python 执行、打包行为等风险点要有真实集成测试。
- 发布前必须检查中文文档、类型检查、测试结果、依赖打包影响和密钥扫描。

## 使用规则

1. 做开发计划时先使用 `dbagent-product-backend-planning`。
2. 进入具体模块后，叠加对应专项 skill。
3. 提交或发布前使用 `dbagent-quality-gate-testing`。
4. 产品文档是事实源，skill 只固化开发流程和工程边界。
5. 若 `docs/product/` 发生变化，先改产品文档，再同步更新 skill。

## 校验结果

已使用官方 `quick_validate.py` 校验以下 skill，全部通过：

- `dbagent-product-backend-planning`
- `dbagent-db-sql-rag-development`
- `dbagent-agent-tooling-development`
- `dbagent-classic-db-ide-development`
- `dbagent-auth-config-usage-development`
- `dbagent-config-provider-secrets-development`
- `dbagent-mcp-plugin-market-development`
- `dbagent-resilience-recovery-development`
- `dbagent-workspace-python-release-development`
- `dbagent-quality-gate-testing`
