# BetaV0.1.1 Agent 恢复续跑

## 范围

本次增强 `core-agent` 的后端恢复能力，不涉及前端 UI 和多数据库。

新增能力：

- `AgentRecoveryService.continue()`：从可恢复 checkpoint 构建恢复计划，并把原 session 交给 Agent runner 继续执行。
- `ReactAgent.run({ initialSession, initialIteration })`：支持基于历史 session 续跑，并保持 checkpoint 迭代号连续。
- `AgentCheckpointStore.markCheckpointAbandoned()`：续跑成功后精确清理被接管的 checkpoint。
- `AgentSessionStore`：保存、读取、导出 session 时统一脱敏，避免恢复上下文泄露凭证。

## 用户价值

- 应用崩溃或 Agent 任务中断后，可以继续上次任务，而不是只能重新开始。
- 成功续跑不会重复提示旧恢复点。
- 续跑失败不会吞掉原恢复点，用户仍可再次尝试或选择重跑。
- 本地 session 历史、恢复文件和导出文件不会保存明文 API key、数据库密码或 token。

## 测试

已通过：

- `pnpm --filter @dbagent/core-agent lint`
- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-agent test`

测试覆盖：

- 恢复续跑成功路径。
- runner 抛异常时保留恢复点。
- `ReactAgent` 返回 `tool_failed` 时保留恢复点。
- `initialSession` 上下文保留和恢复提示追加。
- session 持久化、读取、JSON/Markdown 导出脱敏。

## 打包影响

无新增依赖。仅修改 TypeScript core 包和测试。

## 已知边界

- 当前仍是 ReAct runtime 的恢复续跑入口；未来 Plan-Execute 或插件化 Agent runner 需要补 strategy-neutral recovery payload。
- 当前 checkpoint/session 仍使用 JSON 原子写入；大量会话和并发写入场景后续应迁移到 SQLite WAL。
