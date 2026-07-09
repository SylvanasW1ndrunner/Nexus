# BetaV0.1.1 MCP 运行时退出恢复

## 变更

- MCP runtime manager 支持记录 server 异常退出。
- 异常退出后自动移除该 server 注册到 Agent 的工具。
- 支持按 health 中的 `nextRestartAt` 重启到期 server。
- 补充 MCP runtime、health、adapter、registration manager 测试。

## 验证

- core-tools 类型检查通过。
- MCP 相关 Vitest 测试通过。
- touched files ESLint 通过。

## 发布备注

该变更只补齐后端恢复能力。桌面主进程后续接入真实 MCP 子进程 exit 事件和后台调度器后，用户连接的 MCP server 在异常退出时不会继续向 Agent 暴露过期工具。
