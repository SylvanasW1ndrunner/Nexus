# BetaV0.1.1 - SQL 编辑器执行目标解析

## 背景

产品文档要求 SQL 编辑器支持运行选中、运行光标处语句、运行整文件和运行并 EXPLAIN。前端 UI 暂缓重建，但后端必须先形成统一合同，避免未来 renderer、主进程快捷键、命令面板和 Agent 工具各自解析选择区与光标语句。

## 变更

- 新增 `packages/core-db/src/sql-editor-execution-target.ts`。
- `resolveSqlEditorExecutionTarget()` 接收文档全文、选择区、光标、连接能力和只读状态。
- 输出 `sourceSql`、`executableSql`、编辑器 range、`QueryRequest` 和 `SqlExecutionPlan`。
- 支持四类模式：
  - `selection`：运行用户选中的 SQL。
  - `current-statement`：根据光标定位当前语句。
  - `full-file`：运行整份 SQL 文件并保留多语句执行前审查。
  - `explain-current-statement`：对当前读语句生成 PostgreSQL `EXPLAIN` 请求。
- `EXPLAIN ANALYZE` 默认只允许读语句，避免用户以为只是看计划但实际执行写操作。

## 开源评估

本切片不新增依赖。执行目标解析属于产品合同组合逻辑，复用已有 `sql-editor-statements` 和 `sql-execution-plan` 即可。引入完整 SQL parser 对当前目标收益有限，且会增加许可证、包体、离线安装和 Electron 打包风险。

后续如果实现跨方言 AST、SQL 格式化、血缘分析或复杂语义重写，需要重新按 `dbagent-dependency-packaging-review` 评估成熟开源 parser。

## 验证

- 新增 `packages/core-db/test/sql-editor-execution-target.test.ts`。
- 覆盖用户真实路径：选中 UPDATE、光标运行第二条 SELECT、行列光标定位 DELETE、整文件多语句确认、EXPLAIN 当前读查询、非 analyze EXPLAIN、拒绝写语句 EXPLAIN、空选择和光标在语句间隙。
