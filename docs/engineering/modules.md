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
- 提供 CSV 导出 helper。

开发逻辑：

- Renderer 和 main 必须共同依赖这里的 IPC 类型，新增主进程能力时先扩展契约。
- `AppErrorCode` 要保持业务可解释，不直接泄露驱动内部错误码。
- `QuerySafetyReport` 是 SQL 执行链路的结构化解释对象，后续 Agent 可以复用。

测试重点：

- CSV 边界值：逗号、引号、换行、JSON、`NULL`。
- IPC 类型当前通过 TypeScript 编译约束，后续可以增加契约快照测试。

## `packages/core-db`

职责：

- 保存连接元数据，不保存明文密码。
- 管理查询历史。
- 提供数据库驱动接口和 PostgreSQL 实现。
- 提供 SQL 安全判断、性能提示和 SQL builder。

开发逻辑：

- `ConnectionStore` 只存连接元数据；密码由 desktop main 用 `safeStorage` 管理。
- `PostgresDriver` 内部持有连接池，renderer 不接触连接池。
- 只读连接在执行前拦截写操作和 DDL。
- 可写连接中需要确认的 SQL 使用显式事务执行，失败后回滚。
- 远程连接默认启用连接超时、语句超时和 TCP keepalive。
- PostgreSQL 错误通过 `classifyPostgresConnectionError` 转成产品错误码。

多数据库扩展方式：

- 新增 `MysqlDriver`、`ClickHouseDriver`、`SqlServerDriver` 等实现 `IDatabaseDriver`。
- 每个 driver 独立实现系统表查询、错误分类、EXPLAIN 语法和连接参数。
- 上层 main 通过 `engine` 选择 driver，不把具体数据库 SDK 透传到 UI。

测试重点：

- 纯单测覆盖 SQL 安全、性能提示、连接持久化、查询历史、错误分类。
- `pnpm test:postgres` 覆盖真实 PostgreSQL 连接、Schema、复杂 join、只读拦截、断连和事务回滚。

## `apps/desktop`

职责：

- Electron 主进程注册 IPC handler，组合 core 包能力。
- Renderer 提供 M1.5 桌面界面：连接、Schema、SQL 编辑、结果、历史、CSV 导出。
- Preload 暴露受控 IPC 入口。
- 打包配置和 ASAR 裁剪。

开发逻辑：

- Main 是安全边界：持有文件路径、密码、连接池和数据库驱动实例。
- Renderer 只发送类型化请求，收到 `Result<T>` 后渲染成功或失败状态。
- 连接表单现在暴露 SSL、连接超时和语句超时，服务于本地桌面连接远程数据库。
- 保存连接后，renderer 不会回填密码；编辑已保存连接时，表单只加载元数据并保持密码为空。
- 更新连接会让 main 断开旧连接池并标记为 disconnected，用户需要重新连接，避免“配置已改但查询仍打旧库”的隐患。
- 删除连接会经过确认，并删除连接元数据、凭证和活动连接池。
- 远程连接错误在 renderer 通过诊断 helper 转成用户可行动提示。
- SQL 性能提示在结果区展示，但不阻止执行。
- 工作区草稿通过 `workspace-state.json` 原子写入。
- Connections、SQL Editor、Results 三个主区域分别包裹 ErrorBoundary，单个区域渲染错误不会拖垮整个应用壳。

测试重点：

- 主进程可测试逻辑要尽量抽成纯模块，例如连接输入校验。
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

开发逻辑：

- 当前只保留轻量边界，避免在 M1.5 引入模型 SDK 和远程依赖。
- 后续 Agent/RAG 上线时，真实 LLM 测试要按产品设计使用真实 API key，不用 mock 替代核心可靠性验证。

测试重点：

- M1.5 暂不强行扩展。
- M2/M3 开始补 BYOK provider、gateway provider 和真实 API eval。

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
- `pnpm --filter @dbagent/desktop package`
- 打包产物启动和 ASAR 内容检查。

## 后续模块化方向

- `core-rag`：Schema 提取、文档化、索引和检索。
- `core-agent`：ReAct loop、策略层、tool registry、人工确认。
- `core-workspace`：项目工作区、文件、Python 脚本和 Agent 制品。
- `core-config`：模型、Agent、RAG、隐私和组织策略配置。

这些模块应继续遵守当前原则：renderer 负责体验，main 负责安全边界，core 包负责可测试业务逻辑。
