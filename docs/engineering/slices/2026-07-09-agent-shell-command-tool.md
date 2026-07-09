# 2026-07-09 Agent Shell Command 工具切片

## 范围

本切片实现 Agent 高风险 shell 命令工具，不涉及前端 UI，不新增依赖。

## 变更

- 新增 `packages/core-tools/src/shell-tools.ts`。
- `core-tools` 导出 shell 工具模块。
- `official.shell-command` 加入官方插件 registry。
- `registerDesktopAgentTools()` 默认注册 `run_shell_command`。
- 补充真实 shell 子进程测试和 Agent bootstrap 测试。

## 验收

- `run_shell_command` 在 ToolRegistry 中是 high-risk、非 readonly、official source。
- auto 模式只允许白名单命令自动执行。
- ask 模式必须审批。
- readonly 和黑名单命令不启动子进程。
- 子进程支持 timeout、AbortSignal、stdout/stderr 截断和敏感环境变量遮蔽。

## 风险

- 当前不是完整 sandbox，也不是 PTY 终端。
- 复杂命令的孙进程清理仍需后续平台化实现。
- 后续应把 shell 执行审计接入 Agent audit log 的结构化摘要。
