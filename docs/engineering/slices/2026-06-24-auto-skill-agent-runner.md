# 2026-06-24 自动 Skill Agent Runner 切片

## 目标

把已经完成的 `core-skills` 自动匹配能力和 `core-tools` Skill Agent Runner 串起来，形成后端可调用的自动 Skill 执行入口。调用方只需要提供用户自然语言任务、当前可用工具策略和 Skill 列表，即可得到：

- 官方插件策略预检结果。
- Skill 匹配候选和缺失工具诊断。
- 自动生成的 Skill execution plan。
- 最终传给 Agent runtime 的工具白名单。

本切片不开发前端 UI，不新增 IPC，不调用真实 LLM，不执行真实数据库或 Python 进程。

## 实现范围

- `packages/core-tools/src/auto-skill-agent-runner.ts`
  - 新增 `runAutoSkillAgent()`。
  - 新增 `selectAutoSkillPlan()`。
  - 新增 `NoMatchingSkillError`。
- `packages/core-tools/src/index.ts`
  - 导出自动 Skill runner。
- `packages/core-tools/package.json` / `tsconfig.json`
  - 增加对 `@dbagent/core-skills` 的 workspace 依赖和 TS project reference。
- `packages/core-tools/test/auto-skill-agent-runner.test.ts`
  - 覆盖自动匹配、工具策略求交、缺失工具诊断和不执行 Agent 的失败路径。

## 设计逻辑

自动 runner 分两段处理权限：

1. 先调用 `resolveOfficialPluginAgentTools()`，用官方插件启用状态、运行时工具来源、只读策略等生成当前会话允许的工具全集。
2. 再调用 `createAutoExecutionPlan()`，只在官方插件策略允许的工具集合内匹配可执行 Skill。

因此 Skill 的 `allowedTools` 只能继续收窄工具权限，不能把插件策略禁用或运行时不存在的工具重新放出来。最终执行仍复用 `runSkillAgent()`，由 `ReactAgent.allowedTools` 和 `PermissionManager` 做运行时二次校验。

## 安全边界

- 缺少必要工具时抛出 `NoMatchingSkillError`，不调用 Agent。
- 诊断候选使用 `includeIneligible`，只用于解释，不作为执行授权。
- 自动匹配不读取密钥、不访问文件系统、不启动进程、不执行 SQL。
- 官方插件策略和 Skill 计划都会进入返回结果，便于后续 main service 和 IPC 做审计。

## 开源与依赖评估

本切片不引入第三方依赖。原因：

- 当前工作是内部 contract 组合，不是搜索、向量召回或 workflow 编排问题。
- `core-skills` 已提供确定性匹配器，继续复用可避免引入新的打包和授权风险。
- 后续如果 Skill 市场规模扩大，可以在 `core-skills` matcher 内部替换为成熟检索组件，而不改变 `runAutoSkillAgent()` 的公共契约。

## 测试

- 用户说“请生成昨日 GMV 日报，并写入工作区”时，自动命中 `daily_gmv_report`。
- 官方插件策略允许 `execute_sql`，但 Skill 未允许时，最终 Agent `allowedTools` 不包含 `execute_sql`。
- 显式信号能让“分析收入趋势”命中 Python 数据分析 Skill。
- 缺少 `workspace_script:run_python_analysis` 时不调用 Agent，并返回候选 Skill 的 `missingTools`。

## 后续

- 下一切片应实现 headless Agent service preflight，把 `skills:match` / `agent:tool-policy-preview` / `agent:run` 的 typed IPC 契约接上。
- 补充真实内置 Skill 文件加载后的自动匹配回归。
- 在 PostgreSQL / SiliconFlow / Python 进程门控测试中验证端到端用户路径。
