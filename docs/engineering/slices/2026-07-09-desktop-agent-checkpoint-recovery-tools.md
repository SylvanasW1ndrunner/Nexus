# 2026-07-09 desktop Agent Checkpoint 恢复官方工具

## 开发范围

本切片完成 ReAct Agent checkpoint 的桌面持久化接线和官方工具化。目标是在前端 UI 冻结阶段，让后端 Agent 能读取可恢复 checkpoint、查看 session 内 iteration 记录、检查失败工具证据，并通过官方插件权限体系管理这些工具。

## 代码变更

- `apps/desktop/src/main/main.ts`
  - 新增 `data/agent-checkpoints.json`。
  - 创建 `AgentCheckpointStore` 和 `AgentRecoveryService`。
  - 将 `checkpointStore` 注入 `ReactAgent`。
  - 将 checkpoint store/recovery service 注入 `registerDesktopAgentTools()`。
- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - 新增 `list_recoverable_agent_checkpoints`、`list_agent_checkpoints`、`read_agent_checkpoint`。
  - 工具只依赖 checkpoint store 和 recovery service 的只读接口。
  - 工具详情返回做 final text、tool executions、session messages 截断。
- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增 `agent.checkpoint` resource scope。
  - 新增 `official.agent-checkpoint-recovery` manifest。
  - 新增 `agent.checkpoint.read` 权限和 3 个静态工具贡献。
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 增加真实临时文件 checkpoint 测试。
  - 覆盖恢复列表、按 session 列表、详情截断、权限解析。
- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 更新默认官方插件和静态工具贡献预期。

## 质量门禁

已执行：

- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json`
- `vitest run apps/desktop/src/main/agent-tool-bootstrap.test.ts packages/core-tools/test/official-plugin-registry.test.ts --passWithNoTests`
- `eslint` touched TS files

## 决策记录

- 本切片只开放只读工具，不开放恢复写动作。
- desktop 端正式接入 checkpoint store，使后续恢复工具读取真实运行数据。
- 没有引入第三方 checkpoint/tracing 依赖，继续复用现有 `ToolRegistry` 和官方插件 registry。

## 下一步

- 将 checkpoint/session/stream/plan 历史工具做统一 token-aware 裁剪。
- 后续恢复 UI 可基于这些只读工具和已有恢复 IPC 实现确认式继续、重启、放弃流程。
- 评估 checkpoint JSON 存储迁移到 SQLite WAL。
