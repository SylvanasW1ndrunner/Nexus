# core-tools 工具与诊断模块

## 代码入口

- `packages/core-tools/src/db-tools.ts`：数据库相关 Agent 工具注册。
- `packages/core-tools/src/workspace-tools.ts`：工作空间文件读写与列表工具。
- `packages/core-tools/src/workspace-script-tools.ts`：工作空间脚本注册为 Agent tool。
- `packages/core-tools/src/workspace-sandbox.ts`：工作空间路径边界检查。
- `packages/core-tools/src/diagnostic-report.ts`：诊断报告生成和脱敏规则。
- `packages/core-tools/src/validation.ts`：工具参数校验 helper。

## 诊断报告逻辑

`diagnostic-report.ts` 是纯后端合同，不依赖 Electron，也不直接读取本机文件。调用方把应用版本、运行时信息、配置文本、日志文本和崩溃快照传入，模块返回可打包的文件列表：

- `manifest.json`：应用版本、运行时、生成时间、保留窗口和单条大小上限。
- `configs/*`：脱敏后的配置。
- `logs/*`：脱敏后的最近日志。
- `crash/*`：脱敏后的崩溃快照。

当前模块不直接生成 zip。主进程后续负责从实际日志目录收集文件、调用该模块生成报告，再写出 zip 或目录。这样脱敏规则可以在单元测试中独立验证，不和 Electron 文件选择、压缩库或 UI 混在一起。

## 脱敏规则

诊断报告默认执行以下脱敏：

- `sk-...` 形态 API key。
- `Bearer ...` token。
- JSON 或 env 形态的 `apiKey`、`password`、`token`、`secret` 等字段。
- JSON 或 env 形态的 `sql` / `query` 字段。
- 日志中直接出现的 `SELECT`、`INSERT`、`UPDATE`、`DELETE`、`DROP`、`ALTER`、`CREATE` SQL 片段。

日志默认只保留生成时间前 7 天内的条目；没有时间戳的条目会保留，因为它们仍可能对用户反馈有用。单条内容默认最多保留最后 512KB，避免巨大日志导致报告不可上传，同时保留最近错误上下文。

## 测试覆盖

- `diagnostic-report.test.ts`：报告 manifest、配置/日志/崩溃快照收集、敏感字段脱敏、SQL 内容脱敏、旧日志忽略、未知时间日志保留、大日志截尾、路径清理。
- `workspace-tools.test.ts`：工作空间工具的真实文件读写和越界路径拦截。
- `workspace-script-tools.test.ts`：脚本声明发现和真实子进程 runner 注入。
- `workspace-sandbox.test.ts`：路径白名单和逃逸判断。
- `db-tools.test.ts`：数据库工具注册和安全边界。

## 已知边界

- 当前诊断报告返回内存中的文件列表，后续主进程需要接入 zip 写入和日志目录扫描。
- SQL 脱敏使用保守文本规则，会牺牲部分 SQL 上下文；这是诊断报告的刻意选择，优先保护用户数据。
- 二进制 crash dump 当前按文本处理；真正接入系统 dump 时需要在主进程层做大小限制和二进制附件策略。
