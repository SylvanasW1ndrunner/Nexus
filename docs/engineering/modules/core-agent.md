# core-agent Agent 执行模块

## 代码入口

- `packages/core-agent/src/react-agent.ts`：ReAct Agent 主循环，负责模型调用、工具调用、权限检查、用量归因和终止状态。
- `packages/core-agent/src/behavior-evaluation.ts`：从用户任务角度评估 Agent run 结果是否符合预期。
- `packages/core-agent/src/context-manager.ts`：Agent 上下文预算、token 估算、本地工具结果摘要和早期消息归档。
- `packages/core-agent/src/checkpoint-store.ts`：Agent iteration checkpoint 持久化，用于崩溃后识别可恢复任务。
- `packages/core-agent/src/session.ts`：会话、消息和 usage 累加工具。
- `packages/core-agent/src/tool-registry.ts`：Agent 工具注册表，暴露 LLM tool schema。
- `packages/core-agent/src/permission-manager.ts`：工具权限决策。
- `packages/core-agent/src/types.ts`：Agent 会话、消息、工具、运行选项和结果类型。

## 开发逻辑

`core-agent` 不依赖 Electron，不直接访问数据库、文件系统 UI 或密钥。它通过 `LlmRouter` 调模型，通过 `ToolRegistry` 调业务工具，通过 `UsageTracker` 记录用量。具体工具能力由 `core-tools`、`core-db`、工作空间模块或后续 MCP adapter 提供。

当前主循环是 ReAct：

1. 创建 session，写入用户消息。
2. 检查 subscription quota。
3. 启动 usage round。
4. 调用模型生成 assistant message 和 tool calls。
5. 对每个 tool call 做 allowedTools、权限和注册状态检查。
6. 执行工具，把 tool result 写回 session。
7. 继续下一轮，直到模型无 tool call、达到迭代上限、用户中止、权限拒绝或配额耗尽。

工具失败路径有连续失败熔断：默认连续 3 次工具执行失败后，`ReactAgent` 返回 `tool_failed`，保存 failed checkpoint，并把 usage round 关闭为 `failed`。调用方可以通过 `maxConsecutiveToolFailures` 调整阈值。单次 SQL 错误、工具异常或未注册工具仍会先作为 tool message 回传给模型，让下一轮有机会自我修复；只有连续失败达到阈值时才停止，避免长任务在明显不可恢复状态下持续消耗模型调用。

工具执行有统一超时保护：`ReactAgent` 默认给单次工具调用 60 秒，调用方可通过 `maxToolExecutionMs` 调整。超时会触发传给工具的 `AbortSignal`，并把稳定的中文错误写入 tool message，例如“工具 query_database 执行超时（60000ms）。”。这类超时不直接让整个进程异常退出，而是作为工具失败进入下一轮上下文；如果连续失败达到 `maxConsecutiveToolFailures`，则返回 `tool_failed`、保存 failed checkpoint，并把 usage round 标记为 failed，避免卡死的 MCP、数据库、Python 或 shell 工具无限消耗用户时间。

每轮调用模型前，`ReactAgent` 会通过 `buildAgentContext()` 构造上下文。默认预算足够大，不影响短会话；调用方可以通过 `contextWindowTokens`、`keepRecentMessages` 和 `maxToolResultChars` 控制压缩强度。当前压缩策略是本地确定性实现：

- 大型 tool result 摘要化，保留原始长度、开头和结尾。
- 如果仍超出预算，归档早期非 system 消息，保留最近消息。
- 返回压缩报告，包含压缩等级、原始/最终 token 估算和 warning。

当前不引入 tokenizer 或 memory 框架。后续接入 `tiktoken` / `js-tiktoken`、LLM 摘要或第三方 memory 方案前，必须按开源优先规范评估许可证、打包、离线和安全边界。

## 开源借鉴与复用边界

Agent 能力开发默认先调研成熟开源项目、SDK 或架构模式，再决定复用、adapter、fork、借鉴设计或自研。重点包括：

- workflow / tool calling / ReAct / Plan-Execute / 多 Agent 调度。
- checkpoint、session store、memory、tracing、eval、guardrail。
- streaming parser、schema validator、工具参数校验、运行日志和观测。
- MCP 或插件工具适配。

无论最终是否引入依赖，都必须在对应 release note 或模块文档记录官方来源、许可证、打包/离线影响、安全边界、DBAgent 合同适配和测试计划。第三方框架类型不能进入 `packages/shared` IPC 合同或 `ToolRegistry` 的稳定公开模型；必须通过 adapter 转成 DBAgent 自有的工具、权限、会话、用量和诊断结构。

选择自研时必须说明拒绝成熟方案的原因，例如 Electron 打包不稳定、离线不可用、许可证不兼容、权限边界不足、API 与 DBAgent typed tool 合同不匹配，或该能力属于产品差异化核心。

## Checkpoint 策略

`AgentCheckpointStore` 使用 JSON 文件原子写入保存 checkpoint。每条 checkpoint 包含：

- session id、iteration、status。
- 当前 session 快照。
- 已执行工具记录。
- finalText、错误信息、startedAt、updatedAt、finishedAt。

checkpoint 写入和读取都会做敏感信息脱敏，避免恢复文件、诊断流程或测试快照泄露凭证。当前脱敏覆盖：

- 对象字段：`apiKey`、`authorization`、`connectionString`、`databaseUrl`、`dsn`、`password`、`secret`、`token`、`accessToken`、`refreshToken` 等精确敏感键。
- 字符串内容：`Bearer ...`、常见 `sk-...` API key 形态、PostgreSQL/MySQL URL 中的密码段，以及 JSON/文本里的 `password: ...`、`apiKey: ...` 等片段。
- 历史 checkpoint 文件读取时也会脱敏，避免旧版本已经写入的敏感内容通过 `listBySession()` 或 `listRecoverable()` 重新暴露。

本轮没有引入 `fast-redact`、`pino` redaction 或其它第三方脱敏库。原因是 checkpoint 合同当前是本地 JSON 快照，敏感字段集合可控，使用确定性本地规则可以减少打包依赖和 Electron 分发风险。后续如果日志、诊断报告、session store、SQLite checkpoint 统一进入同一条链路，应把脱敏规则抽到 shared/core 级公共模块，并补充更系统的模式测试。

`ReactAgent` 的 checkpoint store 是可选依赖。传入后会在以下节点保存：

- 每轮模型调用前：`running`。
- 模型返回 assistant message 后：`running`。
- 每个工具成功、失败或拒绝后：`running`。
- 最终完成、权限拒绝、迭代上限、token budget 触发后：`done`。
- 用户中止：`aborted`。
- provider 或主循环异常：`failed`。

`listRecoverable()` 只返回每个 session 最新 checkpoint 为 `running` 的任务。已完成、已失败或已中止的 session 不会出现在可恢复列表里，避免应用重启后错误提示用户恢复已结束任务。`markInterrupted()` 用于启动扫描时把上次异常退出遗留的 running checkpoint 标记为 failed。

`packages/core-agent/src/recovery.ts` 在原始 checkpoint 之上提供服务级恢复合同：

- `AgentRecoveryService.listRecoverablePlans()`：把 running checkpoint 转成面向用户/主进程的恢复计划，包含原始任务、停在哪个 iteration、成功/失败/拒绝的工具数量、最近 assistant 文本、最近工具错误、可选动作和续跑提示词。
- `AgentRecoveryService.abandon()`：把用户放弃恢复的 running checkpoint 标记为 `abandoned`，后续启动扫描不再提示。
- `resumePrompt` 是确定性文本，供后续“继续执行”入口创建新的 Agent run 或恢复 run 时使用。它会摘要已完成工具，要求 Agent 不要无理由重复已成功工具调用。

当前恢复服务不直接自动续跑工具。原因是真正继续执行还需要 LLM provider、工具注册表、权限 provider、活动数据库连接、工作区和 UI 确认状态全部就绪；本切片先保证启动扫描、恢复决策和放弃操作的后端合同稳定。后续主进程接线时应先调用 `listRecoverablePlans()`，由用户选择继续、重跑或放弃。

## Stream 持久化

`packages/core-agent/src/stream-store.ts` 提供 Agent/LLM 流式响应的本地持久化合同：

- `AgentStreamStore.start()`：创建一个 stream record，记录 session、round、provider 和 model。
- `appendEvent()`：保存 `text-delta`、`tool-call-delta`、`tool-call`、`usage`、`finish` 等 LLM stream event，并累计当前文本、工具调用、usage 和最终响应。
- `markIncomplete()`：网络中断或 provider stream 异常时保留已收到文本，并让 `listRecoverable()` 返回该 stream。
- `markAborted()`：用户主动停止时保留部分文本，但不进入可恢复列表。
- `persistAgentStreamEvents()`：包装 `LlmRouter.stream()` / provider stream，边转发事件边落盘；异常时自动标记 `incomplete` 或 `aborted`。
- `ReactAgent`：调用方传入 `streamStore` 后，模型调用路径会使用 `LlmRouter.stream()`，并把每轮模型响应写入 stream store；未传入时仍保持原有非流式 `chat()` 路径。

stream store 与 checkpoint store 复用同一套 `redaction.ts` 脱敏规则，防止 tool call 参数、错误信息、final response 中的 API key、Bearer token、数据库连接串密码等进入本地恢复文件。

当前 stream 持久化是可选依赖，便于主进程后续按设置或 UI 能力逐步打开。它已经保证 stream store 中的事件与 Agent 实际使用的模型响应一致，避免 UI 看到的流式内容和恢复文件不一致。

## 权限边界

- readonly 模式下，非 readonly 工具在执行前被拒绝。
- ask 模式下，中高危工具需要 approval provider；没有 approval provider 时不会执行。
- allowedTools 是技能/工作流的硬白名单，即使工具已注册也不能越权调用。
- 工具失败会作为 tool message 回传给模型，允许下一轮自我修正。
- 连续工具失败达到阈值后会停止 Agent run，返回 `tool_failed`，不会按成功轮次计费。
- 单次工具调用默认 60 秒超时，超时会向工具传播 abort signal，并进入同一套失败恢复/熔断路径。

### SQL 工具权限策略

Agent 不直接解析 SQL，也不直接访问数据库 driver。SQL 风险判断归属 `core-db`，数据库工具适配归属 `core-tools`，`core-agent` 只负责工具可见性、执行模式、用户确认和拒绝后的可恢复对话。

当前策略：

- readonly Agent 模式下，`execute_sql` 因 `readonly: false` 会在工具 handler 前被拒绝；`audit_sql` 和 `query_database` 可以执行，但仍受 `allowedTools` 限制。
- `query_database` 是面向分析任务的只读工具；模型即使在可写连接上请求写 SQL，也会被 `core-tools` 二次拦截。
- `execute_sql` 是 high 风险工具。在 ask / auto 模式下需要 approval provider；没有批准时不会触达 handler。在 full-auto 模式下仍受工具风险等级、连接只读状态和 `core-db` driver 硬门禁约束。
- 模型返回隐藏工具或未在 `allowedTools` 中声明的 `execute_sql` 时，`ReactAgent` 会拒绝该 tool call，并把拒绝结果写入工具执行记录。
- Driver 层的 `CONFIRMATION_REQUIRED` 是最后兜底：即使上层误放行，未带确认标记的写 SQL 仍不会触达 PostgreSQL pool。

`core-agent` 已补齐“确认来源”合同：`PermissionManager.checkDetailed()` 会区分 `automatic` allow 和 `approval-provider` allow。只有 approval provider 批准后的工具调用，`ReactAgent` 才会把 `approval` provenance 写入 `AgentToolContext`，包含 tool call id、tool name 和批准时间。这样 `execute_sql.confirmed` 不再只依赖模型参数；工具层可以校验确认来源，再决定是否把 `confirmed` 传给 driver。

当前边界：full-auto 对 high 工具的自动 allow 不会生成 approval provenance，因此需要确认的 SQL 仍会被 `core-tools` 拦截。后续如果产品要支持“全自动但允许特定写入”的模式，应新增显式策略和审计记录，而不是复用模型传入的 `confirmed: true`。

## 行为评估

`evaluateAgentBehavior()` 用于把 Agent 测试从内部路径推进到用户效果验收。调用方为每个真实用户任务提供期望状态、必须调用工具、禁止调用工具、工具执行状态、最终回答关键内容、最终回答禁止片段和迭代数范围；评估器返回每条 case 的失败原因和汇总通过率。

工具执行记录现在包含脱敏后的 `argumentPreview`，用于验证真实 Agent run 是否把正确业务上下文传给了工具。评估 case 可以通过 `toolExpectations` 检查：

- 指定工具的最小/最大调用次数。
- 指定工具的执行状态。
- 工具参数必须包含或禁止包含的片段。
- 工具结果必须包含或禁止包含的片段。

这样 Agent/RAG 业务验收可以判断模型是否真的检索了 GMV/ROI schema、是否查询了正确表、工具结果是否包含可解释证据，而不是只看“调用过工具”。参数快照在写入前执行 `redaction.ts` 脱敏，报告生成和报告存储会再次脱敏，避免 API key、Bearer token、数据库连接串密码或敏感字段值进入验收报告。

当前评估器不直接调用 LLM，也不引入第三方 Agent eval 依赖。它用于默认测试中的确定性质量基线；后续接入真实 SiliconFlow/DeepSeek、LLM judge 或开源 eval 框架时，必须按开源优先规则记录许可证、打包、离线、安全和成本影响。

`buildAgentBehaviorEvaluationReport()` 在评估汇总之上生成可持久化的验收报告，当前包含 `manifest.json`、`results.json` 和 `report.md`。报告记录结构化验收结果、工具名称、状态、迭代次数、脱敏后的工具证据和脱敏后的最终回答；不持久化原始明文凭证或完整审计日志。

`AgentBehaviorEvaluationReportStore` 提供本地 JSON 报告索引，使用原子写入，支持保存、覆盖、按 `reportId` 读取和倒序列表。读取路径会再次执行 Agent 脱敏规则，避免历史报告中的 API key、Bearer token 或数据库连接串密码被重新暴露。损坏 JSON 会降级为空列表，避免测试/主进程启动时被单个坏报告阻断。

该能力是后续官方“Agent/RAG Eval”插件的后端基础：插件可以负责注册业务场景、运行真实依赖门控、保存报告和暴露权限声明；`core-agent` 保持通用合同，不依赖具体数据库、RAG fixture、LLM provider 或 UI。详细设计见 `docs/engineering/modules/core-agent-behavior-evaluation.md`。

## 测试覆盖

- `permission-manager.test.ts`：不同模式和工具危险级别下的权限决策。
- `checkpoint-store.test.ts`：checkpoint 原子持久化、同一 iteration 更新、可恢复任务列表、running 标记中断、损坏 JSON 降级。
- `react-agent.test.ts`：只读数据库工具调用、只读模式写操作拦截、ask 模式未授权拦截、工具失败后模型恢复、工具执行超时与 abort signal、超时进入连续失败熔断、allowedTools 白名单、subscription quota 拦截、用户中止、provider 失败不计费、checkpoint 与 Agent 主循环集成。
- `context-manager.test.ts`：小会话不压缩、大型工具结果摘要、长会话早期消息归档、超小预算 warning 和 token 估算。
- `behavior-evaluation.test.ts`：按用户任务评估 Agent 状态、工具调用、工具状态、工具参数、工具结果、最终回答和迭代范围。

## 已知边界

- 当前 checkpoint 使用 JSON 文件，适合本地 beta 阶段；大量会话和并发写入场景应迁移到 SQLite WAL。
- 当前只实现任务恢复计划、续跑提示词和放弃任务，不自动续跑中断任务；真正续跑需要后续主进程恢复入口接入 provider、tool registry、permission 和活动连接状态。
- 当前 stream store 通过可选依赖接入 `ReactAgent.run()`；默认路径仍是非流式 `chat()`。后续 `agent:run` 流式 IPC 可基于同一 store 发事件给 UI。
- 当前连续失败熔断只统计工具执行失败和未注册工具，不把用户拒绝权限计入失败；后续可以按工具类型区分 SQL 语法错误、网络错误和 MCP 不可用，做更细粒度的重试策略。
- 当前工具超时由 Agent 层统一兜底，具体工具如 MCP、Python、shell 或数据库长查询仍应在自身实现中补充更强的进程 kill、连接取消或资源释放逻辑。
- 当前不实现多 Agent 协作调度。
- 当前行为评估器只评估 Agent run 的结构化结果，不评估自然语言答案的事实充分性；真实 LLM 效果评估后续通过环境门控测试补充。
- 当前上下文 token 估算是近似值，真实模型窗口仍需要 provider 层或 tokenizer 层二次校验。

## Schema RAG 工具适配

`packages/core-agent/src/schema-rag-tools.ts` 提供 Agent 与 `core-rag` 的只读工具适配层。当前注册四个内置工具：

- `search_schema`：按业务问题、表名、字段名或 glossary 术语检索 schema，并返回紧凑 context。
- `describe_table`：描述单表字段和直接关联表，表名歧义时要求补充 schema。
- `list_tables`：列出已索引表，供 Agent 做轻量 schema 浏览。
- `get_relations`：返回单表的一跳关系上下文。

这些工具全部标记为 `dangerLevel: safe` 和 `readonly: true`，因此可在 readonly 模式下执行；同时仍受 `allowedTools` 限制，Skill 或运行计划没有显式允许时不会暴露给模型，模型强行返回隐藏工具调用也会被拒绝。工具参数允许显式传 `connectionId`，也允许由运行环境提供 `defaultConnectionId`，后续桌面端激活连接后可以把当前连接注入工具注册过程。

测试覆盖见 `packages/core-agent/test/schema-rag-tools.test.ts`：

- 工具注册后的模型可见 schema、危险等级和只读属性。
- GMV 等业务术语通过 RAG glossary 命中真实字段，并返回可进入下一轮 Agent 上下文的结构化结果。
- 未配置活动连接时拒绝调用，避免 Agent 在无连接状态下伪造结果。
- `ReactAgent` 集成场景验证：模型先调用 `search_schema`，工具结果进入 tool message，下一轮回答基于 `public.orders.total_amount`。

本切片没有引入 LangChain、LlamaIndex、Haystack 或其它 Agent/RAG 框架。原因是当前目标是 typed tool adapter 和权限接线，直接适配现有 `ToolRegistry` 更稳定；未来若引入外部 Agent workflow 或 RAG tool adapter，应按开源优先规范记录依赖、许可证、Electron 打包、离线运行和安全边界。

## Session Store

`packages/core-agent/src/session-store.ts` 提供 Agent 会话历史持久化。当前使用 JSON 原子写入实现本地 beta 阶段合同，后续可迁移到 SQLite WAL，但对上层暴露的行为保持稳定：

- `save()`：保存或更新完整 `AgentSession`，保留首次创建时间并刷新更新时间。
- `load()`：按 session id 加载完整消息历史。
- `list()`：按归档状态、关键词、分页返回摘要，默认隐藏已归档会话。
- `update()`：修改标题、模式或中止状态。
- `archive()` / `delete()`：归档、恢复或删除会话。
- `fork()`：从指定消息位置创建新分支会话。
- `export()`：导出 JSON 或 Markdown，方便用户回看、审计或提交问题。

`ReactAgent` 现在支持可选 `sessionStore` 依赖。传入后会在用户消息写入、assistant 回复、tool result、权限拒绝、完成、中止和异常路径保存会话。这样即使最终 UI 尚未重建，Agent 运行结果也已经具备可恢复和可导出的后端基础。

当前不新增 SQLite、ORM 或数据库依赖。原因是 `core-agent` 需要保持轻量、可在测试中独立运行；本阶段 JSON 原子写入足以验证会话合同和用户场景。后续如果会话数量、并发写入或跨模块查询要求提高，应迁移到 SQLite，并补充 WAL、迁移、损坏恢复和大历史性能测试。
