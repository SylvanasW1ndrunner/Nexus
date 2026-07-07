# 2026-07-07 桌面端 Agent 审计日志接入切片

## 背景

上一切片已经在 `core-agent` 中提供 `AgentAuditLogStore` 和 `ReactAgent` 的可选 `auditLog` 依赖，但桌面主进程尚未默认写入本地日志。真实用户通过桌面端运行 Agent 时，仍缺少可复盘的本地执行证据。

本切片把该能力接入 Electron 主进程，保持前端 UI 冻结，不新增 renderer 交互。

## 变更范围

- 新增 `apps/desktop/src/main/agent-audit-log.ts`。
- 在 `apps/desktop/src/main/main.ts` 创建 `DailyAgentAuditLogStore`，并注入 `ReactAgent`。
- 日志写入路径为 `Electron userData/logs/agent-YYYY-MM-DD.jsonl`。
- 无法从事件 timestamp 解析日期时，写入 `agent-unknown-date.jsonl`。
- 增加桌面端审计日志 adapter 测试和 HeadlessAgentService 真实运行写日志测试。

## 模块边界

`DailyAgentAuditLogStore` 只负责桌面端路径选择和每日文件切分。JSONL 写入、损坏行跳过、字段脱敏、长度限制继续复用 `@dbagent/core-agent/AgentAuditLogStore`，避免桌面端复制安全逻辑。

该能力只运行在主进程，不暴露 secret 到 renderer，不改变 IPC 合同。

## 开源方案评估

本切片不引入 OpenTelemetry、LangSmith、Langfuse 或 LangChain tracing。原因如下：

- 桌面端默认能力必须离线可用、可打包、无账号依赖。
- Agent 运行中可能包含数据库 schema、SQL 摘要、连接名称和业务上下文，默认发送到外部 tracing 平台不符合当前隐私边界。
- 项目已经有自有 typed tool、permission、session、usage、audit event 合同，外部 tracing 应作为后续可选导出 adapter，而不是替代本地审计文件。

## 用户级场景

用户在桌面端启动一个 Agent 任务，例如“查看当前工作区的表结构并给出只读建议”。主进程创建 HeadlessAgentService 后，Agent 的 run、model call、tool call、最终状态会被写入当天 JSONL 文件。若任务失败，审计日志仍保留失败事件，便于后续诊断报告读取。

## 验收用例

- 桌面端 adapter 可以按 timestamp 生成每日文件名。
- adapter 写入时复用 core-agent 脱敏逻辑，API key 和数据库密码不得明文落盘。
- HeadlessAgentService 运行一次包含工具调用的真实 Agent 流程后，日志包含 run、model call、tool call、run finished 顺序事件。
- 该变更不影响 renderer 最小宿主，也不引入新的打包依赖。

## 后续

- 诊断报告生成时读取最近 Agent 审计日志，并二次脱敏后纳入报告。
- Agent/RAG eval suite 记录审计日志路径和关键事件摘要。
- 后续如接入云端 tracing，应通过独立 adapter 和显式用户设置实现。
