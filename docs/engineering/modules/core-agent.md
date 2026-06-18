# core-agent Agent 执行模块

## 代码入口

- `packages/core-agent/src/react-agent.ts`：ReAct Agent 主循环，负责模型调用、工具调用、权限检查、用量归因和终止状态。
- `packages/core-agent/src/checkpoint-store.ts`：Agent iteration checkpoint 持久化，用于崩溃后识别可恢复任务。
- `packages/core-agent/src/session.ts`：会话、消息和 usage 累加工具。
- `packages/core-agent/src/tool-registry.ts`：Agent 工具注册表，暴露 LLM tool schema。
- `packages/core-agent/src/permission-manager.ts`：工具权限决策。
- `packages/core-agent/src/types.ts`：Agent 会话、消息、工具、运行选项和结果类型。

## 开发逻辑

`core-agent` 不依赖 Electron，不直接访问数据库、文件系统 UI 或密钥。它通过 `LlmRouter` 调模型，通过 `ToolRegistry` 调业务工具，通过 `UsageTracker` 记录用量。具体工具能力由 `core-tools`、`core-db`、工作空间模块或后续 MCP adapter 提供。

当前主循环是 ReAct：

1. 创建 session，写入用户消息。
2. 检查 subscription quota。
3. 启动 usage round。
4. 调用模型生成 assistant message 和 tool calls。
5. 对每个 tool call 做 allowedTools、权限和注册状态检查。
6. 执行工具，把 tool result 写回 session。
7. 继续下一轮，直到模型无 tool call、达到迭代上限、用户中止、权限拒绝或配额耗尽。

## Checkpoint 策略

`AgentCheckpointStore` 使用 JSON 文件原子写入保存 checkpoint。每条 checkpoint 包含：

- session id、iteration、status。
- 当前 session 快照。
- 已执行工具记录。
- finalText、错误信息、startedAt、updatedAt、finishedAt。

`ReactAgent` 的 checkpoint store 是可选依赖。传入后会在以下节点保存：

- 每轮模型调用前：`running`。
- 模型返回 assistant message 后：`running`。
- 每个工具成功、失败或拒绝后：`running`。
- 最终完成、权限拒绝、迭代上限、token budget 触发后：`done`。
- 用户中止：`aborted`。
- provider 或主循环异常：`failed`。

`listRecoverable()` 只返回每个 session 最新 checkpoint 为 `running` 的任务。已完成、已失败或已中止的 session 不会出现在可恢复列表里，避免应用重启后错误提示用户恢复已结束任务。`markInterrupted()` 用于启动扫描时把上次异常退出遗留的 running checkpoint 标记为 failed。

## 权限边界

- readonly 模式下，非 readonly 工具在执行前被拒绝。
- ask 模式下，中高危工具需要 approval provider；没有 approval provider 时不会执行。
- allowedTools 是技能/工作流的硬白名单，即使工具已注册也不能越权调用。
- 工具失败会作为 tool message 回传给模型，允许下一轮自我修正。

## 测试覆盖

- `permission-manager.test.ts`：不同模式和工具危险级别下的权限决策。
- `checkpoint-store.test.ts`：checkpoint 原子持久化、同一 iteration 更新、可恢复任务列表、running 标记中断、损坏 JSON 降级。
- `react-agent.test.ts`：只读数据库工具调用、只读模式写操作拦截、ask 模式未授权拦截、工具失败后模型恢复、allowedTools 白名单、subscription quota 拦截、用户中止、provider 失败不计费、checkpoint 与 Agent 主循环集成。

## 已知边界

- 当前 checkpoint 使用 JSON 文件，适合本地 beta 阶段；大量会话和并发写入场景应迁移到 SQLite WAL。
- 当前只实现任务恢复所需的状态识别，不自动续跑中断任务；续跑策略需要后续 session manager 和 UI 恢复入口配合。
- 当前不实现多 Agent 协作调度。
