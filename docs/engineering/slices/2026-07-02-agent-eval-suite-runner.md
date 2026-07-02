# 2026-07-02 Agent/RAG Eval Suite Runner 切片

## 背景

项目已经有 Agent 行为评估合同，但调用方仍需要手写循环、报告生成和报告落盘。为了支撑后续真实业务验收、release gate 和官方插件市场，需要一个独立的后端 runner，把“运行 Agent → 评估 → 生成报告 → 保存报告”串成稳定能力。

## 本轮实现

- 新增 `packages/core-tools/src/agent-eval-suite-runner.ts`。
- 新增 `runAgentBehaviorEvaluationSuite()`：
  - 批量运行 Agent case。
  - 支持 case-level run option 覆盖。
  - 支持 `stopOnFirstFailure`。
  - 生成 `AgentBehaviorEvaluationReport`。
  - 可选写入 `AgentBehaviorEvaluationReportStore`。
- 新增默认关闭的官方插件 manifest：`official.agent-rag-eval`。
- 新增 runner 测试和官方插件 registry 测试。

## 模块边界

- `core-tools` 持有 suite runner，因为它连接 Agent、插件策略和测试工具层。
- `core-agent` 保持评估数据结构与报告生成能力。
- 不修改 renderer UI。
- 不新增依赖。
- 不启动外部 eval 平台或 MCP/市场网络。

## 验收标准

- Runner 能运行至少一个业务 case，并把 Agent run 结果转成评估报告。
- 报告中敏感 key 被脱敏。
- 失败 case 可阻断后续 case。
- 官方插件 manifest 不改变默认 Agent 工具暴露。
- TypeScript、lint 和相关测试通过。

## 后续

- 把现有 SiliconFlow live Agent/RAG 测试迁移到 suite runner。
- 支持从工作区或插件 manifest 加载 eval suite。
- 为 PostgreSQL fixture 增加 suite 生命周期，保证每个 case 数据隔离。
