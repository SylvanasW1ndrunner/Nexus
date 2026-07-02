# core-agent 行为评估与工具证据

## 目标

Agent/RAG 的测试不能只验证“模型调用过某个工具”。真实用户关心的是：

- Agent 是否用了正确的 schema 检索词。
- Agent 是否把 SQL 指向了正确业务表和字段。
- 工具结果是否包含可验证的业务证据。
- 最终回答是否避免泄露密钥、连接串、内部错误或不应出现的内容。

本模块把这些要求固化为 `core-agent` 的轻量评估合同，供默认测试、PostgreSQL 业务场景测试和后续 live LLM 门控测试复用。

## 代码入口

- `packages/core-agent/src/react-agent.ts`
  - 在每条 `AgentToolExecutionRecord` 中记录 `argumentPreview`。
  - 参数快照在写入前经过 `redaction.ts` 脱敏，并限制最大字符数。
- `packages/core-agent/src/behavior-evaluation.ts`
  - `evaluateAgentBehavior()` 支持工具参数、工具结果、最终回答的正反向断言。
  - `buildAgentBehaviorEvaluationReport()` 在 JSON 和 Markdown 报告中输出脱敏后的工具证据。
- `packages/core-agent/src/types.ts`
  - `AgentBehaviorToolExpectation` 描述每个工具的调用次数、状态、参数和结果期望。

## 合同变更

`AgentToolExecutionRecord` 新增：

- `argumentPreview?: string`：工具调用参数的脱敏摘要。

`AgentBehaviorEvaluationCase` 新增：

- `toolExpectations`：逐工具断言。
- `finalTextExcludes`：最终回答禁止出现的片段。

`AgentBehaviorEvaluationResult` 新增：

- `observedToolDetails`：报告中可展示的脱敏工具证据。

## 工具期望

`AgentBehaviorToolExpectation` 支持：

- `toolName`
- `status`
- `minCalls`
- `maxCalls`
- `argumentIncludes`
- `argumentExcludes`
- `resultIncludes`
- `resultExcludes`

这些规则是确定性的字符串检查，不依赖 LLM judge。它适合作为第一层验收门禁：失败时能直接指出是工具没有调用、参数错误、结果证据不足，还是最终回答泄露了禁止内容。

## 脱敏策略

参数快照调用 `redactPersistedAgentValue()`：

- 对象敏感字段如 `apiKey`、`databaseUrl`、`password`、`token` 会整体替换为 `[REDACTED]`。
- 字符串中的 `sk-...`、Bearer token、PostgreSQL/MySQL URL 密码段会被替换。
- 报告生成和报告存储还会再次执行脱敏，避免历史数据或调用方传入未处理内容。

该策略优先保护用户本地凭证和后续云端凭证。评估报告只保存“足够验收”的证据，不保存原始明文参数。

## 开源方案评估

本切片评估对象是 Agent 评估证据合同，而不是完整在线评测平台。可借鉴方向：

- OpenAI Evals：适合批量评测数据集和模型行为，但会引入独立评测框架，不适合直接进入 `core-agent` 稳定合同。
- promptfoo：适合提示词和 provider 组合回归测试，但默认测试模型/提示层，不能直接表达 DBAgent 的工具权限、工具参数、执行结果和本地脱敏要求。
- LangSmith / LangChain eval 思路：适合 tracing 和可视化，但产品现阶段要保持 core 包不依赖外部云服务或重型 runtime。

结论：本切片自建轻量、确定性的结构化评估合同；后续可在官方 “Agent/RAG Eval” 插件中接入 promptfoo、OpenAI Evals 或其它 runner，并通过 adapter 转换成 `AgentBehaviorEvaluationSummary`。第三方类型不得进入 `packages/shared` IPC 或 `ToolRegistry` 稳定合同。

## 官方插件边界

该能力可以成为官方插件的底座：

- 插件负责注册业务 eval suite。
- 插件负责启动真实 PostgreSQL fixture、真实 LLM 门控和报告目录。
- `core-agent` 只负责通用结果结构、脱敏、报告生成和本地报告索引。

这样可以把高成本、可选的评测运行放在插件层，同时保持核心包轻量和可打包。

## 测试覆盖

- `packages/core-agent/test/behavior-evaluation.test.ts`
  - 工具参数、工具结果、调用次数和最终回答禁止片段。
  - 报告 JSON/Markdown 中工具证据脱敏。
- `packages/core-agent/test/react-agent.test.ts`
  - 真实 Agent run 生成脱敏 `argumentPreview`。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 电商/流量分析业务场景中验证 `search_schema` 与 `query_database` 参数和结果证据。

## 已知边界

- 当前断言是字符串级，不做 SQL AST 语义比较。
- 当前不判断自然语言答案事实充分性；这需要后续 LLM judge 或人工标注集。
- 参数快照是摘要，不是完整审计日志；需要完整审计时应进入独立审计模块，并具备更严格的存储权限。
