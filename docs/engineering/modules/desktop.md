# desktop 桌面应用模块

## 代码入口

- `apps/desktop/src/main/main.ts`：Electron 主进程、IPC handler、服务组合和持久化路径。
- `apps/desktop/src/main/connection-validation.ts`：连接表单输入校验。
- `apps/desktop/src/main/connection-workflow.ts`：连接列表、测试、创建、更新、删除、连接和断开的主进程业务链路。
- `apps/desktop/src/main/credential-vault.ts`：数据库密码本地凭证存储，封装 `safeStorage` 和 fallback。
- `apps/desktop/src/main/query-confirmation.ts`：危险 SQL 确认握手判断。
- `apps/desktop/src/main/workspace-project-store.ts`：项目级 Workspace 创建、打开、最近项目管理和目录骨架生成。
- `apps/desktop/src/main/workspace-state-store.ts`：SQL 草稿和活动连接恢复状态持久化。
- `apps/desktop/src/preload/preload.ts`：受控 IPC 暴露。
- `apps/desktop/src/renderer/src/App.tsx`：BetaV0.1.1 三栏工作台主界面，包含 Monaco 编辑器、项目弹窗、文件树和右侧对话区。
- `apps/desktop/src/renderer/src/connection-draft.ts`：连接编辑草稿转换。
- `apps/desktop/src/renderer/src/diagnostics.ts`：远程连接错误和性能提示展示文案。
- `apps/desktop/src/renderer/src/i18n.ts`：中英文 UI 文案字典和语言归一化。
- `apps/desktop/src/renderer/src/styles.css`：界面样式。
- `apps/desktop/package.json`：Electron builder 配置和打包脚本。

## 开发逻辑

桌面应用按 Electron 安全边界拆分。Main 持有文件路径、密码、连接池和数据库 driver，并统一从 `DatabaseDriverRegistry` 按连接 `engine` 获取 driver；preload 只暴露 `window.dbagent.invoke(channel, request)`；renderer 只发送类型化请求并渲染 `Result<T>`。

连接管理支持创建、编辑、删除、测试、连接和断开。保存连接后 renderer 不回填密码；编辑已有连接时只加载元数据，密码留空。更新连接会让 main 主动断开旧连接池并标记为 disconnected，避免用户修改 host、database、SSL 或超时配置后，查询仍落到旧连接。

密码由 `CredentialVault` 在主进程内管理。它优先使用 Electron `safeStorage` 加密，系统不可用时退化为 base64 fallback，并通过临时文件加 rename 写入，避免凭证文件半写。该 fallback 只是 M1.5 的可运行兜底，不等同于安全加密；公开发布前仍要迁移到 OS keychain adapter，并分别验证 Windows、macOS、Linux 的可用性。

远程连接配置在 UI 暴露 SSL、连接超时和语句超时。输入校验在主进程做最终裁决，超时值必须落在合理区间。连接失败时 renderer 使用 `diagnostics.ts` 把产品错误码转成可行动提示，例如 DNS、VPN、防火墙、云安全组、SSL、监听地址或 `pg_hba.conf`。

SQL 执行路径由主进程强制执行确认握手。如果 SQL 需要确认且 request 没有 `confirmed: true`，main 返回 `CONFIRMATION_REQUIRED`，不调用 driver，也不写历史。用户确认后 renderer 用同一 SQL 重试。

长 SQL 取消入口同样在主进程收口。`createQueryWorkflow()` 会把执行中的 query id 注册到 `QueryCancellationRegistry`，并通过 driver observer 记录 PostgreSQL backend pid；`db:cancel-query` 会先生成取消决策，再调用对应 driver。PostgreSQL 已支持 `pg_cancel_backend`，缺少 backend pid 或取消超时时会降级断开当前连接。query workflow 会把用户取消错误写成 `cancelled` 历史状态，而不是普通 `failed`。调用方如果需要在查询未完成时取消，必须在发送 `db:execute-query` 前生成 `queryId`。

Schema 区域将“看结构”和“查数据”拆开。点击表名加载 `describeTable`，查看列、类型、nullable、主键和外键；点击 `SQL` 才生成预览查询，避免用户只是查看结构时误触发数据扫描。

结果区支持 CSV 和 JSON 导出。导出逻辑在 renderer 使用浏览器 `Blob` 下载，不引入桌面端额外运行时依赖。格式化逻辑来自 `@dbagent/shared`，保证 main、renderer 和测试使用同一结果结构。

项目级 Workspace 是 BetaV0.1.1 的新增边界。用户选择一个真实目录后，主进程创建 `.dbagent/workspace.json`，并生成 `sql/`、`scripts/`、`docs/`、`outputs/` 等目录。Workspace 只保存项目元信息和连接关联，数据库连接定义与凭证仍保留在全局 `userData/data` 中，避免项目目录泄露密码。

最近项目列表写入 Electron `userData/data/workspaces.json`。打开项目时必须读取并校验 `.dbagent/workspace.json`，普通目录或损坏配置不会进入最近项目列表。

Workspace 文件树当前列出 `sql/`、`queries/`、`scripts/`、`docs/` 和 `outputs/`，用于左侧项目侧栏展示。SQL 编辑器可以把当前 SQL 保存到项目配置中的 SQL 库目录，并在文件头写入 `@name`、`@connection`、`@tags`、`@updated` 元信息。用户点击 SQL 文件时，主进程读取文件并返回内容，renderer 剥离元信息后放回编辑器继续编辑或执行。路径由主进程解析并限制在 Workspace 根目录内，renderer 不直接写文件。

新建 Workspace 入口移动到顶部 `File` 下拉菜单，使用弹窗填写项目名、目录、描述和模板；弹窗内可选择是否同时创建数据库连接，也可以先跳过连接，后续在连接面板中再建。项目设置入口位于顶部 `Settings` 下拉菜单，可修改 SQL 库、脚本、文档和输出目录配置。

当前版本实现项目创建、打开、最近项目置顶、活动项目恢复、文件树展示、SQL 文件保存和 SQL 文件打开；Python 脚本运行、Agent 工具注册、SQL 参数化执行和文件 diff 预览属于后续增量。

工作区状态保存活动连接 id 和 SQL 草稿，写入 Electron `userData/data/workspace-state.json`，采用临时文件加 rename 的原子写入方式，避免异常退出留下半截 JSON。启动恢复时如果状态文件缺失、JSON 损坏或结构不合法，应用会忽略该恢复状态并继续启动，避免一个损坏草稿拖垮整个桌面应用。

`apps/desktop/src/main/terminal-service.ts` 是真实终端后端服务，不依赖 renderer 文本框模拟。它通过 `node-pty` 启动系统 shell，支持多 session、逐字符输入、按 cursor 增量读取输出、resize、clear、close，以及坏 shell 配置 fallback 到系统 shell。

终端输出缓冲现在有后端上限。`TerminalService` 默认最多保留约 1MB 输出；主进程读取 IDE 设置时，会把 `terminal.scrollback` 转换成近似字符上限并传入服务。超出上限后会裁剪旧输出，同时维护绝对 cursor，保证 renderer 继续用旧 cursor 读取时不会拿到重复内容。这避免长时间运行命令把主进程内存无限撑大。

Renderer 在 BetaV0.1.1 改为 Cursor 风格三栏工作台：左侧管理项目文件树、最近项目、连接和 Schema；中间是 Monaco 编辑器和结果区；右侧是对话窗口与查询历史。顶部提供文件、运行、设置下拉菜单和语言切换入口。Monaco 当前至少支持 SQL 与 Python 高亮，语言由打开的文件类型决定。语言选择写入 `localStorage`，当前支持中文与英文，默认中文。

## 测试覆盖

- `connection-validation.test.ts`：连接输入校验、SSL、连接超时、语句超时。
- `connection-workflow.test.ts`：连接生命周期，包括创建保存凭证、缺失连接不写孤立凭证、更新后断开旧连接池、连接失败标记 error、删除时清理凭证。
- `credential-vault.test.ts`：凭证保存、读取、删除、`safeStorage` 可用和不可用 fallback。
- `query-confirmation.test.ts`：危险 SQL 未确认时必须返回确认要求。
- `query-workflow.test.ts`：主进程查询业务链路，包括成功执行、用量记录、历史写入、只读拦截、确认要求、失败历史、query id 生命周期和取消决策入口。
- `query-workflow.postgres.integration.test.ts`：真实 PostgreSQL 查询取消端到端，覆盖 `pg_sleep`、backend pid 捕获、`pg_cancel_backend`、取消后连接复用和单业务连接池场景。
- `schema-workflow.test.ts`：Schema 主进程业务链路，包括连接缺失时的 `NOT_FOUND`、按 `engine` 路由 driver、表列表和表详情参数透传。
- `terminal-service.test.ts`：真实 PTY 终端创建、fallback shell、逐字符输入、工作目录、clear、resize、输出缓冲上限和 cursor 单调读取。
- `workspace-project-store.test.ts`：真实项目目录创建、标准模板目录与 starter 文件、打开已有项目、最近项目置顶、普通目录拒绝打开、保存可复用 SQL、读取 SQL 文件、拦截非受管路径读取、修改 SQL 库配置后保存到新路径。
- `workspace-state-store.test.ts`：SQL 草稿恢复、活动连接恢复、缺失状态、损坏 JSON 和结构不合法状态。
- `connection-draft.test.ts`：编辑连接不回填密码，并保留远程连接配置。
- `diagnostics.test.ts`：远程连接错误提示和 SQL 性能告警汇总。
- `i18n.test.ts`：默认中文、英文切换和未知语言归一化。
- 打包验证：`pnpm package`。
- 启动验证：直接启动 `apps/desktop/release/win-unpacked/DBAgent.exe`，确认打包产物能进入主进程并写入日志。

## 打包约束

桌面包不能携带 PostgreSQL 服务器、Docker fixture、测试文件、源码 map 或开发脚本。`electron-builder` 负责生成安装包，`scripts/prune-asar.cjs` 在 afterPack 阶段裁剪 workspace 包里的源码和测试产物。

当前已验证生成 Windows NSIS 安装包。M0-M1.5 阶段仍有两个发布前事项：应用图标需要替换默认 Electron 图标，正式分发前需要配置代码签名。

## 后续扩展

- Agent、RAG、Workspace 文件读写和多 tab 不应长期堆进 `App.tsx`；BetaV0.1.1 先完成工作台骨架，后续应拆出稳定的 renderer 状态模块和页面级组件。
- 如果后续加入真实 E2E，应优先从打包产物启动，而不是只测 Vite dev server。
## 2026-06-08 增量：EXPLAIN workflow

新增 `apps/desktop/src/main/explain-workflow.ts`，把 EXPLAIN 从 `main.ts` 的内联拼接拆成独立主进程业务模块。该模块只做三件事：

- 使用 `stripSqlComments`、`containsMultipleStatements`、`firstStatementKind` 对原始 SQL 做轻量安全判断。
- 只允许单条读查询进入解释计划路径。
- 构造 `EXPLAIN (FORMAT JSON)` 后交给现有 `createQueryWorkflow` 执行。

这个拆分让 `main.ts` 继续保持组合层职责，查询执行、危险 SQL 确认、连接 driver 路由和 EXPLAIN 安全边界分别有独立测试。当前测试文件是 `apps/desktop/src/main/explain-workflow.test.ts`，覆盖只读查询包装、`WITH`/`VALUES` 允许、空 SQL 拒绝、多语句拒绝、写操作/DDL 拒绝，以及被拒绝 SQL 不触发下游查询 workflow。

## 2026-06-28 增量：Agent 工具注册

`apps/desktop/src/main/agent-tool-bootstrap.ts` 负责把 desktop main 的 `ToolRegistry` 接到已有 core 工具能力：

- 数据库工具来自 `@dbagent/core-tools/registerDatabaseTools()`，通过异步 `ConnectionStore.list()` 读取最新已连接 connection。
- SQL 执行通过 connection `engine` 路由到 `DatabaseDriverRegistry` 中的真实 driver，不在 Agent service 内硬编码数据库 SDK。
- Schema RAG 工具复用 `@dbagent/core-rag/SchemaRagEngine`，当前用于提供本地 schema 检索和上下文构建工具定义。
- workspace 文件工具复用 `@dbagent/core-workspace/WorkspaceCore`，但 active workspace root 尚未接入 Agent runtime；当前 handler 会返回 `No active workspace.`，避免未确认项目根目录时访问文件系统。

该装配层只做组合，不持有 API key，不绕过 official plugin tool policy、Skill `allowedTools` 或 `ReactAgent` 的权限判断。

## 2026-07-06 增量：终端启动期输入队列

`apps/desktop/src/main/terminal-service.ts` 在真实 PTY shell 刚创建时会先缓存早期输入，等检测到 shell 提示符后再写入 PTY；如果 shell 没有输出提示符，则通过短超时兜底写入。这样可以避免 Windows PowerShell/ConPTY 启动阶段仍在终端能力协商时吞掉用户刚输入的命令。

该逻辑仍然保持真实终端语义：`terminal:write` 对调用方立即返回，session 继续保持 running；后端只调整写入 PTY 的时机，不伪造输出、不模拟 shell。测试侧使用真实 PowerShell 覆盖创建后立即写入、逐字符输入、fallback shell、指定 cwd、清空输出和输出缓冲裁剪。

## 2026-07-08 增量：终端滚动窗口旧输入回显清理

`TerminalService` 在输出超过 `maxOutputChars` 后会裁剪旧缓冲并维护绝对 cursor。Windows PowerShell/ConPTY 会把用户输入和行编辑控制序列回显到 PTY 输出中；当旧命令已经处于保留窗口内、随后又被标记为 stale input echo 时，后端现在会同时清理当前保留缓冲和后续新增数据，避免用户从新 cursor 读取时再次看到已滚出窗口的旧命令片段。

该修复不改变真实 shell 执行语义，不模拟终端输出，只清理已经被后端判定为 stale 的输入回显。测试仍使用真实 PTY，覆盖输出上限、cursor 单调递增和后续读取不包含旧命令片段。

## 2026-07-07 增量：Agent 审计日志接入

`apps/desktop/src/main/agent-audit-log.ts` 提供桌面主进程的 Agent 审计日志 adapter。它只负责根据 Agent 事件 timestamp 选择每日文件路径，实际 JSONL 写入、损坏行跳过、脱敏和长度限制继续复用 `@dbagent/core-agent/AgentAuditLogStore`。

默认路径：
- `Electron userData/logs/agent-YYYY-MM-DD.jsonl`
- timestamp 无法解析时写入 `agent-unknown-date.jsonl`

`main.ts` 在构造 `ReactAgent` 时注入 `new DailyAgentAuditLogStore(logsDir)`。因此通过 `agent:run` IPC 进入 `HeadlessAgentService` 的真实 Agent 任务，会默认写入 run/model/tool/final 状态审计事件。该日志不进入 renderer，不包含完整 prompt、完整工具结果或明文凭证；后续诊断报告和官方 eval 插件可以按需读取并再次脱敏。

本切片没有引入 OpenTelemetry、LangSmith、Langfuse 或其他外部追踪依赖。原因是桌面端默认能力必须离线可用、可打包、无账号依赖，并且不能把用户数据库上下文自动发送到外部平台。后续如果支持外部 tracing，应作为显式开启的导出 adapter，而不是替代本地审计日志。

## 2026-07-07 增量：诊断报告主进程服务

`apps/desktop/src/main/diagnostic-report-service.ts` 负责把桌面端真实文件系统接入 `core-tools` 的诊断报告合同。它会从 Electron `userData` 下读取白名单配置、`main.log`、`logs/agent-*.jsonl` 和 crash 快照，调用 `buildDiagnosticReport()` 统一脱敏，然后写入 `diagnostic-reports/diagnostic-<timestamp>-<hash>/`。

新增 IPC `app:generate-diagnostic-report`，返回报告目录、文件数、字节数和脱敏摘要。renderer 不直接接收报告内容，避免把日志和配置文本暴露到前端内存。`credentials.json` 不在收集白名单内；大日志只读取尾部，避免生成报告时拖垮应用。

当前没有引入 zip 依赖。目录输出已经能满足无 UI 测试和手动反馈，zip 打包会在后续单独评估压缩库、打包体积、Windows/Linux 兼容和大文件流式写入。

## 2026-07-08 增量：连接删除清理 Schema RAG 快照

`apps/desktop/src/main/connection-workflow.ts` 的连接删除流程现在接入 Schema RAG 生命周期清理。删除连接时，主进程会先断开数据库 driver，再删除该连接对应的 Schema RAG 快照文件，并清理共享 `SchemaRagEngine` 中的内存索引，最后才删除连接元数据和凭据。

该顺序用于保证失败可恢复：如果 RAG 快照删除失败，连接元数据和凭据会保留，调用方收到 `INTERNAL_ERROR`，用户或后续自动恢复任务可以再次发起删除；如果快照已经删除但后续连接元数据删除失败，RAG 快照可以在重新连接后重建，不会造成用户数据库凭据丢失。

`main.ts` 现在只创建一个共享 `SchemaRagEngine`，同时注入给 Agent 工具注册和连接删除 workflow，避免 Agent 查询使用的内存索引与连接生命周期清理不一致。持久化目录为 Electron `userData/schema-rag-snapshots`，当前无新增第三方依赖。

## 2026-07-08 增量：启动期清理无主 Schema RAG 快照

`apps/desktop/src/main/schema-rag-startup-cleanup.ts` 负责应用启动期的 Schema RAG 快照清理。它只依赖两个接口：当前连接清单和快照清理器；`main.ts` 在 `app.whenReady()` 后、创建窗口前调用该服务。

清理策略：

- 读取 `ConnectionStore.list()` 作为活跃连接集合。
- 调用 `SchemaRagSnapshotStore.cleanupInactive({ removeInvalid: true })` 删除无主快照和损坏快照。
- 只把计数摘要写入 `main.log`，不把快照文件内容、数据库凭据或 API key 写入日志。
- 如果连接清单读取失败，则跳过快照清理并记录错误，避免在无法确认活跃连接集合时误删用户仍可能需要的索引。

该能力属于桌面主进程组合层，不改变 `core-rag` 合同，也不引入 UI 或新依赖。

## 2026-07-08 增量：启动期恢复活跃 Schema RAG 快照

启动期 Schema RAG 维护现在不只清理无主快照，还会把活跃连接的可用快照 hydrate 回共享 `SchemaRagEngine`。`main.ts` 调用 `recoverSchemaRagSnapshotsAtStartup()`，服务流程为：

- 读取当前连接清单。
- 清理无主快照和损坏快照。
- 对每个活跃连接调用 `SchemaRagSnapshotStore.loadDetailed(connectionId)`。
- `loaded` 快照通过 `SchemaRagEngine.loadIndex()` 进入共享内存索引。
- `missing` 视为正常冷启动，后续重新索引即可。
- `invalid` / `error` 只计入摘要和日志，不阻塞窗口启动，也不影响其他连接恢复。

清理阶段失败时，服务会记录 `cleanupError` 并继续尝试加载活跃连接快照。连接清单读取失败时仍然整体跳过恢复，避免无法确认活跃连接集合时误删或误加载。
