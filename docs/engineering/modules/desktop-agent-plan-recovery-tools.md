# desktop Agent Plan 恢复官方工具

## 模块目标

本模块把 Plan & Execute 的持久化快照和恢复摘要注册为官方只读工具，使 Agent 能在后端阶段直接检查中断计划、查看执行证据、定位失败步骤，并为后续恢复 UI 和插件市场官方能力提供稳定接口。

本模块不开放继续、重启、放弃等写操作。这些动作仍保留在桌面服务和后续 UI 决策层，避免 Agent 工具绕过用户确认改变恢复状态。

## 工具清单

工具来源统一标记为：

- `source`: `official`
- `sourceId`: `official.agent-plan-recovery`
- `dangerLevel`: `safe`
- `readonly`: `true`

当前注册工具：

- `list_recoverable_agent_plans`: 列出 `running` 状态的可恢复 Plan & Execute 任务，支持 `sessionId`、`query`、`limit`。
- `list_agent_plan_executions`: 按 session 列出 Plan & Execute 快照摘要，覆盖完成、失败、运行中和放弃状态。
- `read_agent_plan_execution`: 读取单个 Plan & Execute 快照，返回计划步骤、最终文本、最近工具调用证据、可选 session 消息，并对大字段做截断。

## 官方插件权限

`packages/core-tools/src/official-plugin-registry.ts` 新增：

- 插件 id: `official.agent-plan-recovery`
- 分类: `agent`
- 权限: `agent.plan.read`
- 资源范围: `agent.plan`、`agent.session`
- 网络访问: `none`
- 进程访问: `none`
- secret 类型: `none`

这些工具会被 `resolveOfficialPluginAgentTools()` 识别，并参与只读模式、插件禁用、Skill allowlist 和权限快照。

## 桌面接线

`apps/desktop/src/main/main.ts` 在注册桌面 Agent 工具前创建：

- `AgentPlanExecutionStore`
- `PlanExecuteRecoveryService`

`apps/desktop/src/main/agent-tool-bootstrap.ts` 只接收只读接口：

- plan snapshots: `load/listBySession/listRecoverable`
- recovery summaries: `listRecoverablePlans`

工具层不会获得 `continue/restart/abandon` 能力。

## 开源方案评估

本切片没有引入外部 workflow runtime、checkpoint framework 或 tracing SDK。

原因：

- 当前能力是对已有本地 `AgentPlanExecutionStore` 和 `PlanExecuteRecoveryService` 的只读适配。
- 现有官方插件 registry 已能表达权限、资源范围和运行时工具匹配。
- 外部 runtime 适合更上层的编排能力，不适合替换当前已经落地的 Plan & Execute 持久化合同。
- 不新增依赖可以降低 Windows/Linux 打包风险。

后续如果需要跨进程 tracing、可视化 replay 或云端协作，再评估 OpenTelemetry、LangSmith 类平台或自建 adapter。

## 测试覆盖

测试入口：

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
- `packages/core-tools/test/official-plugin-registry.test.ts`

覆盖场景：

- 使用真实临时文件创建 `AgentPlanExecutionStore`。
- 保存包含 done/running 步骤、成功和失败 tool evidence 的 running plan snapshot。
- 通过 `list_recoverable_agent_plans` 获取可恢复计划和恢复动作。
- 通过 `list_agent_plan_executions` 按 session 查询计划摘要。
- 通过 `read_agent_plan_execution` 验证 final text、tool execution、session messages 的截断。
- 通过 `resolveOfficialPluginAgentTools()` 验证官方插件权限放行只读 plan 工具。
- 更新默认官方插件 registry 测试，确保 manifest 和静态工具贡献被纳入默认解析。

## 已知限制

- 当前只读工具不执行恢复动作；恢复动作仍需要桌面服务或后续 UI 调用。
- 读取详情时按字符和条数截断，还没有接入 token-aware budget。
- Plan snapshot 当前仍使用 JSON 原子写入，后续大量历史数据应迁移到 SQLite WAL 或分文件索引。
