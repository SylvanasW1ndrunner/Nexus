# BetaV0.1.1 Agent 输出安全硬阻断

## 变更

- 新增 `outputSafety: { pii: 'block' }` 显式硬阻断模式。
- 工具结果包含邮箱、手机号、加密字段或密钥类信息时，不再进入 Agent 上下文，而是记录为 `output_safety` 可恢复失败。
- Agent 可以基于安全错误改写查询，例如从行级客户查询改为城市维度聚合查询。
- 最终回复包含敏感信息时返回 `safety_blocked`。
- 行为评估支持验证工具调用是否被阻断。

## 验证

- 类型检查、lint、core-agent 全量测试、core-tools 全量测试均通过。
- PostgreSQL 集成脚本通过，覆盖真实 PG 查询、取消、认证、业务 fixture RAG/Agent 流程。

## 打包影响

- 无新增依赖。
- 需要确保 `packages/core-agent/dist` 与源码同步，因为下游 workspace 包测试和运行会通过包名读取 dist。
