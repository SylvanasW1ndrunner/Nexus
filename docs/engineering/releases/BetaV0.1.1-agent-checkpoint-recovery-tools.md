# BetaV0.1.1 Agent Checkpoint 恢复官方工具

## 版本内容

本次为 BetaV0.1.1 增加一组官方只读 Agent 工具，用于读取 ReAct Agent checkpoint 和恢复状态。

新增能力：

- desktop `ReactAgent` 正式持久化 checkpoint 到 `data/agent-checkpoints.json`。
- Agent 可列出可恢复 checkpoint。
- Agent 可按 session 查看 iteration checkpoint 历史。
- Agent 可读取单个 checkpoint 的状态、工具证据、最终文本和有限 session 上下文。
- 这些工具纳入官方插件 manifest 和权限策略。

## 验证结果

通过：

- desktop 工具注册相关测试。
- 官方插件 registry 测试。
- `core-tools` TypeScript 检查。
- `apps/desktop` TypeScript 检查。
- touched TS 文件 ESLint。

## 发行风险

- 只读工具不执行恢复动作，正式 UI 中仍需单独设计继续、重启、放弃的确认流程。
- 详情读取当前按字符和条数截断，后续应接入 token-aware budget。
- 持久化仍基于 JSON 原子写入，长期应迁移到 SQLite WAL。
