# Changelog / 变更日志

All notable changes to SchemaNaut will be documented here.

SchemaNaut 的重要变更都会记录在这里。

## [Unreleased]

## [0.1.0-alpha.3] - 2026-09-13

### Added / 新增

- Added bundled Git, Database, Forge, Containers, Browser Automation, Language Intelligence, Documents, and Data & Notebook Capabilities with deferred task discovery.
- Added a Host-owned literal-argv command boundary, external executable discovery, standard PostgreSQL environment discovery, and a BrowserSession port that reuses a user-authenticated local browser profile through opaque session/page references.
- 新增按任务延迟发现的 Git、Database、Forge、Containers、Browser Automation、Language Intelligence、Documents 与 Data & Notebook 内置 Capability。
- 新增 Host 持有的 literal-argv 命令边界、外部可执行文件发现、PostgreSQL 标准环境发现，以及通过不透明 session/page 引用复用用户外部登录浏览器 Profile 的 BrowserSession Port。

### Changed / 变更

- Capability configuration is no longer a product settings surface. External CLI, browser, database, and provider state is discovered where it already lives; unavailable capabilities return actionable diagnostics.
- Global `config.toml` is the only permission and model configuration document; project settings are limited to MCP declarations. Authorization uses `default`, `auto`, and `full-access`, with optional enterprise sandbox enforcement.
- Global permission configuration now enforces the Runtime's 128-rule limit during schema validation, so accepted enterprise policy files cannot fail later during activation.
- Capability 不再提供产品内配置面；外部 CLI、浏览器、数据库和 Provider 状态从其原有位置发现，不可用时返回可操作诊断。
- 全局 `config.toml` 是权限与模型配置的唯一文档；项目设置只保留 MCP 声明。授权采用 `default`、`auto`、`full-access`，并可启用企业 sandbox 要求。
- 全局权限配置会在 Schema 校验阶段执行 Runtime 的 128 条规则上限，避免企业策略文件先通过校验、后在启用时失败。

### Browser boundary / 浏览器边界

- Browser Automation v1 connects only to a user-started loopback CDP browser and creates dedicated tabs. Cookie/API Header/Authorization are not Agent inputs; Cookie/Set-Cookie are absent from prepared intents, results, and Journal facts. This is not a general content-scanning or DLP guarantee.
- Browser Automation v1 只连接用户自行启动的本机 CDP 浏览器并新建专用标签页。Cookie/API Header/Authorization 不是 Agent 参数，Cookie/Set-Cookie 不进入 prepared intent、结果或 Journal；这不是通用内容扫描或 DLP 保证。

### Alpha limits / Alpha 限制

- This is a CLI-only npm candidate for the `next` tag, not a remote publication. It exposes no SDK, Server, HTTP API, or Agent WebUI; paid live-model and every external-environment scenario are not all passing release claims.
- 这是面向 `next` 标签的仅 CLI npm 候选，不是远程发布；不提供 SDK、Server、HTTP API 或 Agent WebUI，也不宣称所有付费真实模型和外部环境场景均已通过。

## [0.1.0-alpha.2] - 2026-09-06

### Changed / 变更

- Replaced the previous SDK/Server distribution with a CLI-only local npm package. The supported entry is the `schemanaut` command; JavaScript exports, HTTP API, and Web UI are not included.
- Added terminal-first product, architecture, security, and usage documentation plus a capability and user-experience roadmap.
- Added reproducible local package generation, SHA256/provenance records, package-content checks, and fresh-install CLI smoke verification. This release is generated locally and is not published to npm Registry.
- Public documentation now describes SchemaNaut as a terminal-first, general-purpose Agent runtime. The SDK and HTTP/Web UI access layers have been removed; no replacement access layer is currently offered.
- PostgreSQL is documented as an internally implemented and tested optional database Capability; terminal configuration, connection, and analysis entry points remain incomplete. Other specialist Capabilities and connectors remain future directions rather than current product claims.
- Configuration documentation uses the endpoint-first `settings.json` model: model endpoints are configured directly, and models are discovered from those endpoints.
- 旧 SDK/Server 发行物已替换为仅提供 `schemanaut` 命令的本地 npm 包；不包含 JavaScript 导出、HTTP API 或 WebUI。
- 补齐终端优先的产品、架构、安全与使用文档，并新增 Capability 与用户体验路线报告。
- 新增可复现的本地打包、SHA256/来源记录、产物内容检查和全新安装后的 CLI 冒烟验证；本版本只在本地生成，未上传 npm Registry。
- 公开文档现以终端优先的通用 Agent Runtime 为产品核心；SDK 与 HTTP/WebUI 接入层已移除，当前不提供替代接入层。
- PostgreSQL 被说明为已有内部实现与测试的可选数据库 Capability；终端的配置、连接和分析入口仍未完善。其他专业 Capability 和 Connector 仍是规划方向，不视为当前能力。
- 配置文档采用 endpoint-first 的 `settings.json` 模型：直接配置模型 Endpoint，再从 Endpoint 发现模型。

### Current limits / 当前限制

- Model Endpoint and MCP settings still require editing `.schemanaut/settings.json` manually.
- The database Capability has an internal implementation and tests, but the terminal still lacks database configuration, connection, indexing, and result-browsing commands.
- 模型 Endpoint 与 MCP 仍需手动编辑 `.schemanaut/settings.json`。
- 数据库 Capability 已有内部实现与测试，但终端仍缺少数据库配置、连接、索引和结果浏览命令。

## [0.1.0-alpha.1] - 2026-07-31

### Added / 新增

- Terminal interaction for project-scoped Agent work.
- OpenAI-compatible, SiliconFlow, Ollama, vLLM, and Anthropic model adapters.
- PostgreSQL connection lifecycle, query jobs, transactions, discovery, observations, operations, audit, and metrics.
- Hierarchical Schema knowledge catalog, hybrid retrieval, and Merkle-based version verification.
- Database AI SQL workflows with built-in tools and Skills.
- `read`, `edit`, and `full` permission modes with approval callbacks.
- Durable SQLite sessions, automatic context compaction, manual compaction, and checkpoint history.
- Unified database, warehouse, cluster resource and state contracts.
- MCP client and user Skill extension foundations.

### Current limits / 当前限制

- PostgreSQL is the first complete reference connector.
- MCP and user Skill extension foundations remain subject to the terminal runtime's configured policies.
- SchemaNaut does not provide user accounts or sign-in; terminal use is scoped to the local project configuration.
- MCP and provider secrets must be supplied through host-managed references; SchemaNaut does not provide a credential vault.
- The workspace does not currently ship an npm package or other distributable artifact.
