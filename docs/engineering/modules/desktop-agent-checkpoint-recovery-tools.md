# desktop Agent Checkpoint 恢复官方工具

## 模块目标

本模块把 ReAct Agent 的 iteration checkpoint 持久化数据注册为官方只读工具，使 Agent 和后续恢复 UI 能检查中断任务、查看每轮工具证据、定位最近失败，并形成 session、stream、plan、checkpoint 四类历史能力的统一官方工具面。

本模块同时把 `AgentCheckpointStore` 接入 desktop 主进程，使桌面端真实运行的 `ReactAgent` 会落盘 checkpoint。

## 工具清单

工具来源统一标记为：

- `source`: `official`
- `sourceId`: `official.agent-checkpoint-recovery`
- `dangerLevel`: `safe`
- `readonly`: `true`

当前注册工具：

- `list_recoverable_agent_checkpoints`: 列出可恢复的 ReAct checkpoint，支持 `sessionId`、`query`、`limit`。
- `list_agent_checkpoints`: 按 session 列出 iteration checkpoint 摘要。
- `read_agent_checkpoint`: 按 `sessionId + iteration` 读取 checkpoint 详情，返回 bounded final text、tool executions 和可选 session messages。

## 官方插件权限

`packages/core-tools/src/official-plugin-registry.ts` 新增：

- 插件 id: `official.agent-checkpoint-recovery`
- 分类: `agent`
- 权限: `agent.checkpoint.read`
- 资源范围: `agent.checkpoint`、`agent.session`
- 网络访问: `none`
- 进程访问: `none`
- secret 类型: `none`

这些工具会被 `resolveOfficialPluginAgentTools()` 识别，并参与只读模式、插件禁用、Skill allowlist 和权限快照。

## 桌面接线

`apps/desktop/src/main/main.ts` 新增：

- `data/agent-checkpoints.json`
- `AgentCheckpointStore`
- `AgentRecoveryService`

`ReactAgent` 初始化时注入 `checkpointStore`，因此桌面 Agent 的 ReAct loop 会在模型调用、工具调用、失败、完成等关键边界保存 checkpoint。

`apps/desktop/src/main/agent-tool-bootstrap.ts` 只接收只读接口：

- checkpoint store: `listBySession/listRecoverable`
- recovery service: `listRecoverablePlans`

工具层不会获得 `continue/abandon` 等写能力。

## 开源方案评估

本切片没有引入外部 checkpoint framework、workflow engine 或 tracing SDK。

原因：

- 当前目标是把已实现的 `AgentCheckpointStore` 和 `AgentRecoveryService` 接入 desktop 和 ToolRegistry。
- 现有 checkpoint store 已覆盖原子写入、运行中恢复、失败标记、放弃标记和脱敏。
- 外部 runtime 会增加打包风险和适配成本，不适合替换当前已验证的本地恢复合同。
- 官方插件 registry 已能表达本切片需要的权限和工具贡献。

后续如果需要跨进程 replay、分布式 trace 或云端恢复，再评估专用 tracing/eval 组件。

## 测试覆盖

测试入口：

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
- `packages/core-tools/test/official-plugin-registry.test.ts`

覆盖场景：

- 使用真实临时文件创建 `AgentCheckpointStore`。
- 保存 done 和 running 两类 iteration checkpoint。
- 通过 `list_recoverable_agent_checkpoints` 获取恢复计划摘要。
- 通过 `list_agent_checkpoints` 按 session 查询 checkpoint 摘要。
- 通过 `read_agent_checkpoint` 验证 final text、tool execution、session messages 的截断。
- 通过 `resolveOfficialPluginAgentTools()` 验证官方插件权限放行只读 checkpoint 工具。
- 更新默认官方插件 registry 测试，确保 manifest 和静态工具贡献被纳入默认解析。

## 已知限制

- 当前只读工具不执行继续或放弃恢复动作；写动作仍由服务层和未来 UI 确认。
- `read_agent_checkpoint` 通过 `sessionId + iteration` 定位 checkpoint，后续如需要跨 session 直接查 id，可在 store 增加只读 `load(checkpointId)`。
- 详情读取按字符和条数截断，还没有接入 token-aware budget。
- checkpoint store 当前仍使用 JSON 原子写入，长期应迁移到 SQLite WAL。
