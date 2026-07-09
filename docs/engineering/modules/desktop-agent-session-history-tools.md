# desktop Agent 会话历史官方工具

## 模块目标

本模块把桌面端已经持久化的 Agent 会话历史和流式响应历史注册为官方只读工具，使后续 Agent 能在无正式前端 UI 的阶段直接读取历史上下文、审计上一轮执行、识别可恢复 stream，并为插件市场中的官方插件模式提供样板。

本模块不新增前端界面，不新增第三方依赖，不改变 `core-agent` 的持久化模型。

## 工具清单

工具来源统一标记为：

- `source`: `official`
- `sourceId`: `official.agent-session-history`
- `dangerLevel`: `safe`
- `readonly`: `true`

当前注册工具：

- `list_agent_sessions`: 按归档状态、关键词、分页列出本地 Agent session 摘要。
- `read_agent_session`: 读取单个 session 的基础信息、token 用量和最近消息，支持 `maxMessages` 截断。
- `export_agent_session`: 导出 session 为 `markdown` 或 `json`，支持 `maxChars` 截断，避免大上下文直接塞回模型。
- `list_agent_streams`: 按 session 列出 stream 摘要。
- `list_recoverable_agent_streams`: 列出 `streaming` 或 `incomplete` 的可恢复 stream。
- `read_agent_stream`: 读取单个 stream 的文本、tool calls、usage、错误信息，并可选返回最近 chunks。

## 官方插件权限

`packages/core-tools/src/official-plugin-registry.ts` 新增：

- 插件 id: `official.agent-session-history`
- 分类: `agent`
- 权限: `agent.session.read`
- 资源范围: `agent.session`
- 网络访问: `none`
- 进程访问: `none`
- secret 类型: `none`

这意味着这些工具可以被 `resolveOfficialPluginAgentTools()` 识别，并参与只读模式、插件禁用、Skill allowlist 和权限快照。

## 桌面接线

`apps/desktop/src/main/main.ts` 在注册桌面 Agent 工具时注入：

- `AgentSessionStore`
- `AgentStreamStore`

`apps/desktop/src/main/agent-tool-bootstrap.ts` 只依赖 store 的最小读接口：

- session: `list/load/export`
- stream: `listBySession/load/listRecoverable`

该边界避免工具注册层获取归档、删除、fork 等写能力。

## 开源方案评估

本切片没有引入 LangChain、LlamaIndex、OpenTelemetry tracing SDK 或外部会话数据库。

原因：

- 当前目标是把已有本地持久化能力注册到内部 `ToolRegistry`，不是重建 Agent runtime。
- 现有 `OfficialPluginRegistry` 已经提供插件权限、动态工具和运行时工具解析能力。
- 引入外部 Agent 框架会增加打包体积、类型适配、安全边界和 Windows 发行复杂度。
- 会话和 stream 数据已经经过本地脱敏持久化，直接复用现有 store 更符合当前 beta 阶段的风险控制。

后续如果做跨服务 tracing、可视化回放或云端协作，再评估专门的 tracing/eval 组件。

## 测试覆盖

测试入口：

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
- `apps/desktop/src/main/agent-service.test.ts`

覆盖场景：

- 使用真实临时文件创建 `AgentSessionStore` 和 `AgentStreamStore`。
- 保存业务会话后通过 `list_agent_sessions` 查询摘要。
- 通过 `read_agent_session` 验证消息截断和 omitted 计数。
- 通过 `export_agent_session` 验证导出截断。
- 创建 incomplete stream 后通过 `list_recoverable_agent_streams` 查询恢复候选。
- 通过 `read_agent_stream` 验证文本、chunk 计数和 chunks 返回。
- 通过 `resolveOfficialPluginAgentTools()` 验证官方插件权限能放行只读工具。

## 已知限制

- 当前工具只读，不提供 archive、delete、fork 等写操作；这些写操作仍通过桌面 IPC 服务控制。
- session/stream store 当前是 JSON 原子写入，长会话很多时后续应迁移到 SQLite WAL 或分文件索引。
- 工具返回内容做了截断，但还没有按 token 预算动态裁剪；后续可接入 Agent context budget。
