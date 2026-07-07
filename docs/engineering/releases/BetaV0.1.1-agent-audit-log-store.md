# BetaV0.1.1 Agent 审计日志存储

## 变更范围

- 新增 `packages/core-agent/src/audit-log-store.ts`。
- `ReactAgent` 支持可选 `auditLog` 依赖，记录 Agent run、模型调用、工具调用和最终状态。
- 审计日志写入前进行脱敏和长度限制，读取时跳过损坏 JSONL 行。
- 修复工具超时错误文案重复 return，保留真实超时时间。
- 补充审计存储测试和 ReactAgent 审计集成测试。

## 产品价值

该能力为三 Agent 开发治理提供基础数据：
- 开发者 Agent 可以用审计日志定位工具调用、模型调用和失败点。
- 项目架构师 Agent 可以检查权限边界、插件工具调用和异常路径是否符合设计。
- 测试 Agent 可以在真实 PostgreSQL / RAG / LLM eval 中保留可复盘证据。

## 开源方案决策

本轮没有引入 OpenTelemetry、LangSmith、Langfuse 或 LangChain tracing。当前目标是本地、离线、可打包、可脱敏的 JSONL 审计；外部追踪平台后续可通过 adapter 作为可选导出能力接入。

## 验证

- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-agent lint`
- `pnpm --filter @dbagent/core-agent test`

说明：第一次使用默认 `pnpm` 入口时触发联网自检失败，随后改用项目本地 `pnpm.cmd` 和 `CI=true` 完成验证。

## 已知边界

- 当前只在 `core-agent` 提供可选合同，尚未由桌面主进程默认写入 `~/.dbagent/logs/agent-{date}.jsonl`。
- 审计日志不记录完整 prompt 和完整工具结果；后续诊断报告需要基于事件摘要和 checkpoint/session store 组合展示。
- 外部 tracing、云端日志和用户可视化审计面板不在本切片范围内。
