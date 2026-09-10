# 第一批内置 Capability 与真实 Agent 验收实施计划

> 对应设计：`docs/superpowers/specs/2026-09-10-first-party-capabilities-and-live-acceptance-design.md`

## Global Constraints

- 文档先行：Task 1 完成、评审并提交前，不开始任何代码任务。
- 用户文档与开发文档分离；用户文档不暴露 Control Plane、Registry、generation、lease、内部包和测试通过数。
- Capability 不拥有程序内或项目内配置。`~/.schemanaut/config.toml` 只承载模型连接、默认生成参数和全局企业权限；项目 settings 只承载项目 MCP 声明。
- 八类第一批 Capability 全部交付；Database 与其他能力平等，不进入 12 个固定基础 Tool。
- Capability 不直接使用 `node:child_process`。命令型能力必须通过 Host-owned `ProcessRuntime` / `SandboxExecutor` 的 argv 执行端口。
- 不自研跨平台 OS 沙盒。无强隔离时必须准确报告 `ask-unsandboxed` 或 `unavailable`，不能声称已沙盒化。原生 Windows 的自然 root exit 仅报告命令退出；containment 和完整进程树证明为 unverified，取消/终止后无法证明已停止的 descendant 为 unknown，本轮不使用 Job Object。
- 所有 Tool 使用 `prepare → authorize → schedule → execute → observe`，共享全局权限、批准、审计、取消、恢复、结果保留与 provenance。
- Task 2 必须执行全仓主动盘点，清理运行时内容安全机制：删除凡是基于 Secret 或 credential 内容进行识别、拒绝或脱敏的路径及其测试；范围包括进程/Capability 运行时、MCP 配置命令参数和 URL 内容拦截、以及盘点发现的 Agent、Provider、Journal、诊断或结果保留路径。保留静态权限 facts、普通大小/取消/生命周期限制、schema 校验，以及 config.toml 的三档权限和企业规则。
- 功能认知优先，不采用 TDD；各任务实现后运行聚焦静态/冒烟检查，Task 10 统一运行完整测试和真实环境验收。
- 保留既有未提交工作，不重置、不覆盖无关改动；只提交任务明确列出的文件。
- 所有提交作者为 Chandler Niu；不要将真实凭据、`.env` 或生产连接信息提交到 Git，这是仓库卫生要求。
- 不做任何通用 Secret/credential 内容识别、拦截或脱敏。唯一狭义 API 隔离是内置 HTTP/browser bridge 不把
  Cookie/Set-Cookie 值放入 Agent-facing schema、prepared intent、结果或 Journal；这不扫描网页正文、外部命令
  输出或用户 browser_test 代码输出。Browser Capability 使用外部准备的浏览器/Playwright 环境和登录态；当前
  CLI 无内嵌 Chromium，也不提供 Cookie 参数。

## Task 1: 分离用户文档和开发文档，并冻结本轮产品边界

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/product/overview.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/guides/terminal.md`
- Modify: `docs/guides/terminal.zh-CN.md`
- Add: `docs/guides/capabilities.md`
- Add: `docs/guides/capabilities.zh-CN.md`
- Add: `docs/guides/diagnostics-and-sandbox.md`
- Add: `docs/guides/diagnostics-and-sandbox.zh-CN.md`
- Add: `docs/engineering/README.md`
- Move: `docs/guides/capability-authoring.md` → `docs/engineering/capability-authoring.md`
- Modify: `docs/architecture/capabilities-tools-skills-mcp.md`
- Modify: `docs/architecture/model-context-settings.md`
- Modify: `docs/architecture/agent-runtime.md`
- Modify: `docs/engineering/code-map.md`
- Modify: `docs/engineering/verification.md`
- Modify: `docs/product/base-tools-problem-audit.md`
- Add: `docs/superpowers/specs/2026-09-10-first-party-capabilities-and-live-acceptance-design.md`
- Add: `docs/superpowers/plans/2026-09-10-first-party-capabilities-and-live-acceptance.md`

**Requirements:**

1. 根 README、`docs/README.md`、product 与 guides 只面向用户；内部架构仅通过一个“开发者文档”链接进入。
2. `docs/engineering/README.md` 成为开发文档唯一入口，索引 architecture、engineering、capabilities 内部资料与本轮 design/plan。
3. 中英文用户页语义一致；删除 `/mode`、基础 Tool 尚未实现、MCP 必须手动启动等与代码不一致的说明。
4. 用户 Capability 指南列出八类能力、外部依赖、用户无需在 SchemaNaut 内配置的原则、Agent 自然语言协助方式、缺失依赖诊断和重试方式。
5. 诊断与沙盒指南解释三档全局权限、真实 sandbox capability、`ask-unsandboxed` / `unavailable`、外部状态修复和用户对输出敏感性的责任。
6. 架构文档只保留稳定合同；实现状态与测试证据只留在 engineering。
7. `base-tools-problem-audit.md` 首部标为历史审计，链接当前设计与实现报告，不再作为当前用户文档入口。

**Verification:**

- `rg -n "(^|[^[:alnum:]_])/mode([^[:alnum:]_-]|$)|尚未实现该清单|has not implemented|MCP auto-start is disabled|禁用 MCP 自动启动" README.md README.zh-CN.md SECURITY.md docs/product docs/guides docs/architecture`
- `rg -n "Control Plane|Registry|generation|lease|通过|passed" README.md README.zh-CN.md docs/README.md docs/product docs/guides`
- `git diff --check -- README.md README.zh-CN.md SECURITY.md docs`

## Task 2: 增加 argv 进程启动与 Capability 命令 Host Port

**Files:**

- Delete: `packages/core-tools/src/command-redaction.ts`
- Modify: `packages/core-tools/src/sandbox-executor.ts`
- Modify: `packages/core-tools/src/process-runtime.ts`
- Modify: `packages/core-tools/src/process-tools.ts`
- Modify: `packages/core-tools/src/mcp-config-store.ts`
- Add: `packages/core-tools/src/capability-command-runtime.ts`
- Modify: `packages/core-tools/src/index.ts`
- Modify: `packages/core-agent/src/types.ts`
- Modify: `packages/core-agent/src/tools/tool-invocation-preparer.ts`
- Modify: `packages/core-tools/test/process-runtime.test.ts`
- Modify: `packages/core-tools/test/mcp-config-store.test.ts`
- Add: `packages/core-tools/test/capability-command-runtime.test.ts`

**Requirements:**

1. 为命令型 Capability 的 ProcessRuntime 增加持久化的 argv launch 形式；`NativeSandboxExecutor` 对该 argv 使用 `shell:false`，基础 `process_exec` 保留用户 shell command 合同，不被改写为 argv-only。
2. Capability command runtime 只接受已验证 executable、argv、cwd、权限分类和明确路径/host 目标；不接受 shell 片段。
3. ToolPrepareContext 必须提供 Run policy mode/revision；prepare 固定执行器 identity、该 policy 快照、边界 revision、真实目标和 resource keys；execute 复核后使用同一 ProcessRuntime、取消、deadline、输出上限与 retention。
4. 提供 PATH 可执行文件发现器并返回 launch descriptor；不得执行外部命令完成静态 probe。诊断只返回普通有界字段（例如候选名称、发现状态和 launch descriptor 类型），不根据目录内容作分类或决策。Windows npm .cmd 必须安全解析为 node 与入口脚本，禁止 shell fallback。
5. 删除既有 `CommandRedactor`、`CommandArgumentGuard`、argv 凭据拒绝和 Capability 专用聚合/脱敏；修改 ProcessRuntime 及测试，恢复 stdout/stderr 的普通 bounded spool。删除 MCP 配置中对命令参数、URL userinfo、URL 查询参数或其内容的凭据/Secret 拦截，并修改 `mcp-config-store.ts` 及其测试。
6. 执行全仓主动盘点：删除每一条运行时按 Secret/credential 内容识别、拒绝或脱敏的路径和相关测试；不删除静态操作权限 facts、普通大小/取消/生命周期合同、schema 校验，或 config.toml 的 default/auto/full-access 和企业规则。

**Verification:**

- `pnpm --filter @dbagent/core-tools typecheck`
- `pnpm --filter @dbagent/core-tools test -- capability-command-runtime.test.ts process-runtime.test.ts mcp-config-store.test.ts`

## Task 2B: 全仓运行时内容安全清理

**Files (以当前审计为起点；发现的每个实际运行时路径及其测试都必须补入本任务文件清单):**

- Task 2 负责一次性删除/修改的配套路径：`packages/core-tools/src/command-redaction.ts`、`packages/core-tools/src/process-runtime.ts`、`packages/core-tools/src/mcp-config-store.ts`、`packages/core-tools/test/process-runtime.test.ts`、`packages/core-tools/test/mcp-config-store.test.ts`。
- Modify: `packages/core-tools/src/process-tools.ts`
- Modify: `packages/core-tools/src/secure-web-transport.ts`
- Modify: `packages/core-tools/src/web-tools.ts`
- Modify: `packages/core-tools/test/web-tools.test.ts`
- Modify: `packages/agent-host/src/project-settings.ts`
- Modify: `packages/agent-host/src/project-mcp-config-store.ts`
- Modify: `packages/agent-host/src/global-config.ts`
- Modify: `packages/agent-host/src/global-config.schema.json`
- Modify: `packages/agent-host/test/project-settings.test.ts`
- Modify: `packages/agent-host/test/global-config.test.ts`
- Delete: `packages/core-agent/src/redaction.ts`
- Modify: `packages/core-agent/src/tools/tool-errors.ts`
- Modify: `packages/core-agent/src/tools/tool-invocation-runtime.ts`
- Modify: `packages/core-agent/src/capability-control-plane.ts`
- Modify: `packages/core-agent/src/capability-discovery-manifest.ts`
- Modify: `packages/core-agent/src/context/prompt-runtime.ts`
- Modify: `packages/core-agent/src/kernel/runtime-command.ts`
- Modify: `packages/core-agent/src/events/event-schema-registry.ts`
- Modify: `packages/core-agent/src/events/sqlite-agent-journal.ts`
- Modify: `packages/core-agent/test/tool-errors.test.ts`
- Modify: `packages/core-agent/test/tool-invocation-runtime.test.ts`
- Modify: `packages/core-agent/test/event-schema-registry.test.ts`
- Modify: `packages/core-agent/test/capability-control-plane.test.ts`
- Modify: `packages/core-agent/test/capability-control-plane-faults.test.ts`
- Modify: `packages/core-agent/test/runtime-command.test.ts`
- Modify: `packages/core-resource/src/resource-snapshot-store.ts`
- Modify: `packages/core-resource/src/resource-registry.ts`
- Modify: `packages/core-resource/test/resource-snapshot-store.test.ts`
- Modify: `packages/core-resource/test/resource-registry.test.ts`
- Modify: `packages/shared/src/contracts/validation.ts`
- Modify: `packages/shared/test/common-contracts.test.ts`
- Modify: `packages/shared/test/database-contracts.test.ts`
- Modify: `packages/shared/test/resource-contracts.test.ts`
- Modify: `packages/shared/test/contract-compatibility.test.ts`
- Modify: `packages/core-db/src/connection-store.ts`
- Modify: `packages/core-db/src/postgres-errors.ts`
- Modify: `packages/core-db/src/database-access-runtime.ts`
- Modify: `packages/core-db/src/connector-registry.ts`
- Modify: `packages/core-db/test/connection-store.test.ts`
- Modify: `packages/core-db/test/postgres-errors.test.ts`
- Modify: `packages/core-db/test/database-access-runtime.test.ts`
- Modify: `packages/database-capability/src/types.ts`
- Modify: `packages/database-capability/src/database-capability-module.ts`
- Modify: `packages/database-capability/src/ai-sql-tools.ts`
- Modify: `packages/database-capability/src/tool-generation.ts`
- Modify: `packages/database-capability/src/agent-knowledge-projection.ts`
- Modify: `packages/database-capability/test/public-boundary.test.ts`
- Modify: `packages/database-capability/test/database-capability-module.test.ts`
- Modify: `packages/database-capability/test/database-capability-schema-publication.test.ts`
- Delete: `packages/core-llm/src/known-secret-sanitizer.ts`
- Modify: `packages/core-llm/src/provider-plugin-registry.ts`
- Modify: `packages/core-llm/src/connection-resolver.ts`
- Modify: `packages/core-llm/src/anthropic-provider.ts`
- Modify: `packages/core-llm/src/openai-compatible-provider.ts`
- Modify: `packages/core-llm/src/openai-responses-provider.ts`
- Modify: `packages/core-llm/src/stream-safety.ts`
- Modify: `packages/core-llm/src/telemetry.ts`
- Modify: `packages/core-llm/src/index.ts`
- Modify: `packages/core-llm/test/security/llm-security.test.ts`
- Modify: `packages/core-llm/test/stream-safety.test.ts`
- Modify: `packages/core-llm/test/connection-resolver.test.ts`
- Modify: `packages/core-llm/test/provider-plugin-registry.test.ts`

**Requirements:**

1. 对 core-tools、core-agent、shared、core-llm 和其调用方执行全仓主动盘点；删除运行时按 Secret/credential 的字段名、参数、URL、值或输出内容进行识别、拒绝、掩码、替换、脱敏或“安全摘要”的每一条链路。
2. core-tools 清理 CommandRedactor、CommandArgumentGuard、argv 拒绝、Capability 专用聚合/脱敏，以及 MCP 配置对命令参数、URL userinfo、URL 查询参数和内容的凭据/Secret 拦截；同时清理 secure-web/web 的 credential-content gate。stdout/stderr 回到普通 bounded spool，HTTP 的普通协议、目标和大小校验保留。
3. agent-host 清理项目 MCP settings/schema/store 与 global config/schema 对明文 key 或 credential 内容的拒绝、掩码和隐藏治理；稳定摘要 API 可以保留，且不强制显示原始值。全局 config.toml 的模型、默认参数、三档权限和企业规则合同保留。
4. core-agent 清理 redaction、Tool error、progress、Tool invocation、Capability diagnostics/discovery、runtime command、prompt、event schema 和 SQLite Journal 路径的内容识别、脱敏与拒绝，使原始外部错误和结果只受普通大小、取消和生命周期合同约束。
5. shared 清理 assertNoSecretMaterial、模式匹配和 credential-content schema 拒绝；保留不依赖内容敏感性判断的结构、类型和范围 schema 校验。
6. core-resource 清理 snapshot/registry 对间接内容的 Secret/credential scanner；保留资源标识、版本、生命周期和结构校验。
7. core-db 清理 connection error 与 credential URL/header 的内容 guard；database-capability 清理 candidate、profile、scalar、URL 和 error 的内容隐藏。保留连接目标、普通协议、结构 schema、操作权限与非内容敏感性错误分类。
8. core-llm 清理 known-secret sanitizer、Provider/resolver/plugin、stream error 和 telemetry 的内容脱敏链；Provider 错误和外部输出可按普通大小/生命周期合同流入 Agent 结果与本地 retention。
9. C 类稳定 typed 错误和稳定摘要可以保留，只要它们不根据 Secret/credential 内容识别、替换或拒绝；不得借此重新引入内容安全治理。
10. 不移除静态操作权限 facts、普通大小/取消/生命周期限制、非内容敏感性 schema 校验，或全局 config.toml 的 default/auto/full-access 三档和企业规则。开发和发布脚本中“不提交真实 key”的仓库卫生扫描保留，不得将其改写成产品安全保证。

**Verification:**

- 针对本任务列出的每个包运行聚焦 typecheck 与变更测试。
- 审计所有运行时命中，确认不存在按 Secret/credential 内容识别、拒绝或脱敏的路径；审计结果必须逐文件列出删除或保留理由。
- 验证静态权限 facts、普通 spool 上限/取消/生命周期与结构 schema 校验仍有效。

## Task 3: 建立第一方 Capability 公共骨架并实现 Git 与 Forge

**Files:**

- Add: `packages/first-party-capabilities/package.json`
- Add: `packages/first-party-capabilities/tsconfig.json`
- Add: `packages/first-party-capabilities/test/tsconfig.json`
- Add: `packages/first-party-capabilities/src/types.ts`
- Add: `packages/first-party-capabilities/src/command-module.ts`
- Add: `packages/first-party-capabilities/src/git-capability.ts`
- Add: `packages/first-party-capabilities/src/forge-capability.ts`
- Add: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/command-module.test.ts`
- Add: `packages/first-party-capabilities/test/git-capability.test.ts`
- Add: `packages/first-party-capabilities/test/forge-capability.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Requirements:**

1. 创建 first-party-capabilities workspace 包，同步根 workspace 与 pnpm-lock.yaml；包声明所需 runtime dependency，并以 tsconfig project reference 引用其直接内部依赖。
2. 公共骨架实现 bounded probe、available/degraded/unavailable、外部 provider choice、immutable generation、刷新、关闭和可行动诊断。
3. 实现设计文档中 Git 的六个 Tool 与 Forge 的七个 Tool；所有 argv 由白名单 enum、长度限制和路径参数构造。
4. Git remote 行为不混入 Git Capability；Forge 只复用 CLI 已有认证，外部登录状态与输出由用户负责。
5. 所有 Tool 的 access、recoveryClass、danger、network/externalWrite/destructive/admin/unknownRisk 与实际调用一致；这些是静态操作事实，不从参数内容推断凭据或 Secret。
6. Tool 输出优先使用 CLI JSON/稳定格式；解析失败返回 typed external failure，外部响应使用普通有界结果合同。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- git-capability.test.ts forge-capability.test.ts command-module.test.ts`

## Task 4: 实现 Containers 与 Language Intelligence

**Files:**

- Add: `packages/first-party-capabilities/src/container-capability.ts`
- Add: `packages/first-party-capabilities/src/language-capability.ts`
- Modify: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/container-capability.test.ts`
- Add: `packages/first-party-capabilities/test/language-capability.test.ts`

**Requirements:**

1. 实现设计文档中 Containers 五个 Tool，支持 docker/podman 外部选择；probe 不触碰 daemon/socket。
2. 所有容器调用显式标记 socket 高权限边界；exec/compose 为高风险非幂等；不声称 sandbox 能约束宿主机 daemon。
3. Language module 根据项目标记与 PATH 发现 TypeScript、Python、Rust、Go、ctags 工具，按可用子能力报告 degraded；父 PATH/env 变化要求重启 Host。
4. 实现 diagnostics、symbols、format；format 只作用于明确工作区路径并声明写权限。每个 backend 逐项声明风险；cargo check/format 不能假称只读。
5. 不启动常驻语言服务器，不新增项目配置或自动安装器。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- container-capability.test.ts language-capability.test.ts`

## Task 5: 实现 Browser、Documents 与 Data & Notebook

**Files:**

- Add: `packages/first-party-capabilities/src/browser-capability.ts`
- Add: `packages/first-party-capabilities/src/document-capability.ts`
- Add: `packages/first-party-capabilities/src/data-notebook-capability.ts`
- Modify: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/browser-capability.test.ts`
- Add: `packages/first-party-capabilities/test/document-capability.test.ts`
- Add: `packages/first-party-capabilities/test/data-notebook-capability.test.ts`

**Requirements:**

1. Browser v1 使用已安装 Playwright CLI，不自动下载浏览器；实现 screenshot、pdf、test，并精确声明 URL、输出文件、网络、写入和代码执行风险。不得把 Playwright 或 notebook 的影响假称为仅限声明路径。
2. Documents 按操作使用 pandoc/pdftotext/pdfinfo；实现 metadata、extract、convert，模块允许 degraded。
3. Data & Notebook 内置有界 JSON/JSONL/CSV profile 与 ipynb inspect；Jupyter 缺失只使 notebook_run unavailable。
4. 所有文件操作准备 canonical target，拒绝越界、symlink 替换、隐式覆盖和无界输入/输出。
5. notebook_run 视为任意代码执行；批准前不得创建输出文件。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- browser-capability.test.ts document-capability.test.ts data-notebook-capability.test.ts`

## Task 6: 增加 Database 标准外部环境 Provider

**Files:**

- Add: `packages/database-capability/src/environment-connection-provider.ts`
- Modify: `packages/database-capability/src/index.ts`
- Add: `packages/database-capability/test/environment-connection-provider.test.ts`

**Requirements:**

1. 发现 `DATABASE_URL` 与 PostgreSQL 标准环境变量，不读取 SchemaNaut 项目或全局 Capability 配置。
2. candidate id、label、metadata、fingerprint 为稳定的连接选择和变更判断服务；Runtime 不将其作为敏感信息识别或脱敏面。
3. resolve 使用外部环境提供的连接值；profile、state、Tool payload、错误和日志遵守普通大小与生命周期合同，用户负责敏感性。
4. 同时存在多个标准来源时返回多个候选并要求 Runtime choice；无来源时返回空候选与可行动诊断。
5. 输入错误返回 typed external failure，不执行原始值的脱敏或凭据拦截。

**Verification:**

- `pnpm --filter @dbagent/database-capability typecheck`
- `pnpm --filter @dbagent/database-capability test -- environment-connection-provider.test.ts database-capability-module.test.ts`

## Task 7: 将八类 Capability 接入 bundled Host 和终端真实入口

**Files:**

- Modify: `packages/agent-host/package.json`
- Modify: `packages/agent-host/tsconfig.json`
- Modify: `packages/agent-host/src/internal/agent-runtime-host-services.ts`
- Modify: `packages/agent-host/src/bundled-agent-runtime.ts`
- Modify: `packages/agent-host/src/agent-runtime.ts`
- Modify: `packages/agent-host/src/global-config.ts`
- Modify: `packages/agent-host/src/global-config.schema.json`
- Modify: `packages/agent-host/src/index.ts`
- Modify: `packages/agent-host/test/capability-runtime.integration.test.ts`
- Add: `packages/agent-host/test/bundled-capabilities.integration.test.ts`
- Modify: `apps/terminal/test/cli-user-workflows.integration.test.ts`
- Modify: `package.json`
- Modify: `scripts/clean-build.mjs`
- Modify: `pnpm-lock.yaml`

**Requirements:**

1. bundled factory 创建/复用一个 ProcessRuntime，并把受限 command Host Port 交给第一方模块；不得暴露 Registry、Journal 或全局配置对象。全局 config 的 require_sandbox 等企业要求必须同步进 AgentRuntime 的 Run policy；补齐 schema、reconciliation 与测试。
2. 注册 Git、Database、Forge、Containers、Browser、Language、Documents、Data & Notebook；注册零外部副作用，首次 Turn 只含静态 discovery manifest。
3. Database 使用环境 Provider；其他 CLI 直接继承用户已配置状态。终端不增加 Capability 配置命令或状态管理 UI。
4. `new AgentRuntime()` 保持无默认专业能力的内部组合入口；终端继续只调用 bundled factory。
5. 验证 `tool_search` 能发现、激活、失败后重新 probe；缺少任一外部依赖时基础 Agent 仍可完成任务。PATH、文件或登录状态变化可重试；父进程 PATH/env 变化要求重启 Host。
6. Task 7 只接入 Task 3 已有的 first-party-capabilities 包；为 agent-host 同步 first-party 与 database capability 的 runtime dependency、相关 tsconfig reference 和 pnpm-lock.yaml，不在此任务重新创建能力包。

**Verification:**

- `pnpm --filter @dbagent/agent-host typecheck`
- `pnpm --filter @dbagent/agent-host test -- bundled-capabilities.integration.test.ts capability-runtime.integration.test.ts`
- `pnpm test:llm-platform:entrypoints`

## Task 8: 建立统一确定性 Agent 场景验收

**Files:**

- Add: `packages/agent-host/test/unified-agent-acceptance.integration.test.ts`
- Add: `scripts/unified-agent-acceptance-scenarios.mjs`
- Modify: `scripts/run-unified-agent-acceptance.mjs`
- Modify: `scripts/tests/unified-agent-acceptance.test.mjs`
- Modify: `package.json`

**Requirements:**

1. 实现设计 §9.1 的十二个确定性场景，使用 scripted/fake model，但真实使用 Journal、Artifact、权限、工作区和进程后端。
2. 每个场景由外部 oracle 验证磁盘/进程/数据库/Artifact/Journal 后置条件；不断言固定自然语言、推理过程或偶然轮次。
3. 统一报告包含 scenario 状态、最终 evidence revision、动作计数、权限证据、恢复完整性、Artifact 摘要和失败分类。
4. required 场景的 not-run 使 release ineligible；显式本地 allow-not-run 仍只能记录 not-run，不能改写为 pass。
5. 覆盖批准前零副作用、批准后恰好一次、取消恢复无 orphan/duplicate、长结果只进引用。

**Verification:**

- `pnpm test:script-contracts`
- `pnpm test:agent-acceptance`

## Task 9: 收束真实 SiliconFlow 功能验收

**Files:**

- Modify: `scripts/lib/live-llm-acceptance.mjs`
- Modify: `scripts/run-general-agent-live-test.mjs`
- Modify: `scripts/run-capability-runtime-live-test.mjs`
- Add: `scripts/run-unified-agent-live-test.mjs`
- Modify: `scripts/tests/live-llm-acceptance.test.mjs`
- Modify: `packages/agent-host/test/general-agent.live.integration.test.ts`
- Modify: `package.json`

**Requirements:**

1. 集中校验 endpoint/key/model；默认 endpoint 为 SiliconFlow OpenAI-compatible，默认 model 为 `deepseek-ai/DeepSeek-V4-Flash`。
2. key 从当前进程环境传给 Provider 是测试接线事实；不从命令行或产品 Capability config 读取，并不构成产品脱敏、拦截或泄漏保护。
3. 子进程输出、Provider 错误和报告字段使用普通大小与生命周期合同；不做产品级脱敏或泄漏回归。
4. 旧 general/capability live 脚本变为统一 runner 的薄入口或兼容选择器，不再维护互相冲突的报告语义。
5. 真实任务至少覆盖基础代码修复、Git/动态加载、Database/长结果三类；以文件、测试、数据库和 evidence 后置条件验证，不匹配固定回答。

**Verification:**

- `pnpm test:script-contracts`
- 在已注入环境变量的受保护进程中运行 `pnpm test:agent-acceptance:live`
- 记录实际功能后置条件与未运行原因；不将输出扫描作为产品级安全验收。

## Task 10: 统一验证、架构复核与文档证据更新

**Files:**

- Modify: `docs/engineering/verification.md`
- Add: `docs/engineering/first-party-capabilities-implementation.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/guides/capabilities.md`
- Modify: `docs/guides/capabilities.zh-CN.md`
- Modify: `CHANGELOG.md`

**Requirements:**

1. 功能开发结束后一次性运行 build、typecheck、lint、完整测试、Capability runtime、确定性 Agent 验收、真实模型验收和可用的 PostgreSQL 场景。
2. 复核依赖方向、固定 12 Tool、动态 Tool 预算、全局权限唯一来源、无 Capability 配置、无直接 child_process，以及无 Sandbox 虚假承诺。
3. 实现报告只记录本次实际运行证据；未运行项保留 not-run 原因，不用内部测试替代真实环境。
4. 用户 Capability 指南和 public roadmap 只更新可见能力状态，不写内部测试计数；工程实现报告记录精确命令和结果。

**Verification:**

- `pnpm build:terminal`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:script-contracts`
- `pnpm test:capability-runtime`
- `pnpm test:agent-acceptance`
- `pnpm test:agent-acceptance:live`
- `git diff --check`
- `rg -n "child_process" packages/first-party-capabilities packages/database-capability`
- 不进行 Secret 专项扫描；报告普通功能结果，并遵守仓库不提交真实凭据的卫生要求。
