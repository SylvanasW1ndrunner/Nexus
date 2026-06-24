# shared 契约与导出模块

## 代码入口

- `packages/shared/src/domain.ts`：跨进程共享的领域模型，例如连接、查询结果、Schema 结构和安全报告。
- `packages/shared/src/ipc.ts`：Renderer、preload、main 共同遵守的 IPC channel 与 request/response map。
- `packages/shared/src/result.ts`：统一 `Result<T>`、`AppError` 和错误码。
- `packages/shared/src/csv.ts`：查询结果导出 CSV。
- `packages/shared/src/export.ts`：查询结果导出 JSON。
- `packages/shared/src/query-result-view.ts`：查询结果可见列、搜索过滤、分页视图和单元格格式化。
- `packages/shared/src/result-export.ts`：查询结果导出统一合同，支持 CSV、JSON、NDJSON 和 Excel 兼容 XML 工作簿。
- `packages/shared/src/index.ts`：包级导出边界。

## 开发逻辑

`shared` 是应用最稳定的契约层。主进程和 renderer 只能通过这里定义的数据结构对齐，避免 UI 依赖主进程内部类、数据库 driver 实例或异常对象。

新增功能时先判断是否跨进程。如果功能只在 renderer 内使用，不应放进 IPC 契约；如果主进程需要返回给 UI，必须先在 `domain.ts` 或 `ipc.ts` 中定义稳定结构，再由具体模块实现。

查询执行合同支持调用方传入 `queryId`。未来 UI、Agent 或命令入口如果需要取消长 SQL，必须在发送 `db:execute-query` 前生成 query id，并用同一个 id 调用 `db:cancel-query`。`db:cancel-query` 当前返回取消决策：优先 backend cancel、降级断开当前连接、查询已结束或未找到。真实 PostgreSQL backend cancel 由 main/driver 后续切片执行，shared 只暴露稳定跨进程结构。

错误处理统一走 `Result<T>`。业务可恢复错误使用 `AppErrorCode`，例如远程连接失败、只读连接拦截、危险 SQL 需要确认。这样 renderer 可以写可测试的错误提示逻辑，而不是解析数据库驱动的原始异常文本。

结果导出 helper 放在 `shared`，原因是导出格式依赖 `QueryExecutionResult` 的稳定结构，但不需要访问 DOM、文件系统或数据库连接。CSV 面向表格工具，JSON 面向审计、复现和后续 Agent 上下文复用。JSON 导出保留 `queryId`、`rowCount`、`elapsedMs`、`columns`、`rows` 和 `safety`，并把 `Date`、`bigint`、`Buffer` 和嵌套对象规范化为可序列化值。

查询结果视图 helper 也放在 `shared`，而不是 renderer。原因是列显示、搜索、分页和导出范围都会依赖同一套规则：如果 UI、导出服务和后续 IPC 分页各自实现，会出现“屏幕上看到的数据”和“导出的数据”不一致。`createQueryResultView()` 输入完整 `QueryExecutionResult` 和可见列、搜索词、offset、limit，输出稳定的视图结构，供结果表、导出和测试复用。

`exportQueryResult()` 在视图合同之上生成导出制品，返回文件名、MIME、内容、导出行数和列数。默认导出完整列；如果调用方传入 `visibleColumnNames`、`searchText`、`offset`、`limit`，则严格导出当前视图。Excel 当前实现为 SpreadsheetML XML（`.xls`），包含 `Result` 和 `Metadata` 两个 worksheet。它能被 Excel/WPS/LibreOffice 打开，且不引入 `exceljs`/`xlsx` 等依赖，避免当前阶段增加包体和 native/打包风险。后续如果产品验收明确要求原生 `.xlsx`，需要单独评估依赖许可证、包体、离线安装和 Electron 打包影响。

CSV 和 Excel 兼容 XML 默认启用表格公式注入防护：当真实数据库文本值以 `=`、`+`、`-`、`@` 或制表/换行等可被表格软件解释为公式的前缀开头时，导出层会在文本前加单引号。数字类型保持数值单元格，不会因为负数被错误转成文本。可信内部流程如确需原样导出，可显式传入 `escapeSpreadsheetFormulas: false`，但面向普通用户的入口应保持默认开启。

## 测试覆盖

- `packages/shared/test/csv.test.ts`：覆盖逗号、引号、换行、对象值和 `NULL`。
- `packages/shared/test/export.test.ts`：覆盖 JSON metadata、列顺序、`Date`、`bigint`、`Buffer` 和嵌套对象。
- `packages/shared/test/query-result-view.test.ts`：覆盖可见列至少保留一列、列切换、仅在可见列内搜索、分页视图、Date/Buffer/JSON 单元格格式化。
- `packages/shared/test/result-export.test.ts`：覆盖旧 CSV/JSON helper 兼容性、筛选视图导出、NDJSON、Excel 兼容 XML 工作簿、文件名清洗、元信息 worksheet、CSV/Excel 默认公式注入防护和可信导出关闭防护。
- `packages/shared/test/ipc-contract.test.ts` 覆盖 IPC 契约：运行时快照固定 M0-M1.5 channel 集合，编译期断言保证 `IpcRequestMap` 和 `IpcResponseMap` 键集合一致。新增 channel 时必须同步更新该测试，避免 renderer、preload 和 main 只改一侧；当前包含 `db:cancel-query`。

## 后续扩展

- 多数据库接入时，查询结果结构仍应保持数据库无关，数据库特有字段放入可选 metadata，而不是污染通用行数据。
- 未来导出 Excel、Parquet 或审计包时，优先在 `shared` 增加纯函数格式化逻辑；涉及文件系统或压缩包写入时再交给 main。
