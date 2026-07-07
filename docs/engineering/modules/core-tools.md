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
- `workspace-script-tools.test.ts`：脚本声明发现、真实 Python runner、参数校验、非零退出、超时 kill、AbortSignal 取消、stdout/stderr 截断、成功/失败运行归档、旧归档清理和 history 审计。
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
- `archive`：默认开启。运行结束后写入 `scripts/_runs/<runId>/stdout.log`、`stderr.log`、`result.json`，并把摘要追加到 `.dbagent/history.jsonl`。
- `archiveRetention`：归档保留数量，默认 50。超过数量后按 `result.json` 修改时间清理最旧 run 目录。

失败语义：

- 退出码为 0：返回 `WorkspaceScriptRunResult`。
- 非零退出、超时或取消：抛出 `WorkspaceScriptExecutionError`，错误对象携带结构化 `result`，包含 stdout、stderr、退出码、耗时、截断标记、`timedOut` 或 `aborted`。
- 错误 message 使用中文，并保留 stderr 尾部，便于 Agent 或调用方根据错误继续修复脚本。

当前 runner 是进程级隔离与输出控制，不是完整系统沙箱。网络禁用、内存限制、依赖安装策略和数据库连接注入仍由后续 Python runtime / 主进程能力补齐。

归档规则：

- `stdout.log` 和 `stderr.log` 保存 runner 已截断后的输出尾部，和返回给 Agent 的内容一致。
- `result.json` 保存命令摘要、退出码、耗时、截断标记、超时/取消状态和输出文件路径。
- `.dbagent/history.jsonl` 只记录脚本路径、run id、归档目录、耗时、退出码和状态标记，不记录 `args` 或 `env`，避免把业务参数、数据库凭证或 API key 写入审计日志。
- 成功、失败、超时和取消都会尽量归档；如果归档本身失败，会把错误返回给调用方，避免用户误以为运行结果已经保存。
- `_runs` 默认保留最近 50 次运行目录。清理只删除 `scripts/_runs` 下的旧 run 目录，不删除 `.dbagent/history.jsonl`，因此审计记录仍保留。

## 已知边界

- 当前诊断报告返回内存中的文件列表；桌面主进程已经接入日志目录扫描并落盘为报告目录，zip 写入仍留给后续打包体验切片。
- SQL 脱敏使用保守文本规则，会牺牲部分 SQL 上下文；这是诊断报告的刻意选择，优先保护用户数据。
- 二进制 crash dump 当前按文本处理；真正接入系统 dump 时需要在主进程层做大小限制和二进制附件策略。
- Python runner 当前只负责进程启动、取消、超时、输出限制、运行归档和旧归档数量清理；还未实现 conda/venv 自动创建、依赖安装、资源配额或系统级网络隔离。

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

2026-06-24 复验记录：使用本机 `.env` 中的测试专用 SiliconFlow 环境变量运行 `scripts/run-agent-rag-live-tests.mjs`，结果为 5 passed、1 skipped；live case 再次确认模型真实调用 `search_schema` 和 `query_database`，不是普通文本回答。

## Agent 数据库工具安全合同

数据库工具现在按“先预审、再只读查询、最后确认执行”的顺序暴露给 Agent：

- `audit_sql`：只读安全工具，接收 `connectionId` 和 `sql`，返回 `core-db` 的 `QuerySafetyReport`。它不连接执行 SQL，不改变数据库状态，供 Agent 在生成执行计划或向用户解释风险时使用。
- `query_database`：只读查询工具。即使当前连接本身是可写连接，该工具也会以 `readOnly: true` 重新调用 `analyzeSqlSafety()`，只允许单条只读查询；写入、DDL、多语句、未知语句、`WITH` 包裹写操作和 `EXPLAIN ANALYZE` 包裹写操作都会在触达 driver 前拒绝。
- `execute_sql`：写入/DDL 执行工具，`dangerLevel` 为 `high` 且 `readonly: false`。工具 handler 会先调用 `analyzeSqlSafety()`，只读连接阻断写操作；需要确认的 SQL 如果没有 `confirmed: true`，不会调用 driver。

需要注意：`execute_sql.confirmed` 是执行层的技术门禁，不等同于“模型自己声称已经获得用户确认”。当前工具层会同时校验两件事：

- 参数里有 `confirmed: true`。
- `AgentToolContext` 里存在 approval provenance，且 `approval.toolName === 'execute_sql'`。

因此模型直接伪造 `confirmed: true` 不会执行写 SQL；只有经过 `core-agent` approval provider 批准后，工具层才会继续调用 driver。driver 仍保留 `CONFIRMATION_REQUIRED` 兜底，防止绕过工具层的未确认写入。

当前工具层不引入第三方 SQL parser。原因是本轮目标是执行安全边界和 Agent 工具合同闭环；AST 级 affected table、列级权限、函数副作用识别、SQL 改写和跨方言语义分析应作为后续 parser adapter 单独切片处理，并先完成开源方案评估与打包验证。

## 官方插件能力清单

`packages/core-tools/src/official-plugin-registry.ts` 提供官方能力 manifest registry。它不是运行时插件系统，也不注册 tool handler；它只声明官方内置能力、工具贡献、权限范围和安全元数据，用于后续插件市场、设置页、Skill allowedTools 过滤和 Agent 权限策略统一读取。

当前默认官方插件：

- `official.database-postgres`：PostgreSQL schema 浏览、SQL 预审、只读查询和写入执行。
- `official.schema-rag`：本地 Schema RAG 检索、关系上下文和上下文构建。
- `official.workspace-files`：工作区文件列出、读取和原子写入。
- `official.workspace-python`：工作区 Python 脚本动态工具，manifest 中以 `workspace_script:*` 表示动态贡献。
- `official.mcp-client`：MCP 客户端和动态 MCP 工具，manifest 中以 `mcp:*` 表示动态贡献。
- `official.agent-rag-eval`：Agent/RAG 业务验收套件 runner，默认关闭，不贡献 Agent tool，用于发布前质量门禁和后续官方评估插件。

Manifest 稳定字段包括 `id`、`name`、`version`、`publisher`、`category`、`enabledByDefault`、`capabilities`、`permissions` 和 `tools`。权限字段必须声明：

- `resourceScopes`：例如 `database.connection`、`workspace.root`、`mcp.server`。
- `approvalPolicy`：`never`、`mode-dependent` 或 `always`。
- `networkAccess`：`none`、`local` 或 `remote`。
- `processAccess`：`none`、`managed-child-process` 或 `external-service`。
- `secretKinds`：只声明密钥类别，不能包含密钥明文。
- `auditLevel`：审计元数据粒度。

Registry 会拒绝重复 plugin id、单个 manifest 内重复 tool、跨 manifest 的静态 tool 重名和未知 permission 引用。动态工具必须通过 `dynamic: true` 和 `namePattern` 表示来源，不能提前伪装成真实工具。官方插件不会获得特殊放权；真实执行仍必须经过 `ToolRegistry`、`allowedTools`、`dangerLevel`、`readonly`、approval provenance 和具体工具 handler 的边界。

本轮参考了 VS Code Extension Manifest 的声明式元信息/contribution points 模式，以及 MCP Tools 规范中“工具有唯一 name、schema、annotations，敏感操作需要用户确认、超时和审计”的安全原则；但没有引入新依赖，也没有接入网络市场。

`official.agent-rag-eval` 额外参考 OpenAI Evals、promptfoo 和 LangSmith/LangChain eval 的套件/报告/追踪思路，但当前只保留轻量本地 runner 合同。原因是 core 包不能依赖外部云服务，且 DBAgent 需要直接评估工具参数、工具结果、权限边界和脱敏报告。后续接入第三方 eval runner 时，应放在官方插件 adapter 层。

## Agent/RAG Eval Suite Runner

`agent-eval-suite-runner.ts` 提供无 UI 的 Agent/RAG 业务验收入口：

- `runAgentBehaviorEvaluationSuite(options)`：
  - 按 suite case 串行调用传入的 Agent。
  - 每个 case 的 `userTask` 直接作为 `ReactAgent.run()` 的 `userMessage`。
  - 支持 case-level run option 覆盖，例如超时、迭代数或模式。
  - 调用 `evaluateAgentBehavior()` 验证工具证据和最终回答。
  - 调用 `buildAgentBehaviorEvaluationReport()` 生成脱敏报告。
  - 可选写入 `AgentBehaviorEvaluationReportStore`。
- `stopOnFirstFailure` 可作为 release gate 使用，首个失败 case 后停止继续消耗 LLM 或数据库资源。

该 runner 是后续官方 “Agent/RAG Eval” 插件的后端底座。当前 suite 由调用方传入；后续可以从工作区文件、插件 manifest 或 CI 配置加载。

## 官方插件运行时工具策略

`OfficialPluginRegistry.resolveRuntimeTools()` 将官方插件 manifest 和当前真实 runtime tools 连接起来，用于生成 Agent / Skill 可用的 `allowedToolNames`。该函数仍然是纯后端合同，不注册 handler，不启动插件，不访问网络，也不替代 Agent 权限系统。

匹配规则：

- 静态工具按 tool name + runtime source 匹配，例如 `query_database`、`execute_sql`、`read_workspace_file`。未声明 source 的历史内置工具仍可匹配；一旦 runtime tool 声明了 `source: "user-mcp"`、`source: "market-mcp"`、`source: "workspace-script"` 等动态来源，就不能冒充同名官方静态工具。
- 动态工具按 runtime source 匹配，而不是只靠名称前缀。当前官方动态来源为：
  - `workspace_script:*` 匹配 `source: "workspace-script"`。
  - `mcp:*` 匹配 `source: "user-mcp"` 和 `source: "market-mcp"`。
- 如果动态 runtime tool 的名称碰撞官方静态工具名，动态贡献不能接管该名称；该工具必须通过对应静态工具的 source 边界才能被放行。
- `readonlyOnly` 和 `maxDangerLevel` 同时作用于 manifest 贡献和真实 runtime tool，避免真实工具风险高于声明时被放行。
- 重复 runtime tool name 会直接报错，避免上层 Agent 得到不确定白名单。

当前工具来源元数据：

- MCP adapter 已在 `AdaptedMcpToolDefinition` 中写入 `source`、`sourceId`、`originalName`。
- Workspace script tools 现在写入 `source: "workspace-script"`、脚本相对路径和原始工具名。
- 未声明来源的动态工具不会被官方插件动态贡献自动放行。

后续 Agent / Skill 策略层应先从 `ToolRegistry.list()` 读取真实工具，再调用 `resolveRuntimeTools()` 生成 `allowedTools`，最后仍由 `core-agent` 的 permission manager、approval provider 和具体 handler 负责执行前兜底。

## Agent / Skill 工具白名单策略

`official-plugin-tool-policy.ts` 提供上层策略函数，用于把官方插件策略接到真实 Agent run：

- `runtimeToolsFromToolRegistry(registry)`：从 `ToolRegistry.list()` 提取工具名、风险等级、只读标记和来源元数据。
- `resolveOfficialPluginAgentTools(options)`：合并官方插件启用状态、runtime tools、只读/风险过滤和可选 Skill `allowedTools`。
- `toolPermissions`：输出最终允许进入 Agent 的工具权限快照，包括插件 id、贡献项、动态/静态标记、runtime source、权限 id、风险等级、审批策略、资源范围、网络/进程访问和 secret 类型。该字段用于后续无 UI 质量门禁、Agent 运行审计和插件市场权限说明。

调用语义：

- 未选择 Skill 时，`agentAllowedToolNames` 等于官方插件策略允许的运行时工具。
- 选择 Skill 时，`agentAllowedToolNames` 按 Skill `allowedTools` 原始顺序输出，但只保留插件策略允许且 runtime 中真实存在的工具。
- `blockedByPluginToolNames` 表示 Skill 想用但插件策略、运行时缺失、禁用状态或风险过滤导致不可用的工具。
- `blockedBySkillToolNames` 表示插件允许但当前 Skill 未声明的工具。
- `toolPermissions` 只包含 `agentAllowedToolNames` 中最终可执行的工具，不包含被 Skill 或插件策略拦截的工具，避免上层误把“可见诊断”当成“可执行授权”。

上层 Agent runner 应把 `agentAllowedToolNames` 传入 `ReactAgent.run({ allowedTools })`。Skill 不能扩大工具权限；它只能在官方插件和运行时策略允许的范围内进一步收窄工具集合。

## Skill Agent Runner

`skill-agent-runner.ts` 提供无 UI 的 Skill Agent 执行 adapter：

- `renderSkillAgentUserMessage(plan, prefix?)`：把 Skill 名称、说明、系统补充、步骤、输出格式和用户任务渲染成稳定中文任务输入。
- `runSkillAgent(agent, options)`：
  - 调用 `resolveOfficialPluginAgentTools()` 生成最终 `agentAllowedToolNames`。
  - 调用传入的 `agent.run()`，并把最终 allowed tools 传入 `ReactAgent.run({ allowedTools })`。
  - 返回 Agent 结果、工具策略诊断和实际渲染后的用户消息。

该 adapter 的 `SkillAgentPlan` 与 `core-skills` 的执行计划结构兼容，但 `core-tools` 不直接依赖 `core-skills` 包，避免形成不必要的模块耦合。上层主进程可以把 `SkillRegistry.createExecutionPlan()` 的结果传给 runner。

安全边界：

- Skill plan 不能直接获得工具执行权。
- runner 不捕获 provider / tool / quota 错误，不隐藏失败原因。
- 真实执行仍由 `ReactAgent`、permission manager、approval provider 和各 tool handler 兜底。

## 2026-06-28 增量：异步连接读取

`registerDatabaseTools()` 的 `getConnection` 现在支持同步或异步返回，用于适配 desktop main 的 `ConnectionStore.list()`。这保证 Agent 工具执行前读取的是最新连接状态，而不是启动时快照。

受影响工具：

- `audit_sql`：等待最新连接后按 connection `readOnly` 策略生成 SQL 安全报告。
- `query_database`：等待最新连接，并继续强制只允许单条只读查询。
- `execute_sql`：等待最新连接，并继续校验只读策略、确认参数和 approval provenance。

该变更不改变工具名称、风险等级或返回结构。测试需要使用 Promise 断言验证 `audit_sql`，避免同步假设掩盖连接读取问题。
