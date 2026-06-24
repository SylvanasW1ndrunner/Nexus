# BetaV0.1.1 查询结果导出合同

## 背景

产品文档要求查询结果支持 CSV、Excel、JSON 导出，并且范围可以选择当前页、筛选结果或全表。此前只有 CSV/JSON 字符串 helper，且不理解“当前视图”的列筛选、搜索和分页状态。

## 本次实现

新增 `packages/shared/src/result-export.ts`：

- `exportQueryResult()`
  - 输入 `QueryExecutionResult` 和导出选项。
  - 支持 `csv`、`json`、`ndjson`、`excel-xml`。
  - 支持 `visibleColumnNames`、`searchText`、`offset`、`limit`。
  - 返回 `filename`、`mimeType`、`content`、`rowCount`、`columnCount`。
- 旧入口 `queryResultToCsv()`、`queryResultToJson()` 继续保留兼容行为。
- `excel-xml` 输出 Excel 兼容 SpreadsheetML XML 工作簿：
  - `Result` worksheet：导出的结果行。
  - `Metadata` worksheet：queryId、源行数、筛选后行数、导出行数、耗时、风险等级。
- CSV 和 Excel 兼容 XML 默认启用表格公式注入防护：
  - 文本值以 `=`、`+`、`-`、`@` 或制表/换行等公式前缀开头时，导出层会添加前置单引号。
  - 数字类型仍保持数值导出，避免负数被误处理成文本。
  - 可信内部导出可显式设置 `escapeSpreadsheetFormulas: false` 关闭防护；面向普通用户的入口应保持默认开启。

## 依赖决策

当前没有引入 `exceljs`、`xlsx` 或 SheetJS：

- 优点：不增加包体、不增加 Electron 打包和离线安装风险。
- 代价：当前不是原生 `.xlsx`，而是 Excel 可打开的 `.xls` XML 工作簿。
- 后续如必须原生 `.xlsx`，应单独做依赖评估和打包验证。

## 用户级场景

已覆盖：

- 用户导出完整查询结果为 CSV/JSON。
- 用户筛选 `enterprise` 后只导出当前可见列和当前页。
- 用户需要流式/下游处理时导出 NDJSON。
- 用户导出 Excel 兼容工作簿，并能看到结果和元信息。
- 文件名中含 Windows 非法字符时自动清洗。
- 用户打开 CSV/Excel 导出文件时，数据库里的恶意文本不会被表格软件当作公式执行。

## 测试

- `packages/shared/test/result-export.test.ts`
  - CSV/JSON 兼容。
  - 筛选视图 JSON 导出。
  - NDJSON 行导出。
  - Excel 兼容 XML 工作簿结构。
  - CSV/Excel 默认公式注入防护和可信导出关闭防护。
- `packages/shared/test/csv.test.ts`、`packages/shared/test/export.test.ts` 继续验证旧 helper。
