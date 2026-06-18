# BetaV0.1.1 MCP 工具适配合同

## 范围

本次新增 `packages/core-tools/src/mcp-tool-adapter.ts`，把用户 MCP 和市场 MCP 暴露的 tool spec 归一成 `ToolRegistry` 可注册的 Agent 工具。该切片不启动 MCP 子进程、不接入 SDK、不开发前端 UI。

## 能力

- MCP 工具命名空间：`serverId__toolName`，避免不同 server 的同名工具冲突。
- 工具名清洗和长度限制：保证传给 LLM provider 的 tool name 不超过 64 字符，并对超长名称附加稳定 hash。
- 输入 schema 保留：保留 `type: object` 的 `properties` 和 `required` 等字段，无法识别时降级为空 object schema。
- 风险等级推断：
  - `readOnlyHint` 或 list/read/search/fetch/describe/query 类工具标记为 safe + readonly。
  - `destructiveHint` 或 delete/drop/update/write/shell/exec/run 等工具标记为 high + 非 readonly。
  - 未知市场 MCP 默认 high，未知用户 MCP 默认 medium。
- 调用隔离：
  - 调用前通过 `McpHealthManager.assertAvailable()` 检查 server 状态。
  - 调用时复用 `invokeMcpToolWithTimeout()`，卡死工具会按超时失败。
  - Agent 的 `AbortSignal` 会继续传入 MCP 调用。

## 用户价值

用户后续安装多个 MCP server 时，Agent 不应直接暴露第三方原始工具名和不明权限。该适配层让所有 MCP 工具进入统一 `ToolRegistry`，由现有 Agent 权限矩阵控制。readonly 模式下，安全读取类 MCP 可以执行；删除、写入、shell 类 MCP 会在第三方代码运行前被拒绝。

## 测试

新增 `packages/core-tools/test/mcp-tool-adapter.test.ts`，覆盖：

- MCP tool spec 到 Agent tool definition 的归一化。
- 用户 MCP、市场 MCP、readOnly/destructive 注解和工具名关键词的风险推断。
- 长工具名裁剪、hash 和名称冲突处理。
- 健康 MCP server 的工具调用能传回原始 tool name。
- 不健康 MCP server 在调用第三方代码前失败。
- 卡死 MCP 工具返回结构化超时错误。
- readonly Agent 可执行 readonly MCP 工具，但会在副作用发生前拒绝危险 MCP 工具。

## 已知边界

- 当前不负责 MCP `list_tools` 的协议调用，后续由 MCP Client Manager 提供 `McpToolSpec[]`。
- 当前不负责工具反注册；后续 server stop/restart 时需要由 MCP Client Manager 维护 registry 生命周期。
- 风险推断是保守启发式，未来应结合 MCP manifest、用户确认策略和市场安全标记继续增强。
