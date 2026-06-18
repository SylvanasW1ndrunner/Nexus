# BetaV0.1.1 - SQL 编辑器语句边界识别

## 背景

SQL 编辑器后续需要支持运行当前语句、运行选中语句、执行前审查、查询历史复现和 Agent 生成 SQL 后的安全检查。即使前端 UI 暂缓重建，后端也必须先提供稳定的语句拆分和光标定位能力。

## 变更

- 新增 `packages/core-db/src/sql-editor-statements.ts`。
- 提供 `splitSqlStatements()`，返回语句文本、语句类型、offset 范围、行列位置和分号终止位置。
- 提供 `findSqlStatementAtPosition()` 和 `findSqlStatementAtLineColumn()`，用于编辑器根据光标位置定位当前 SQL。
- 识别 PostgreSQL 常见词法边界：单引号、双引号、行注释、块注释、嵌套块注释和 dollar-quoted 函数体。
- `containsMultipleStatements()` 改为复用该拆分器，避免字符串字面量中的分号被误判为多语句。

## 开源评估

本切片不新增 SQL parser 依赖。评估结论：

- 当前目标是编辑器级语句边界识别，不需要完整 AST、SQL 改写或血缘分析。
- 小型词法状态机可以覆盖当前 PostgreSQL 编辑器场景，单元测试可直接验证边界。
- 不新增依赖可以避免许可证、包体、Electron 打包、离线安装和跨平台兼容风险。
- 后续如果要实现复杂 SQL AST、跨方言格式化、血缘分析或深度危险 SQL 识别，应重新评估成熟开源 parser，并在依赖评审文档中记录许可证和打包影响。

## 验证

- 新增 `packages/core-db/test/sql-editor-statements.test.ts`。
- 覆盖普通多语句、字符串内分号、双引号 identifier、PostgreSQL dollar quote 函数体、注释内分号、comment-only 输入、offset 光标定位、行列定位和安全检测回归。
