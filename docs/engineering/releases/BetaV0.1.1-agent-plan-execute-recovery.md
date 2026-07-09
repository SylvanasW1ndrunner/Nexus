# BetaV0.1.1 Agent Plan & Execute 持久化恢复

## 变更

- 新增 Plan & Execute 执行快照 store。
- PlanExecuteAgent 支持执行过程自动保存计划进度。
- 支持从已有 plan、session、累计步骤数和累计 iteration 继续执行。
- 快照 store 支持 recoverable 列表、按 session 查询、abandon、坏文件降级和脱敏读取。

## 验证

- core-agent 类型检查、lint、全量测试通过。
- core-tools 类型检查通过。
- Agent/RAG 下游关键测试通过。
- 已重建 core-agent dist。

## 打包影响

- 无新增依赖。
- 无 native module 变化。
- 无 Electron 打包配置变化。

## 风险

- 当前恢复能力停留在 core 层，还未接入 desktop IPC 或最终 UI。
- 当前存储为 JSON 文件，后续大规模历史和并发写入应迁移到 SQLite WAL。
- 当前不支持计划 DAG、并行步骤和用户编辑计划后的差异合并。
