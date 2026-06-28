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

长 SQL 取消入口同样在主进程收口。`createQueryWorkflow()` 会把执行中的 query id 注册到 `QueryCancellationRegistry`，并通过 driver observer 记录 PostgreSQL backend pid；`db:cancel-query` 会先生成取消决策，再调用对应 driver。PostgreSQL 已支持 `pg_cancel_backend`，缺少 backend pid 或取消超时时会降级断开当前连接。调用方如果需要在查询未完成时取消，必须在发送 `db:execute-query` 前生成 `queryId`。

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
