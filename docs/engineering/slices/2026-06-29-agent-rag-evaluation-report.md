# 2026-06-29 Agent/RAG 业务 eval 报告切片

## 背景

当前开发路线是先完成核心功能，最后统一重建前端 UI。Agent/RAG 已有业务场景测试和 SiliconFlow live 门控入口，但测试结果主要停留在 Vitest 输出里，不利于后续测试 Agent 做用户级验收、回归对比和发布审计。

本切片补齐“真实业务 eval 可报告化、可持久化、可脱敏读取”的后端能力，不改 renderer UI，不改变 Agent 主循环，不把 live LLM 或 PostgreSQL 依赖塞进 `core-agent`。

## 实现范围

- `packages/core-agent/src/behavior-evaluation.ts`
  - 新增 `buildAgentBehaviorEvaluationReport()`。
  - 基于现有 `evaluateAgentBehavior()` 输出生成 `manifest.json`、`results.json`、`report.md` 三类报告文件。
  - 报告生成时复用 Agent 持久化脱敏规则，避免 API key、Bearer token、数据库连接串密码进入验收产物。
- `packages/core-agent/src/evaluation-report-store.ts`
  - 新增 `AgentBehaviorEvaluationReportStore`。
  - 使用 JSON 原子写入保存报告记录。
  - 支持按 `reportId` 读取、列表排序、覆盖更新和损坏 JSON 降级。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - live Agent/RAG 用例在设置 `DBAGENT_AGENT_RAG_REPORT_DIR` 时写入报告文件和 `reports.json`。
  - 默认单元/集成测试不落盘，不污染工作区。
- `scripts/run-agent-rag-live-tests.mjs`
  - live 脚本传入报告目录，默认写到 `tmp/agent-rag-live-report`。
  - `tmp/` 已被 `.gitignore` 忽略，报告不进入提交。

## 开源评估

本切片不引入 RAGAS、LangSmith、OpenAI Evals、LlamaIndex eval 或 tracing 平台。原因：

- 当前验收目标是结构化断言：是否调用了 `search_schema`、是否调用了 `query_database`、是否命中 readonly 权限边界、最终状态是否符合预期。
- 第三方 eval 框架通常需要额外云服务、LLM judge、trace 后端或较重依赖，不适合默认离线测试和 Electron 打包。
- DBAgent 后续仍会保留接入成熟 eval/tracing 项目的 adapter 边界，但第三方类型不能进入 `packages/shared` IPC 或 `core-agent` 稳定合同。

## 测试策略

- 单元测试：
  - 报告 builder 覆盖 JSON/Markdown 文件结构、通过率汇总、失败用例和脱敏。
  - 报告 store 覆盖保存、更新、读取、列表排序、损坏 JSON 降级和脱敏读取。
- 业务集成测试：
  - 复用现有电商、流量分析、退款、广告投放等业务 schema fixture。
  - 默认验证 RAG must-hit、Agent tool calling、readonly destructive SQL 拦截。
- 真实依赖门控：
  - `DBAGENT_RUN_POSTGRES_TESTS=1` 启用真实 PostgreSQL 业务 schema 测试。
  - `DBAGENT_RUN_AGENT_RAG_LIVE=1` 和本机 LLM key 启用 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` live 测试。
  - `DBAGENT_AGENT_RAG_REPORT_DIR` 控制报告输出目录。

## 验收标准

- `core-agent` 仍不依赖 Electron、renderer、SiliconFlow SDK、PostgreSQL driver 或 Vitest。
- 报告默认只包含结构化验收结果、工具名称、状态、迭代次数和脱敏 final text。
- live 报告产物不得包含明文 API key、Bearer token、数据库密码或连接串密码。
- 普通测试不写报告，不污染仓库。
- 报告 store 损坏时返回空列表，不让主进程或测试流程崩溃。

## 后续扩展

- 把报告 store 接入无 UI 的 headless Agent service，供未来 UI 或 CLI 查询历史 eval。
- 在官方插件体系中新增“Agent/RAG Eval”插件，把业务场景、报告生成、门控运行和权限声明插件化。
- 当需要 LLM judge、trace 可视化或跨版本质量趋势时，再按开源优先纪律评估 RAGAS、LangSmith、OpenAI Evals、LlamaIndex eval 等成熟方案。
