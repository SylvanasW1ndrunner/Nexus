# core-tools Agent 工具策略预检报告

## 模块目标

本模块把官方插件策略、Skill `allowed_tools`、运行时工具注册状态和 Agent 权限矩阵汇总成一个可机器读取的预检报告。它服务于后续插件市场、Skill 自动执行、Agent 任务恢复和发布验收，不依赖最终前端 UI。

核心目标：

- 在 Agent 运行前明确哪些工具会暴露给模型。
- 说明工具被插件策略或 Skill allowlist 拦截的原因。
- 暴露工具所需权限、审批策略、网络访问、进程访问、secret 类型和审计级别。
- 预判当前 Agent mode 下哪些工具会自动 allow、ask 或 deny。
- 为后续 UI、日志、诊断报告和 release gate 提供同一份稳定数据结构。

## 代码入口

- `packages/core-tools/src/agent-tool-policy-report.ts`
  - `buildAgentToolPolicyReport(policy, options)`：从 `OfficialPluginAgentToolPolicy` 生成报告。
  - `allowedTools`：包含工具来源、权限快照、自动决策和审批需求。
  - `blockedTools`：包含 `blockedBy=plugin|skill`、原因和 runtime 来源。
  - `missingStaticTools`：列出官方静态工具贡献但当前运行时未注册的工具。
  - `summary`：提供允许工具数、阻断数、高风险工具、需要审批工具、secret 类型等聚合字段。
- `packages/core-tools/src/skill-agent-runner.ts`
  - `runSkillAgent()` 返回 `toolPolicyReport`。
- `packages/core-tools/src/auto-skill-agent-runner.ts`
  - `runAutoSkillAgent()` 返回 `preflightToolPolicyReport` 和最终 `toolPolicyReport`。
  - `NoMatchingSkillError` 携带 `preflightToolPolicyReport`，便于缺工具时给出诊断。
- `packages/core-agent/test/permission-manager.test.ts`
  - 固化 `ask/auto/full-auto/readonly` 与 `safe/medium/high/critical` 的权限矩阵。

## 策略边界

报告层不替代执行层门禁：

- 模型可见工具仍由 `ToolRegistry.llmTools(allowedTools)` 控制。
- 模型即使返回未允许工具，`ReactAgent` 仍会在执行前拒绝。
- 是否能实际执行由 `PermissionManager` 和 tool handler 的 `approval` provenance 决定。
- 报告只描述和预判，不直接授予权限。

## 开源方案评估

本轮未新增依赖。

评估过的方向：

- Open Policy Agent：适合跨服务、跨语言的通用策略决策，但当前切片只处理 DBAgent 内部工具注册、官方插件 manifest 和 Skill allowlist 的组合报告。引入 OPA 会增加策略语言、运行时和打包复杂度。
- Casbin：适合 RBAC/ABAC 权限模型，但 DBAgent 当前权限决策依赖工具危险等级、readonly、插件权限元数据、审批来源和 Agent mode，使用本地类型化函数更直接。
- OpenTelemetry：适合 tracing 和运行时观测，但当前需求是策略预检报告，不是分布式 trace。后续可以把报告 ID 或 summary 写入 trace attribute。

结论：本轮选择自研轻量报告层，保持类型稳定和 Electron 打包简单。后续如出现跨服务策略同步或组织级权限模型，再评估 OPA/Casbin adapter。

参考：

- Open Policy Agent: https://www.openpolicyagent.org/
- Casbin: https://casbin.org/
- OpenTelemetry: https://opentelemetry.io/

## 测试覆盖

- `packages/core-tools/test/agent-tool-policy-report.test.ts`
  - 汇总 allowed/blocked/missing static 工具。
  - 校验审批需求、secret、网络/进程访问、审计级别。
  - 校验 readonly mode 对写工具的 deny 预判。
- `packages/core-tools/test/skill-agent-runner.test.ts`
  - Skill 与官方插件策略取交集后返回 `toolPolicyReport`。
- `packages/core-tools/test/auto-skill-agent-runner.test.ts`
  - 自动匹配成功时返回 preflight/final 报告。
  - 缺工具失败时错误对象包含 preflight 报告。
- `packages/core-agent/test/permission-manager.test.ts`
  - 表驱动覆盖 mode x danger-level x readonly 的权限矩阵。

## 已知限制

- 当前 desktop 入口还没有真正的用户审批 UI；ask/auto 需要审批的工具如果没有 approval provider，仍不会执行。
- 报告可展示 `approvalPolicy`，但执行层仍以 `PermissionManager` 的 mode/danger/readonly 决策为准。
- 任务恢复路径还需要进一步保留原始 Skill allowlist，避免恢复时工具面变宽。
