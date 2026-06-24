# BetaV0.1.1 三 Agent 并行开发治理

## 变更范围

- 新增三 Agent 并行开发治理文档，明确项目总工程师、开发者 Agent、项目架构师 Agent 和测试 Agent 的职责。
- 新增开发切片模板和用户级验收报告模板，后续功能切片按模板拆分、实现、测试和归档。
- 明确当前阶段继续执行功能优先、前端最后统一重建，不恢复旧 renderer IDE UI。
- 明确真实依赖测试门禁：PostgreSQL、Python/进程 IO、Agent/RAG live test、Electron 打包验证。
- 补充模块化和官方插件化规则：可进入插件市场的能力优先按官方插件候选设计，并走统一 Tool Registry、权限、审计和生命周期合约。
- 补充开源借鉴规则：复杂能力必须以该领域优秀开源项目为基准，记录可复用点、不可复用原因和 DBAgent 的优化扩展方向。
- 新增 `docs/engineering/slices/` 和 `docs/engineering/adr/`，用于沉淀开发切片记录和长期架构决策。
- 新增 M2+ 后端优先阶段模块边界文档，明确 RAG、Agent、MCP/plugin、Workspace/Python、Auth/Config/Usage 的后续职责边界。
- 修复打包验证脚本，使 `pnpm package:verify` 同时兼容 ASAR 和当前 `asar:false` 的 `resources/app` 目录产物。

## 验证方式

- 本变更为工程流程和文档变更，不修改运行时代码。
- 提交前执行文档 diff 检查和空白检查。

## 已知限制

- 本地 `BetaV0.1.1` 分支存在一个已提交但尚未成功推送的 autosave recovery 提交；首次推送因 GitHub HTTPS 连接重置失败，后续需要重试。
- 三 Agent 机制是开发流程约束，不替代真实测试和最终人工验收。
