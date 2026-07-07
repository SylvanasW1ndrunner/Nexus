# BetaV0.1.1 桌面端 Agent 审计日志接入

## 变更范围

- 新增桌面主进程 `DailyAgentAuditLogStore` adapter。
- `ReactAgent` 在桌面启动路径中默认接入本地审计日志。
- Agent 日志写入 `Electron userData/logs/agent-YYYY-MM-DD.jsonl`。
- 新增桌面端 adapter 测试和 HeadlessAgentService 审计日志集成测试。

## 产品价值

桌面端真实 Agent 任务现在有本地可复盘证据。开发、架构审查和测试验收可以基于同一份 JSONL 事件序列定位模型调用、工具调用、失败状态和权限拒绝路径。

## 安全边界

- 不记录完整 prompt。
- 不记录完整工具结果。
- 写入前复用 `core-agent` 脱敏逻辑。
- secret 不进入 renderer，不新增 IPC 暴露面。

## 验证

- `pnpm --filter @dbagent/desktop typecheck`
- `pnpm --filter @dbagent/desktop lint`
- `pnpm --filter @dbagent/desktop exec vitest run src/main/agent-audit-log.test.ts src/main/agent-service.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- secret 扫描未发现 SiliconFlow 测试 key 进入仓库文件。

## 已知边界

- 当前只完成本地写入，尚未提供 UI 查看入口。
- 诊断报告尚未自动附带 Agent 审计摘要。
- 外部 tracing、云端日志和团队审计面板不在本切片范围内。
