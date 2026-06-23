# BetaV0.1.1 Agent 恢复服务

## 范围

本次切片增强 `core-agent` 的崩溃恢复服务能力，不涉及前端 UI。

新增能力：

- 新增 `AgentRecoveryService`。
- 将 running checkpoint 转成恢复计划，包含原始任务、中断 iteration、成功/失败/拒绝工具数量、最近 assistant 文本、最近工具错误和可用动作。
- 生成确定性的 `resumePrompt`，用于后续“继续执行”入口恢复上下文。
- 支持 `abandon()`，将用户放弃恢复的 running checkpoint 标记为 `abandoned`，避免应用下次启动反复提示。
- `AgentCheckpointStore` 新增 `markAbandoned()`，保留 finishedAt、updatedAt 和用户放弃原因。

## 用户场景

- 应用异常退出后，主进程可以扫描 Agent checkpoint，并展示“上次任务执行到第几轮、哪些工具成功、哪里失败、是否继续/重跑/放弃”。
- 用户选择放弃恢复后，该任务不再出现在可恢复列表里。
- 续跑提示词会提醒 Agent 复用已完成工具结果，避免无理由重复查询或重复执行脚本。

## 开源评估

候选方向：

- LangGraph checkpoint / persistence：适合完整图执行引擎。
- Vercel AI SDK tool calling + stream persistence：适合 provider/stream 层，但不直接覆盖 DBAgent 的工具权限和数据库连接状态。
- 自研轻量恢复计划：适合当前已有 ReAct loop、checkpoint store、permission manager 和 typed tool registry。

本次选择自研恢复计划层。原因是当前目标不是替换 Agent runtime，而是在已有 checkpoint 基础上补齐启动恢复决策合同；引入图框架会改变主循环、工具权限、用量和测试结构，超出当前切片范围。后续若实现 Plan&Execute 或多 Agent 图执行，再重新评估 LangGraph 等成熟方案。

## 测试

已覆盖：

- running checkpoint 生成恢复计划。
- 恢复计划包含用户任务、iteration、工具成功/失败/拒绝数量、最近 assistant 文本和工具错误。
- `resumePrompt` 不包含被 checkpoint store 脱敏的 API key。
- abandon 后可恢复列表为空，checkpoint 状态变为 `abandoned`。
- 多个恢复计划按更新时间倒序排列。

## 打包影响

无新增依赖。仅新增 TypeScript 服务层和测试。

## 已知边界

- 当前不会自动重新调用模型或工具。真正“继续执行”需要主进程在用户确认后重建 provider、tool registry、permission provider、活动连接和 workspace 上下文。
- 当前 checkpoint 仍是 JSON 文件，后续大量会话和并发写入应迁移到 SQLite WAL。
