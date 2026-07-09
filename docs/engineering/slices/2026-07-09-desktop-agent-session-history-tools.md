# 2026-07-09 desktop Agent 会话历史官方工具

## 开发范围

本切片完成 Agent 会话历史和 stream 历史的官方工具化。目标是在前端 UI 冻结阶段，让后端 Agent 能通过统一工具注册体系读取本地会话、导出上下文、检查可恢复 stream，并验证这些工具进入官方插件权限治理。

## 代码变更

- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - 新增 session/stream 只读工具注册。
  - 工具输入做基础类型校验、分页限制、文本和 chunk 截断。
  - 工具注册 metadata 标记为 `official.agent-session-history`。
- `apps/desktop/src/main/main.ts`
  - 调整 `AgentSessionStore` 和 `AgentStreamStore` 初始化顺序。
  - 将两个 store 注入 `registerDesktopAgentTools()`。
- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增 `agent` 官方插件分类。
  - 新增 `official.agent-session-history` manifest。
  - 新增 `agent.session.read` 权限和 6 个静态工具贡献。
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 增加真实临时文件持久化测试。
  - 覆盖工具调用、恢复 stream、导出截断和官方插件权限解析。

## 质量门禁

已执行：

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json`
- `vitest run apps/desktop/src/main/agent-tool-bootstrap.test.ts --passWithNoTests`
- `vitest run apps/desktop/src/main/agent-service.test.ts --passWithNoTests`

## 决策记录

- 没有引入外部 Agent runtime 或 tracing 框架；当前能力属于内部 store 到内部 tool registry 的薄适配。
- 工具只开放读能力，不开放写能力，避免 Agent 在只读模式下改变历史数据。
- 返回内容默认截断，避免 Agent 读取历史时把过大的 stream 或 session 直接塞回模型上下文。

## 下一步

- 将 Plan & Execute recovery 也纳入官方只读工具，便于 Agent 自查可恢复计划。
- 对 Agent 工具结果统一接入 token budget 裁剪策略。
- 后续 UI 重建时直接复用这些工具或 IPC 服务，不需要重新实现历史查询逻辑。
