# BetaV0.1.1 Core Agent 运行时

## 背景

当前开发模式是功能优先，不开发前端 UI。Agent 是后续产品核心能力，因此需要先在 core 包里形成可测试的后端闭环。

## 本次实现

新增 `packages/core-agent`：

- `ReactAgent`
  - 接收用户消息。
  - 调用 `LlmRouter.chat()`。
  - 将 tool definitions 注入 LLM request。
  - 执行模型返回的 tool call。
  - 把 tool 结果写回 session messages。
  - 无 tool call 时输出最终结果。
- `ToolRegistry`
  - 注册内置工具。
  - 暴露 LLM tool schema。
  - 拒绝重复工具名。
- `PermissionManager`
  - 支持 `ask`、`auto`、`full-auto`、`readonly`。
  - `readonly` 拒绝非只读工具。
  - critical 工具即使在 full-auto 下也保留硬审批边界。
- `AgentSession`
  - 保存用户、助手、工具和系统消息。
  - 累计 token usage。
  - 记录工具执行状态。

## 当前边界

已实现：

- 最小 ReAct loop。
- 工具调用执行。
- 工具失败回传。
- 权限矩阵。
- round 级 usage 计数。

暂未实现：

- 前端 Agent 面板。
- 流式输出。
- Session SQLite 持久化。
- Plan&Execute。
- 子 Agent。
- MCP 工具加载。
- Context 压缩。

这些能力将在后续功能阶段继续补齐。

## 用户级测试场景

已覆盖：

- 用户询问订单总数时，Agent 调用只读查询工具，并返回最终业务回答。
- 用户在 readonly 模式要求删除数据时，Agent 在执行前拒绝，工具 handler 不触发。
- 用户要求写工作区文件时，ask 模式没有审批 provider，因此不会执行写入。
- SQL 工具第一次失败后，错误被回传给模型，下一轮可以修正 SQL 并完成。
- 权限矩阵覆盖 safe、medium、high、critical。

## 后续衔接

下一步应补：

1. `core-rag`：让 Agent 的 `search_schema`、`describe_table` 能接入真实 schema RAG。
2. Built-in DB tools：把 `core-db` 的 list/query/explain/history 封装成 Agent tool。
3. Agent Session Store：用本地 SQLite 或稳定文件存储保存会话与工具调用记录。
4. 流式事件：把 LLM delta、tool start、tool result、usage 变化暴露给未来 UI。
