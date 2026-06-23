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
- `workspace-script-tools.test.ts`：脚本声明发现、真实 Python runner、参数校验、非零退出、超时 kill、AbortSignal 取消、stdout/stderr 截断。
- `workspace-sandbox.test.ts`：路径白名单和逃逸判断。
- `db-tools.test.ts`：数据库工具注册和安全边界。

## Workspace Python Runner

`workspace-script-tools.ts` 现在提供 `runWorkspacePythonScript()`，作为无 UI 的真实脚本执行合同。它使用 Node 原生 `child_process.spawn` 启动 Python，不新增打包依赖。

运行请求包含：

- `rootPath` 与 `relativePath`：脚本必须通过 `resolveInsideWorkspace()` 落在工作空间托管目录内，并且当前只接受 `.py` 文件。
- `args`：序列化为 JSON，作为脚本第一个参数传入，供工作空间脚本 tool 读取。
- `pythonPath`：可选解释器路径；未配置时使用 `python`，后续主进程应从工作空间 Python 配置传入。
- `pythonArgs`：可选解释器前置参数，例如 conda env name 会解析为 `conda run -n <env> python`。
- `env`：可选环境变量覆盖；凭证只能由主进程运行时注入，不进入脚本文件或 workspace 配置。
- `timeoutMs`：超时后先发终止信号，2 秒后仍未退出则强制 kill。
- `signal`：Agent 或上层服务取消时终止子进程。
- `outputLimitBytes`：stdout/stderr 只保留尾部，避免大输出污染 Agent 上下文。

失败语义：

- 退出码为 0：返回 `WorkspaceScriptRunResult`。
- 非零退出、超时或取消：抛出 `WorkspaceScriptExecutionError`，错误对象携带结构化 `result`，包含 stdout、stderr、退出码、耗时、截断标记、`timedOut` 或 `aborted`。
- 错误 message 使用中文，并保留 stderr 尾部，便于 Agent 或调用方根据错误继续修复脚本。

当前 runner 是进程级隔离与输出控制，不是完整系统沙箱。网络禁用、内存限制、依赖安装策略和数据库连接注入仍由后续 Python runtime / 主进程能力补齐。

## 已知边界

- 当前诊断报告返回内存中的文件列表，后续主进程需要接入 zip 写入和日志目录扫描。
- SQL 脱敏使用保守文本规则，会牺牲部分 SQL 上下文；这是诊断报告的刻意选择，优先保护用户数据。
- 二进制 crash dump 当前按文本处理；真正接入系统 dump 时需要在主进程层做大小限制和二进制附件策略。
- Python runner 当前只负责进程启动、取消、超时和输出限制；还未实现 conda/venv 自动创建、依赖安装、资源配额或系统级网络隔离。

## Schema RAG 工具组合

`registerDatabaseTools()` 在传入 `rag` 时会复用 `core-agent` 的 `registerSchemaRagTools()` 注册 RAG 工具，并启用 `skipExistingTools`，避免与数据库工具包已有的 `list_tables`、`describe_table` 重名。

组合后的默认工具集合为：

- 数据库实时工具：`list_schemas`、`list_tables`、`describe_table`、`query_database`、`execute_sql`。
- RAG 工具：`search_schema`、`get_relations`。
- 兼容工具：`build_schema_context`，保留给已有测试和后续 IPC/Agent 调试入口。

因此 Agent 的默认 schema 浏览仍可以使用产品文档中的 `list_tables` / `describe_table` 名称；当需要模糊检索、业务术语或关系扩展时使用 `search_schema` / `get_relations`。这避免了同一 registry 中出现重复 tool name，也让 live DB introspection 与本地 RAG 各自承担清晰职责。

## Agent/RAG 业务验收测试

`packages/core-tools/test/agent-rag-business-scenario.test.ts` 是当前 Agent + Schema RAG 的无 UI 验收入口。它构造真实风格业务域：

- 电商：`customers`、`products`、`orders`、`order_items`、`refunds`。
- 流量分析：`analytics.traffic_sessions`、`analytics.page_views`、`analytics.campaign_spend`。
- 脏数据结构：`analytics.raw_evt`，无主键且字段缩写。

测试覆盖：

- RAG 按“GMV / 退款率 / ROI / 转化漏斗 / 加密手机号”等真实分析问题召回正确表和字段。
- Agent 在 readonly 模式下先调用 `search_schema`，再调用 `query_database`，最终回答渠道 GMV、退款率和 ROI。
- Agent 收到 destructive SQL 工具调用时，在 driver 执行前被权限系统拒绝。
- `DBAGENT_RUN_POSTGRES_TESTS=1` 时会在真实 PostgreSQL 中创建业务表、写入样例数据、读取真实 catalog metadata，再运行 Agent 工具链。
- `DBAGENT_RUN_AGENT_RAG_LIVE=1` 且提供 `TEST_SILICONFLOW_API_KEY` 或 `DBAGENT_LLM_API_KEY` 时，会使用 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 真实模型验证 tool calling 行为。

默认测试不依赖真实密钥或本机 PostgreSQL。真实依赖测试只通过环境变量显式开启，避免把 API key、数据库密码或用户数据写入代码、日志和提交。

2026-06-23 验证记录：`pnpm test:postgres` 已在本机真实 PostgreSQL 16 上通过；`pnpm test:agent-rag-live` 已在 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 上通过，live case 确认模型真实调用 `search_schema` 和 `query_database`。
