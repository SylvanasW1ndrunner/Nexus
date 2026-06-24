# 2026-06-24 Skill 自动匹配切片

## 目标

补齐 `core-skills` 的自动匹配能力，让后续 Agent service 可以根据用户自然语言任务找到合适 Skill，而不是只能由 UI 或命令显式指定 Skill。本切片不调用 LLM、不开发前端、不执行 Skill，只生成候选和执行计划。

## 实现范围

- `packages/core-skills/src/types.ts`
  - 新增 `SkillMatchOptions`、`SkillMatchCandidate`、`SkillMatchReason`、`SkillAutoExecutionPlan` 等类型。
- `packages/core-skills/src/skill-matcher.ts`
  - 新增 `findMatchingSkills()`。
  - 新增 `createAutoExecutionPlan()`。
  - 新增 `inferSkillSignals()`。
- `packages/core-skills/src/skill-registry.ts`
  - `SkillRegistry.findMatchingSkills()`。
  - `SkillRegistry.createAutoExecutionPlan()`。
- `packages/core-skills/src/index.ts`
  - 导出 matcher。

## 匹配语义

候选评分来源：

- `natural_language_keywords` 命中：高权重。
- `auto_inject_when` 与显式或推断信号命中：中高权重。
- Skill `name` / `title` / `description` 与用户输入相关：辅助权重。
- `allowed_tools` 与当前可用工具集合求交集；默认缺少任意声明工具时，该 Skill 不进入候选。

当前确定性信号推断覆盖：

- `requires_visualization`：可视化、图表、趋势图、plot、chart。
- `requires_python`：Python、脚本、pandas、机器学习、建模等。
- `requires_modeling`：预测、聚类、分类、回归、训练等。
- `requires_multi_step_pipeline`：ETL、pipeline、清洗、特征工程、自动化报告等。
- `requires_schema_documentation`：schema 文档、表结构文档、数据字典、字段说明等。
- `requires_sql_optimization`：SQL 优化、EXPLAIN、慢查询、query plan 等。

## 安全边界

- 自动匹配只产生候选和执行计划，不执行 Agent，不注册工具，不放权。
- Skill 的 `allowed_tools` 仍然只是任务级收窄条件；最终工具白名单必须继续经过官方插件策略和 `ReactAgent.allowedTools`。
- 默认过滤掉缺失工具的 Skill，避免自动注入一个实际不可执行的流程。
- `includeIneligible` 只用于诊断，不应直接执行。

## 开源与依赖评估

本切片未引入外部依赖。评估结论：

- 当前任务是轻量规则匹配与候选排序，不需要引入搜索引擎、向量库或 Agent workflow 框架。
- 复用 Fuse.js 等 fuzzy search 库可以增强模糊匹配，但会引入新的打包和调参成本；当前产品文档定义了明确的关键词和信号字段，确定性实现更适合作为第一版后端合同。
- 后续如果 Skill 市场规模扩大，可把当前 matcher 保持为 adapter 外壳，再接入成熟搜索/排序组件。

## 测试

- `skill-matcher.test.ts`
  - 真实用户任务“生成昨日 GMV 日报”命中日报 Skill。
  - “Python 建模预测并画趋势图”通过推断信号命中数据分析 Skill。
  - 缺少 workspace script 工具时默认不返回 Python Skill，并可通过诊断看到 missing tools。
  - `SkillRegistry.createAutoExecutionPlan()` 会应用 defaults 并保留工具顺序。
  - 标准信号推断稳定。

## 验证记录

- `pnpm exec tsc -p packages/core-skills/tsconfig.json --noEmit`
- `pnpm exec eslint packages/core-skills/src/skill-matcher.ts packages/core-skills/src/skill-registry.ts packages/core-skills/src/types.ts packages/core-skills/test/skill-matcher.test.ts`
- `pnpm exec vitest run packages/core-skills/test --passWithNoTests`
  - 3 个测试文件通过。
  - 13 个用例通过。

## 后续

- Agent service 入口接入 `SkillRegistry.findMatchingSkills()`，把候选 Skill 作为可观测诊断事件输出。
- 自动命中 Skill 后，继续通过 `core-tools` 的 Skill Agent Runner 执行，避免绕过官方插件工具策略。
- 后续内置 Skill 文件打包后，应补充真实内置 Skill 的自动匹配回归测试。
