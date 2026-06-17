# BetaV0.1.1 查询结果视图共享契约

## 背景

结果表的列筛选和搜索逻辑此前位于 renderer 纯函数中。当前开发阶段暂停 UI 重建，但结果区能力后续会被多个后端/服务路径复用：结果表显示、导出筛选结果、结果快照、IPC 分页和 Agent 引用结果集。如果每条路径各自过滤，会导致用户看到的数据和导出的数据不一致。

## 本次实现

新增 `packages/shared/src/query-result-view.ts`：

- `createQueryResultView()`
  - 根据 `QueryExecutionResult` 生成稳定视图。
  - 支持可见列、搜索词、offset、limit。
  - 输出总行数、过滤后行数、当前页行。
- `resolveVisibleResultColumns()`
  - 至少保留一列，避免空列集合。
- `toggleResultColumnVisibility()`
  - 保持列切换行为稳定。
- `filterResultRows()`
  - 只在当前可见列中搜索。
- `formatResultCell()`
  - 统一 Date、Buffer、JSON、bigint、空值等搜索格式。

`apps/desktop/src/renderer/src/result-table.ts` 改为从 `@dbagent/shared` 重新导出这些纯函数，保持现有调用兼容，不做 UI 改造。

## 测试

- `packages/shared/test/query-result-view.test.ts`
  - 可见列解析。
  - 列切换不允许空列集合。
  - 只在可见列内搜索。
  - 过滤后分页。
  - Date、Buffer、JSON 格式化。
- 保留 `apps/desktop/src/renderer/src/result-table.test.ts`，验证 renderer 兼容导出仍满足旧行为。

## 验收价值

后续导出 CSV/Excel/JSON、结果快照和 IPC 分页可以直接复用 `createQueryResultView()`，避免前端显示结果与后端导出结果不一致。
