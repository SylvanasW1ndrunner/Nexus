# 2026-07-08 Agent 恢复续跑切片

## 背景

当前开发路线是先完成后端核心能力，前端 UI 冻结。此前 `core-agent` 已经支持 checkpoint、恢复计划和放弃恢复，但“继续执行”仍停留在提示词层面，主进程无法直接把可恢复任务交回 Agent runtime 续跑。

本切片补齐无 UI 的后端恢复续跑能力，使崩溃或中断后的 Agent 任务可以基于原 session、原工具结果和恢复提示继续运行。

## 实现范围

- `ReactAgent.run()` 支持 `initialSession`，用于从已有会话上下文继续执行。
- `ReactAgent.run()` 支持 `initialIteration`，恢复续跑时 checkpoint 迭代号接着原中断轮次写入，而不是从 1 覆盖。
- `AgentRecoveryService.continue()` 新增后端续跑入口，通过通用 `AgentRecoveryRunner` 接口调用运行器，不直接绑定 `ReactAgent`。
- `AgentCheckpointStore.markCheckpointAbandoned()` 支持精确清理单个 checkpoint，避免按 session 粗粒度清理误伤并发或后续策略 checkpoint。
- `AgentSessionStore` 保存、读取和导出 session 时统一执行 Agent 脱敏规则，覆盖 assistant tool call 参数和 tool message 内容。

## 恢复语义

- 只有续跑结果为 `done` 时，原 running checkpoint 才会被标记为 `abandoned`，表示已经被成功接管。
- 如果续跑 runner 抛异常，原 running checkpoint 保持可恢复。
- 如果续跑返回 `tool_failed`、`aborted`、`quota_exceeded`、`permission_denied` 或 `max_iterations_reached` 等非完成状态，原 running checkpoint 会被刷新为最新可恢复点，启动恢复仍会提示用户。
- 恢复续跑不会原地修改传入的 `initialSession`，而是克隆后追加新的恢复 user message。

## 开源方案评估

本切片没有引入新的 Agent workflow 依赖。评估结论：

- LangGraph checkpoint 适合图执行和多策略 Agent，但当前切片目标是补齐现有 ReAct runtime 的恢复入口，引入后会扩大运行时、状态机和打包边界。
- Vercel AI SDK 更偏 provider/stream 抽象，不能直接表达 DBAgent 的工具权限、checkpoint、usage 和数据库连接状态。
- 当前选择在自有 `ToolRegistry`、`PermissionManager`、`AgentCheckpointStore` 之上补最小恢复续跑 adapter，保持 core 包轻量、离线可测、可打包。

后续实现 Plan-Execute、子 Agent 或插件化 Agent runner 时，应继续复核 LangGraph 等成熟项目，但第三方类型不能进入 DBAgent 稳定公共合同。

## 验收

- 恢复成功：running checkpoint 通过真实 `ReactAgent` 续跑完成，原 checkpoint 精确标记为 abandoned，新 checkpoint 写入下一轮迭代号。
- 续跑异常：runner 抛错时原恢复点仍在 `listRecoverablePlans()` 中。
- 续跑失败返回：`ReactAgent` 返回 `tool_failed` 时原 checkpoint 仍可恢复。
- 上下文保留：`initialSession` 历史消息进入下一次模型调用，新恢复提示作为新的 user message 追加。
- Secret 安全：session 文件、load、JSON 导出和 Markdown 导出均不包含 API key、Bearer token、数据库 URL 密码或 password 字段明文。

## 验证命令

```powershell
pnpm --filter @dbagent/core-agent lint
pnpm --filter @dbagent/core-agent typecheck
pnpm --filter @dbagent/core-agent test
```

验证结果：`core-agent` 13 个测试文件、79 个用例通过。

## 未做范围

- 不开发前端 UI。
- 不开发多数据库。
- 不接入真实 LLM 续跑，因为本切片验证的是恢复调度、checkpoint 和 session 安全；真实 LLM 行为继续由 Agent/RAG live eval 门控覆盖。
- 不迁移 checkpoint/session 到 SQLite WAL；当前仍使用 JSON 原子写入。
