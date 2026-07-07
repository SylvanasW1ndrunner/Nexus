# 2026-07-07 Agent 审计日志存储切片

## 背景

当前开发路径是功能优先、前端最后统一重建。Agent/RAG 后续要做真实 PostgreSQL、真实 LLM、官方 eval suite 和插件权限验证，仅靠测试断言和 checkpoint 不足以复盘一次 Agent run 的完整执行过程。

本切片补齐 `core-agent` 的本地审计日志能力，为测试 Agent、项目架构师 Agent 和后续诊断报告提供稳定数据来源。

## 范围

- 新增 `AgentAuditLogStore`，使用 JSONL 追加写入 Agent 审计事件。
- 新增 `AgentAuditEvent` / `AgentAuditLogWriter` 合同。
- `ReactAgent` 增加可选依赖 `auditLog`，不影响未接入审计日志的调用方。
- 审计覆盖 run、model call、tool call、权限拒绝、配额拦截、异常失败和完成状态。
- 修复工具超时文案重复 return，确保错误信息包含真实超时时间。

## 审计事件

- `run_started`
- `model_call_started`
- `model_call_finished`
- `tool_call_started`
- `tool_call_finished`
- `run_finished`

事件只记录可复盘摘要，不记录完整 prompt、完整工具结果或明文凭证。

## 安全边界

- 写入前复用 `redaction.ts` 做二次脱敏。
- 字符串字段限制最大长度，避免大型结果集写入本地日志。
- JSONL 读取时跳过损坏行，避免异常退出留下的半行阻断诊断。
- 权限拒绝事件在工具 handler 执行前记录，验证危险工具没有副作用。

## 开源优先评估

本切片评估了 OpenTelemetry、LangSmith、Langfuse、LangChain tracing 这类成熟追踪方案的适用性。

当前不引入外部依赖，原因：
- 本阶段需要离线可用、可打包、无账号依赖的本地审计文件。
- 外部 tracing 平台会引入联网、数据出境、SDK 体积、用户授权和隐私边界问题。
- DBAgent 已有 typed tool、permission、session、usage 合同，直接引入第三方事件类型会污染公共边界。

后续如果需要接入外部 tracing，应先通过 adapter 从 DBAgent 自有审计事件导出，并由用户显式开启。

## 测试

- `audit-log-store.test.ts`
  - JSONL 追加写入和最近事件读取。
  - API key、数据库 URL 密码和大字符串脱敏/截断。
  - 损坏 JSONL 行跳过。
- `react-agent.test.ts`
  - 成功 Agent run 写出完整模型与工具审计序列。
  - 只读模式拒绝写工具时写出 denied 审计，并验证 handler 未执行。
  - 工具超时错误包含真实毫秒数。

## 后续

- 主进程接入默认日志路径：`~/.dbagent/logs/agent-{date}.jsonl`。
- 诊断报告生成时读取审计日志并再次脱敏。
- Agent/RAG live eval suite 保存审计日志路径和关键事件摘要。
