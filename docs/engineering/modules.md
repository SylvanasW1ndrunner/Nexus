# 模块开发说明

本文档解释 M0-M1.5 阶段各模块的开发逻辑、职责边界和后续扩展方向。它不是产品设计稿的重复，而是面向开发和验收的工程说明。

## 总体原则

DBAgent 是本地优先的桌面数据库 IDE。当前阶段优先保证：

- 用户能在本机连接 PostgreSQL，执行 SQL，并看到稳定结果。
- 密码、连接池、文件持久化和数据库驱动只存在主进程或 core 包内，不暴露给 renderer。
- 所有跨进程调用通过共享 IPC 契约和 `Result<T>` 返回，避免 UI 捕获无类型异常。
- 最终交付物是 Electron 安装包，开发 fixture、测试容器、源码测试文件不能进入用户包。
- 用户数据库接入使用 driver adapter，不用 ORM 作为主抽象。

## 为什么用户数据库不用 ORM

ORM 适合管理 DBAgent 自己的业务库，例如未来的本地 SQLite 配置库、缓存库或团队服务端数据库。但 DBAgent 面向的是用户已有的生产/分析数据库，核心任务是“理解并操作任意数据库”，因此主接入层不适合 ORM：

- 用户会执行任意 SQL，ORM 无法覆盖所有方言和数据库特性。
- DBAgent 必须保留原生错误、`EXPLAIN`、系统 catalog、schema metadata 和权限行为。
- 多数据库支持需要暴露差异，而不是把差异强行抹平。
- Agent 后续需要知道某个能力是否由当前数据库支持，例如 PostgreSQL 的 `EXPLAIN (FORMAT JSON)`、MySQL 的 `EXPLAIN FORMAT=JSON`、ClickHouse 的 system tables。
- ORM 通常以“应用模型”为中心，而 DBAgent 没有预设用户业务表模型。

因此当前采用 `IDatabaseDriver` adapter：

- 上层只依赖稳定接口：连接测试、连接池、SQL 执行、Schema 列表、能力声明。
- 每个数据库单独实现 driver，保留各自的方言、连接参数、错误分类和 metadata 查询。
- 公共层沉淀 SQL 安全、性能提示、查询历史、CSV 导出等跨数据库能力。

未来如果内部本地状态变复杂，可以为 DBAgent 自己的数据引入 SQLite + ORM 或 typed query builder，但这与用户数据库驱动层分离。

## `packages/shared`

职责：

- 定义跨包共享的领域类型。
- 定义 IPC channel、request/response map。
- 定义 `Result<T>`、`AppError` 和错误码。
- 提供 CSV/JSON 导出 helper。

开发逻辑：

- Renderer 和 main 必须共同依赖这里的 IPC 类型，新增主进程能力时先扩展契约。
- `AppErrorCode` 要保持业务可解释，不直接泄露驱动内部错误码。
- `QuerySafetyReport` 是 SQL 执行链路的结构化解释对象，后续 Agent 可以复用。

测试重点：

- CSV 边界值：逗号、引号、换行、JSON、`NULL`。
- JSON 导出边界值：列顺序、metadata、`Date`、`bigint`、`Buffer` 和嵌套对象。
- IPC 类型通过 TypeScript 编译约束和 `ipc-contract.test.ts` 双重兜底，避免新增 channel 时 request/response map 或运行时 channel 快照不一致。

## `packages/core-db`

职责：

- 保存连接元数据，不保存明文密码。
- 管理查询历史。
- 提供数据库驱动接口和 PostgreSQL 实现。
- 提供 SQL 安全判断、性能提示和 SQL builder。

开发逻辑：

- `ConnectionStore` 只存连接元数据；密码由 desktop main 用 `safeStorage` 管理。
- 连接元数据和查询历史使用原子 JSON 写入；本地 JSON 损坏时返回空列表，保证应用可启动。
- `PostgresDriver` 内部持有连接池，renderer 不接触连接池。
- Schema 能力分两层：`listTables` 只拉轻量对象列表，`describeTable` 按用户选择的表再拉列、主键、外键和注释，避免连接后一次性扫描大型生产库。
- 只读连接在执行前拦截写操作和 DDL。
- 可写连接中需要确认的 SQL 使用显式事务执行，失败后回滚。
- 远程连接默认启用连接超时、语句超时和 TCP keepalive。
- PostgreSQL 错误通过 `classifyPostgresConnectionError` 转成产品错误码。

多数据库扩展方式：

- 新增 `MysqlDriver`、`ClickHouseDriver`、`SqlServerDriver` 等实现 `IDatabaseDriver`。
- 在 `DatabaseDriverRegistry` 注册新 driver 的工厂和 `DatabaseCapabilities`，让 main 通过 `engine` 获取并复用 driver，而不是在 UI 或 workflow 中硬编码具体 SDK。
- 每个 driver 独立实现系统表查询、表结构详情、错误分类、EXPLAIN 语法和连接参数。
- 上层 main 的连接测试、连接/断开、Schema 和 SQL 执行都通过 `engine` 选择 driver，不把具体数据库 SDK 透传到 UI。

测试重点：

- 纯单测覆盖 SQL 安全、性能提示、连接持久化、查询历史、错误分类。
- `database-driver-registry.test.ts` 覆盖 driver 注册、能力声明、创建实例、复用实例和错误边界。
- `pnpm test:postgres` 覆盖真实 PostgreSQL 连接、Schema 表列表、表结构详情、复杂 join、只读拦截、断连和事务回滚。

## `apps/desktop`

职责：

- Electron 主进程注册 IPC handler，组合 core 包能力。
- Renderer 提供 M1.5 桌面界面：连接、Schema、SQL 编辑、结果、历史、CSV/JSON 导出。
- Preload 暴露受控 IPC 入口。
- 打包配置和 ASAR 裁剪。

开发逻辑：

- Main 是安全边界：持有文件路径、密码、连接池和数据库驱动实例；数据库驱动统一从 `DatabaseDriverRegistry` 按连接 `engine` 获取。
- Renderer 只发送类型化请求，收到 `Result<T>` 后渲染成功或失败状态。
- 写操作、DDL 和多语句 SQL 采用主进程确认握手：第一次请求未带 `confirmed` 时只返回 `CONFIRMATION_REQUIRED`，用户确认后 renderer 才重试执行。
- 连接表单现在暴露 SSL、连接超时和语句超时，服务于本地桌面连接远程数据库。
- 保存连接后，renderer 不会回填密码；编辑已保存连接时，表单只加载元数据并保持密码为空。
- 更新连接会让 main 断开旧连接池并标记为 disconnected，用户需要重新连接，避免“配置已改但查询仍打旧库”的隐患。
- 删除连接会经过确认，并删除连接元数据、凭证和活动连接池。
- 远程连接错误在 renderer 通过诊断 helper 转成用户可行动提示。
- SQL 性能提示在结果区展示，但不阻止执行。
- Schema 面板点击表名加载表结构详情，点击 `SQL` 生成预览查询，避免把“看结构”和“查数据”混成同一个动作。
- 工作区草稿通过 `workspace-state.json` 原子写入。
- Connections、SQL Editor、Results 三个主区域分别包裹 ErrorBoundary，单个区域渲染错误不会拖垮整个应用壳。

测试重点：

- 主进程可测试逻辑要尽量抽成纯模块，例如连接输入校验、连接 workflow、查询 workflow 和 Schema workflow。
- Renderer 展示逻辑要抽成 helper，例如远程错误文案、性能提示汇总和连接草稿转换。
- 打包后必须启动 `win-unpacked/DBAgent.exe`，不能只相信 Vite dev server。

## `packages/core-auth`

职责：

- 提供认证状态和登录/退出骨架。
- 为后续订阅和 gateway 模式保留接口。

开发逻辑：

- M1.5 不实现真实服务端认证，优先保证本地状态机和持久化边界。
- BYOK 用户不登录也能使用本地连接和 SQL 功能。
- 后续接入服务端时，保持 `AuthService` 对 UI 的返回结构稳定。

测试重点：

- 登录后状态持久化。
- 退出后状态清理。
- 未登录状态可被明确表示。

## `packages/core-usage`

职责：

- 记录本地查询轮次。
- 为 BYOK 和订阅模式提供统一用量快照。

开发逻辑：

- M1.5 只做本地记录，避免后续订阅 UX 需要重构。
- Agent loop 上线后，每轮 Agent 对话也要经过该模块计量。

测试重点：

- 本地查询轮次递增。
- 快照窗口稳定。
- 历史记录可读取。

## `packages/core-llm`

职责：

- 提供 LLM 路由边界。
- 为 BYOK 和 DBAgent gateway 模式预留统一入口。
- 提供 OpenAI-compatible provider 合约，支持 SiliconFlow 等兼容接口。
- 解析文本、工具调用和 token usage。

开发逻辑：

- 使用 Node 内置 `fetch`，不引入额外模型 SDK，降低打包体积和供应链风险。
- Provider 通过 `LlmRouter` 注册，Agent 不直接持有具体厂商 SDK。
- BYOK provider 调用后将 token 估算写入 `core-usage`。
- API key 只从运行时配置或环境变量读取，不写入代码、文档或测试快照。
- 真实 API 测试必须显式打开环境变量开关，默认测试不访问外网、不消耗额度。

测试重点：

- OpenAI-compatible 请求格式。
- 文本响应、工具调用响应和 usage 解析。
- 认证失败、限流、5xx、超时和重试。
- BYOK 不要求登录。
- SiliconFlow 真实连通测试保留入口，但由环境变量显式启用。

## `packages/core-agent`

职责：

- 提供无 UI 的 Agent ReAct 运行时。
- 管理会话消息、token 使用、工具调用循环和中止边界。
- 提供 Tool Registry 和 Permission Manager。
- 让 Agent 能在最终 UI 完成前通过测试验证核心行为。

开发逻辑：

- Agent 只依赖 `core-llm` 的 provider/router 合约，不直接绑定任何模型厂商。
- 工具定义使用结构化 schema，供模型 tool calling 和本地执行共享。
- `readonly` 模式拒绝所有非只读工具；`ask` 模式在没有审批 provider 时不会执行有风险工具。
- 工具执行失败会作为 tool message 回写给 LLM，让下一轮有机会修复，例如 SQL 报错后重写查询。
- 每个 Agent round 完成后写入 `core-usage`，provider token 用量由 `core-llm` 写入。
- 当前只实现最小 ReAct 闭环，不包含 UI 面板、流式展示、持久化 SQLite、子 Agent 和 Plan&Execute。

测试重点：

- 只读数据库工具自动执行并产出最终业务回答。
- 只读模式阻止写操作且不产生副作用。
- 询问模式在无审批 provider 时不执行中风险工具。
- 工具失败能够回传给模型并在下一轮恢复。
- 权限矩阵覆盖 safe、medium、high、critical。

## `packages/core-rag`

职责：

- 将数据库 schema 元数据转换为可检索文档。
- 建立表、字段和外键关系图。
- 为 Agent 和 SQL 辅助能力提供 schema context。
- 在 embedding/vector 能力接入前，先提供稳定的精确匹配和词法检索。

开发逻辑：

- 输入使用 `TableDetail[]`，直接承接 `core-db` 的 schema 抽取结果。
- 每个连接独立建索引，断开连接时可清理对应索引。
- 文档分为 table、column、relation 扩展三类语义。
- 检索优先级：精确名称、标题包含、token 命中、正文命中、关系扩展。
- 中文业务注释使用 CJK bigram，避免“用户订单”这类组合词无法命中“用户”和“订单”上下文。
- 关系扩展优先保留外键和业务字段，再保留主键，避免有限上下文被 `id` 这类低信息字段占满。
- 当前实现为内存索引；后续再接 per-connection SQLite / sqlite-vec / embedding。

测试重点：

- 表和字段生成稳定 document id。
- 外键字段能连接到关联表。
- 英文表名查询能召回表和关键字段。
- 中文业务问题能通过注释召回字段。
- 跨表问题能返回关系上下文。
- context builder 遵守字符预算并标记截断。
- 清理连接索引后不再返回旧 schema。

## `packages/core-tools`

职责：

- 将 core 能力注册为 Agent 可调用的内置工具。
- 维护工具参数校验、危险等级、只读标记和 workspace 沙箱边界。
- 让 Agent 后端可以在没有最终 UI 的情况下完成“查 schema → 查数据 → 汇报”的真实闭环。

开发逻辑：

- `registerDatabaseTools()` 接收 `ToolRegistry`、`IDatabaseDriver`、活动连接获取函数和可选 `SchemaRagEngine`。
- DB 工具直接复用 `core-db` driver，不绕开 SQL 安全、只读拦截、确认机制和错误分类。
- RAG 工具直接复用 `core-rag`，当前提供 `search_schema` 和 `build_schema_context`。
- 工具定义包含 `dangerLevel` 和 `readonly`，由 `core-agent` 的 `PermissionManager` 统一决策。
- `query_database` 是只读 medium 工具；在 readonly Agent 模式下允许执行 SELECT 类分析。
- `execute_sql` 是 high 且非只读工具；readonly Agent 模式会在 driver 执行前拒绝。
- workspace 路径解析只接受相对路径，并拒绝 `..` 越界。
- 当前不把 Electron main 的 Python/Terminal 服务反向依赖到 core 包；后续应通过抽象接口或 `core-workspace` 接入。

测试重点：

- Agent 能通过 `search_schema` 和 `query_database` 完成用户问题。
- list/describe schema 工具返回稳定结构。
- readonly 模式阻止写 SQL，且 driver 不执行。
- 缺失活动连接时返回明确错误。
- workspace 路径不能访问绝对路径或越过工作区根目录。

## `scripts`

职责：

- 提供工程流水线脚本。
- 提供 PostgreSQL 开发 fixture。
- 提供打包裁剪和 smoke 检查。

开发逻辑：

- `scripts/dev-db` 只用于开发和测试，不进入安装包。
- `scripts/run-postgres-tests.mjs` 显式打开真实 PostgreSQL 集成测试开关。
- `scripts/prune-asar.cjs` 在打包后裁剪 workspace 包源码、测试和 source map。
- `scripts/smoke.mjs` 是零外部依赖快速健康检查。

测试重点：

- `pnpm run ci`
- `pnpm test:postgres`
- `pnpm package`
- 打包产物启动和 ASAR 内容检查。

## 后续模块化方向

- `core-rag`：Schema 提取、文档化、索引和检索。
- `core-agent`：ReAct loop、策略层、tool registry、人工确认。
- `core-workspace`：项目工作区、文件、Python 脚本和 Agent 制品。
- `core-config`：模型、Agent、RAG、隐私和组织策略配置。

这些模块应继续遵守当前原则：renderer 负责体验，main 负责安全边界，core 包负责可测试业务逻辑。
