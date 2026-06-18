# BetaV0.1.1 Agent Checkpoint 持久化

## 范围

本次切片增强 `core-agent` 的长任务恢复能力，不涉及前端 UI。

新增能力：

- 新增 `AgentCheckpointStore`，用原子 JSON 写入保存 Agent iteration checkpoint。
- `ReactAgent` 支持可选 checkpoint store，在模型调用、工具调用、完成、中止和失败节点保存状态。
- `listRecoverable()` 返回每个 session 最新仍为 `running` 的任务，用于启动恢复扫描。
- `markInterrupted()` 支持启动时把异常退出遗留的 running 任务标记为 failed。

## 用户场景

- 用户让 Agent 执行多步分析时，工具失败会被记录，下一轮模型修正后最终完成。
- 应用异常退出后，主进程可以扫描 checkpoint，识别上次仍在 running 的任务。
- 已经完成、失败或中止的任务不会出现在恢复列表里，避免错误恢复。

## 测试

已覆盖：

- checkpoint 持久化和同一 iteration 更新。
- running checkpoint 恢复扫描。
- running checkpoint 标记为中断。
- 损坏 checkpoint JSON 降级为空列表，保证启动继续。
- ReactAgent 主循环中保存模型步骤、工具失败、工具成功和最终完成状态。

## 打包影响

无新增依赖。当前使用 Node.js 文件系统和原子 rename 写入，适合本地 beta 阶段。后续如果 Agent 会话量增大，应迁移到 SQLite WAL。
