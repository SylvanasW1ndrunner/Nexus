# BetaV0.1.1 导入向导后端计划

## 范围

本次新增 `core-db` 的导入向导后端合同，用于支撑产品文档中的“选择源 → 解析预览 → 字段映射 → 执行选项 → 批量执行”。本次不包含前端 UI，也不直接读取本地文件。

## 功能

- 新增 `parseCsvImportPreview()`。
- 新增 `parseJsonImportPreview()`。
- 新增 `buildImportExecutionPlan()`。
- CSV 支持：
  - 分隔符。
  - 引号。
  - 首行表头。
  - 预览行数。
  - 引号内逗号。
- JSON 支持：
  - 单对象。
  - 对象数组。
  - 嵌套值预览为 JSON 字符串。
- 执行计划支持：
  - INSERT。
  - UPSERT。
  - TRUNCATE 后 INSERT。
  - 字段映射。
  - 默认值。
  - 空值跳过。
  - 批大小。
  - 单事务/分批事务。
  - abort/skip 错误策略声明。

## 安全边界

- 导入值全部进入 `params`，不拼接进 SQL。
- schema、table、target column、conflict column 使用 PostgreSQL identifier quote。
- `truncate-insert` 的 `TRUNCATE` 放入 `preludeSql`，调用方必须在用户确认后执行。
- UPSERT 必须显式提供 conflict columns。
- skip-on-error 当前只返回 warning，具体行级重试由执行器后续实现。

## 测试

- `packages/core-db/test/import-plan.test.ts`
  - CSV 表头、引号、预览截断。
  - JSON 对象数组和嵌套值预览。
  - 批量 INSERT 参数。
  - UPSERT SQL。
  - TRUNCATE prelude。
  - 非法 UPSERT 拦截。
  - malformed CSV/JSON 拦截。

## 限制

- 当前只实现 CSV 和 JSON 源；Excel、SQL 文件源后续作为 Import Provider 扩展。
- 当前执行计划只生成 SQL 和参数，不负责进度事件、真实执行、行级失败重试。
- 真实 PostgreSQL 导入 round trip 需要本地或远程测试库可用后补充集成测试。
