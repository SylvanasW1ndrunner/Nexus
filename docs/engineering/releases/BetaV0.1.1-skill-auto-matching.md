# BetaV0.1.1 Skill 自动匹配能力

## 范围

本次切片为 `core-skills` 增加后端确定性 Skill 自动匹配能力，用于让后续 Agent service 根据用户自然语言任务、显式信号、可用工具集合和 Skill 元数据生成候选 Skill 与自动执行计划。

本次不开发前端 UI，不调用 LLM，不直接执行 Skill。

## 主要变更

- 新增 `skill-matcher.ts`，提供 `findMatchingSkills()`、`createAutoExecutionPlan()` 和 `inferSkillSignals()`。
- 扩展 Skill 类型，增加匹配候选、匹配原因、匹配选项和自动执行计划类型。
- `SkillRegistry` 增加自动匹配与自动执行计划入口，便于后续 Agent service 集成。
- 默认过滤缺失声明工具的 Skill，避免自动注入无法执行的流程。
- 支持诊断模式 `includeIneligible`，可用于显示候选被过滤的原因。

## 测试

- 增加真实用户任务风格的匹配测试：
  - 生成昨日 GMV 日报。
  - 使用 Python 建模预测 GMV 并生成趋势图。
  - 缺失工具时默认不返回候选，并在诊断模式暴露缺失工具。
  - Registry 自动执行计划会应用默认输入和工具顺序。
  - Schema 文档、SQL 优化、多步 pipeline 等标准信号推断保持稳定。

## 发布风险

- 当前 matcher 是轻量确定性规则，不替代后续 Skill 市场的大规模搜索或排序系统。
- 后续如果 Skill 数量增长，应保持当前接口不变，在 adapter 内接入成熟搜索或排序组件。
- 自动匹配只生成计划，不授予工具权限；最终执行仍必须经过官方插件策略、Agent 工具白名单和权限边界。
