# BetaV0.1.1 自动 Skill Agent Runner

## 范围

本版本新增无 UI 后端入口：自动根据用户自然语言任务匹配 Skill，并在官方插件工具策略允许范围内调用 Agent runtime。

## 主要变更

- 新增 `runAutoSkillAgent()`，串联官方插件工具策略、Skill 自动匹配和现有 Skill Agent Runner。
- 新增 `selectAutoSkillPlan()`，可供后续 main service 或 IPC 做只读预检。
- 新增 `NoMatchingSkillError`，在缺少必要工具或没有可执行 Skill 时返回候选与缺失工具诊断。
- `@dbagent/core-tools` 增加对 `@dbagent/core-skills` 的 workspace 依赖。

## 验证

- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec eslint packages/core-tools/src/auto-skill-agent-runner.ts packages/core-tools/test/auto-skill-agent-runner.test.ts packages/core-tools/src/index.ts`
- `pnpm exec vitest run packages/core-tools/test/auto-skill-agent-runner.test.ts packages/core-tools/test/skill-agent-runner.test.ts --passWithNoTests`

## 已知边界

- 本切片仍未接入 Electron main service 和 typed IPC。
- 测试使用 recording agent，不消费真实 LLM 额度。
- 真实 PostgreSQL、真实 SiliconFlow、真实 Python 进程应放在下一阶段 headless service acceptance 中门控验证。
