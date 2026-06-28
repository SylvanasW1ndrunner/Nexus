# BetaV0.1.1 内置 Skill 注册

## 范围

本版本为 `core-skills` 增加第一批官方内置 Skill，并让 desktop main 启动时注册这些 Skill。

## 主要变更

- 新增 `createDefaultBuiltinSkills()` 和 `registerDefaultBuiltinSkills()`。
- 内置 Skill 覆盖 Schema 文档、SQL 优化、每日 GMV 日报、Python 数据分析和 ER 图说明。
- desktop main 的 `SkillRegistry` 不再为空。

## 验证

- `tsc -p packages/core-skills/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint packages/core-skills/src/builtin-skills.ts packages/core-skills/test/builtin-skills.test.ts apps/desktop/src/main/main.ts`
- `vitest run packages/core-skills/test --passWithNoTests`
- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-skills/test/builtin-skills.test.ts --passWithNoTests`

## 已知边界

- 真实工具注册仍未接入 main 的 `ToolRegistry`。
- 用户级/工作区级 Skill 目录加载还未接入 desktop main。
- 本切片不包含真实 LLM、PostgreSQL 或 Python 子进程验收。
