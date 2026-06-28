# 2026-06-28 内置 Skill 注册切片

## 目标

上一切片已经提供无 UI 的 Agent service 和 typed IPC，但 desktop main 中的 Skill registry 仍为空。本切片补上第一批官方内置 Skill，并在主进程启动时注册，使 `skills:match` 后续具备实际候选来源。

本切片不接真实数据库工具、不执行 Python、不调用真实 LLM、不开发 renderer UI。

## 实现范围

- `packages/core-skills/src/builtin-skills.ts`
  - 新增 `createDefaultBuiltinSkills()`。
  - 新增 `registerDefaultBuiltinSkills()`。
  - 提供 5 个官方内置 Skill：
    - `generate_schema_doc`
    - `optimize_sql`
    - `daily_gmv_report`
    - `data_analysis`
    - `generate_er_diagram`
- `packages/core-skills/src/index.ts`
  - 导出 builtin Skill API。
- `apps/desktop/src/main/main.ts`
  - desktop main 启动时把默认内置 Skill 注册进 `SkillRegistry`。
- `packages/core-skills/test/builtin-skills.test.ts`
  - 验证默认 Skill 集合、clone 防污染和真实用户任务匹配。

## 设计逻辑

当前没有把 Skill 放到外部 YAML 资源目录，而是先使用纯 TypeScript 定义。原因：

- Electron 打包阶段已有 ASAR/文件裁剪规则，当前先避免新增资源复制链路。
- 内置 Skill 是产品契约的一部分，TS 定义可以被类型检查和单元测试直接覆盖。
- 后续如果转为 `resources/skills/*.yaml`，应保留 `createDefaultBuiltinSkills()` 作为稳定入口，由它负责加载资源并处理错误。

## 安全边界

- 内置 Skill 只声明任务流程和允许工具，不直接执行工具。
- `allowedTools` 仍会被官方插件策略和 `ReactAgent.allowedTools` 继续收窄。
- `data_analysis` 明确声明 `workspace_script:run_python_analysis`，因此缺少 Python runtime tool 时会保持不可执行并返回诊断。
- 每次获取默认 Skill 都返回 clone，调用方不能修改全局默认定义。

## 开源与依赖评估

本切片不引入外部依赖。内置 Skill 定义属于产品自身官方任务模板，不需要引入 workflow 框架、YAML 库或模板引擎。后续如果 Skill 数量扩大，可以在已有 `parseSkillDefinition()` 和 `loadSkillsFromDirectories()` 外面增加资源加载器，而不改变上层 service 入口。

## 测试

- 默认 Skill 名称和 source 稳定。
- 调用方修改返回对象不会污染下一次加载。
- “生成昨日 GMV 日报”能命中 `daily_gmv_report`。
- “SQL 为什么慢 / EXPLAIN / 优化查询”能命中 `optimize_sql`。
- “Python 建模预测并画趋势图”在工具齐全时能命中 `data_analysis`。

## 后续

- 为 desktop main 装配 DB/RAG/workspace/Python runtime tools。
- 接入用户级和工作区级 Skill 目录加载，并支持覆盖内置 Skill。
- 在真实 PostgreSQL 和 Python 子进程门控测试中验证内置 Skill 的完整用户路径。
