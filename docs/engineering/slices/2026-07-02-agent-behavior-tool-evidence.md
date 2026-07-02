# 2026-07-02 Agent 行为评估工具证据切片

## 背景

项目当前采用“先完成后端功能，最后统一重建前端”的开发模式。Schema RAG 已经支持显式引用与 on-demand indexing，下一步需要提高 Agent/RAG 验收质量：不能只看 Agent 是否调用了 `search_schema` 或 `query_database`，还要验证调用参数和工具结果是否真的符合业务任务。

## 本轮实现

- `ReactAgent` 在工具执行记录中新增脱敏 `argumentPreview`。
- `evaluateAgentBehavior()` 支持：
  - 工具调用次数断言。
  - 工具状态断言。
  - 工具参数包含/禁止片段。
  - 工具结果包含/禁止片段。
  - 最终回答禁止片段。
- 行为评估报告在 Markdown 中输出脱敏工具证据。
- Agent/RAG 业务场景测试开始验证真实工具参数和结果证据。

## 模块边界

- 只修改 `packages/core-agent` 与 `packages/core-tools` 测试。
- 不触碰 renderer UI。
- 不改变 LLM provider、数据库 driver、RAG 检索排序或 IPC 合同。
- 不引入新的第三方依赖。

## 开源优先结论

本切片暂不引入 OpenAI Evals、promptfoo 或 LangSmith 类框架。原因：

- 当前目标是 core 层稳定数据合同，而不是完整评测平台。
- DBAgent 的验收需要直接检查工具参数、权限结果、脱敏结果和业务工具返回值，通用 eval runner 仍需要 adapter。
- 新增重型依赖会增加 Electron 打包、离线使用和版本维护成本。

后续可以把这些框架放入官方 “Agent/RAG Eval” 插件，通过 adapter 读取 suite、运行任务，再输出 `AgentBehaviorEvaluationSummary`。

## 验收标准

- 默认单元测试能验证工具参数/结果/禁止片段规则。
- ReactAgent 真实执行路径会产生脱敏参数快照。
- Agent/RAG 业务测试能用增强 eval 验证 `search_schema` 和 `query_database` 的参数与结果证据。
- TypeScript 类型检查通过。
- 报告中不出现明文 API key 或数据库密码。

## 风险与后续

- 当前字符串断言无法证明 SQL 语义完全正确，后续需要 SQL parser/AST 级检查。
- 当前 live LLM 报告只做结构化证据检查，答案质量还需要更强的业务标注集或 LLM judge。
- 参数快照不是审计日志，后续写操作审计应由独立 audit 模块持久化。
