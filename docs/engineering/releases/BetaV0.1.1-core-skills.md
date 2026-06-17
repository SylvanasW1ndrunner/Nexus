# BetaV0.1.1 Core Skills

## 背景

Skill 是 DBAgent 的三个差异化支柱之一：流程化复用、工作区沉淀、Agent 自动化。当前阶段不做前端 Skill 编辑器，但必须先有可测试的核心 Skill 解析和加载能力。

## 本次实现

新增 `packages/core-skills`：

- `parseSkillDefinition()`
  - 支持 JSON。
  - 支持产品文档中使用的 YAML 子集。
  - 支持多行 `system_addition`。
  - 支持 `allowed_tools`、`steps`、`natural_language_keywords`、`auto_inject_when` 列表。
- `SkillRegistry`
  - 注册 Skill。
  - 按名称获取 Skill。
  - 过滤当前可用工具。
  - 生成执行计划。
- `loadSkillsFromDirectories()`
  - 按目录加载 `.yaml`、`.yml`、`.json`。
  - 支持内置、用户级、工作区级来源。
  - 后加载来源覆盖同名 Skill。
  - 单个坏 Skill 不影响其他 Skill 加载。

## 用户级测试场景

已覆盖：

- 内置 `daily_gmv_report.yaml` 风格 Skill 能被解析。
- Agent 保存出来的 JSON Skill 能被解析。
- 用户级 Skill 可以覆盖内置同名 Skill。
- 工作区级 Skill 可以与用户级 Skill 合并加载。
- 一个坏 Skill 文件只产生错误记录，不会让整个工作区 Skill 系统不可用。
- Skill 执行计划只暴露当前可用工具，避免运行时请求不存在的工具。
- 默认参数可以渲染进用户输入，例如 `{date}`。

## 当前边界

已实现：

- Skill 定义、解析、校验。
- Skill 注册和加载。
- 工具授权过滤。
- 执行计划生成。

暂未实现：

- 完整 YAML 规范。
- Skill 执行器与 `ReactAgent` 的直接集成。
- `save_session_as_skill` 自动生成器。
- 内置 Skill 文件打包。
- Skill 市场。

下一步应将 `core-skills` 接入 `core-agent`，让 Agent 可以根据 Skill 构造 mini-session，并把 `allowed_tools` 应用到 Tool Registry。
