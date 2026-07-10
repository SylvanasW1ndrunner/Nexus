# 2026-07-10：Agent 工具策略预检报告

## 背景

当前官方插件、Skill 自动执行、MCP 动态工具和 Agent runtime allowlist 已经形成基础链路，但缺少一份统一的机器可读预检报告。后续 UI、插件市场和发布验收需要清楚知道：哪些工具会暴露给 Agent、哪些被拦截、为什么拦截、哪些需要审批、哪些会接触 secret 或进程。

## 本轮实现

- 新增 `buildAgentToolPolicyReport()`。
- `runSkillAgent()` 返回 `toolPolicyReport`。
- `runAutoSkillAgent()` 返回 `preflightToolPolicyReport` 和最终 `toolPolicyReport`。
- `NoMatchingSkillError` 增加 `preflightToolPolicyReport`，便于缺工具诊断。
- `PermissionManager` 增加完整权限矩阵测试。

## 行为说明

- 报告层只做预检和审计，不替代执行门禁。
- Skill allowlist 与官方插件策略仍取交集。
- 动态 MCP / workspace script 工具仍必须通过官方动态贡献匹配。
- 模型返回隐藏工具时，`ReactAgent` 继续硬拒绝。

## 验证

- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-tools typecheck`
- `pnpm exec vitest run packages/core-agent/test/permission-manager.test.ts packages/core-tools/test/agent-tool-policy-report.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts packages/core-tools/test/skill-agent-runner.test.ts packages/core-tools/test/auto-skill-agent-runner.test.ts --pool=forks`
- `pnpm --filter @dbagent/core-agent test`
- `pnpm --filter @dbagent/core-tools test`
- `pnpm exec eslint ... --max-warnings=0`

## 后续

- Desktop headless Agent 接入真正 approval provider。
- 恢复 Skill 任务时保留原始 Skill allowlist。
- 增加真实 LLM negative gate：真实模型尝试写操作或隐藏工具时必须被拒绝且无副作用。
