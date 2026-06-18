# BetaV0.1.1 - SQL 片段管理

## 背景

产品文档要求 SQL 编辑器支持内置常用片段和用户自定义片段。前端 UI 暂缓重建，但片段能力应先形成后端合同，后续 Monaco 补全、命令面板、Agent 写 SQL 和项目模板都可以复用同一套片段定义。

## 变更

- 新增 `packages/core-db/src/sql-snippets.ts`。
- 提供内置片段：
  - `sel`
  - `ins`
  - `upd`
  - `del`
  - `cre-table`
  - `cre-idx`
- 新增 `SqlSnippetStore`，支持用户片段创建、更新、删除、搜索、按 trigger 解析和本地 JSON 原子持久化。
- 新增 `expandSqlSnippet()`，支持 `{{variable}}` 模板变量、默认值、缺失变量提示和执行审查 warning。
- 禁止用户覆盖内置触发词，避免 Tab 展开行为不稳定。

## 开源评估

本切片不新增第三方 snippet/template 依赖。当前能力只是轻量模板替换和 JSON 持久化，使用本地实现更容易保证离线可用、打包稳定和行为可测。

如果后续需要兼容 VSCode snippet 语法、Monaco snippet controller 或复杂光标占位，应优先评估 Monaco/VSCode 现有 snippet grammar 与开源实现，再决定适配或复用。

## 验证

- 新增 `packages/core-db/test/sql-snippets.test.ts`。
- 覆盖内置片段、变量展开、自定义片段持久化、重启后读取、搜索、更新、删除、损坏 JSON 降级、非法 trigger 和禁止覆盖内置 trigger。
