# BetaV0.1.1 终端启动期输入队列

## 变更摘要

本轮修复真实终端在刚创建后立即输入命令时可能丢字符的问题。`TerminalService` 现在会在 PTY session 启动早期缓存输入，等检测到 shell 提示符后再写入真实 PTY，并保留短超时兜底。

## 影响范围

- 影响 `apps/desktop/src/main/terminal-service.ts`。
- 不涉及正式前端 UI 重建。
- 不改变 IPC 契约，`terminal:write`、`terminal:read`、`terminal:create` 等入口保持兼容。

## 测试记录

- `vitest run apps/desktop/src/main/terminal-service.test.ts`
- `pnpm --filter @dbagent/desktop test`
- `pnpm typecheck`
- `pnpm lint`
- `turbo test --concurrency=1`

其中 desktop 测试和完整测试在非沙箱环境执行，因为 Vite 配置加载和真实 PTY/PowerShell 需要访问本机真实路径。

## 后续

- 后续如果支持自定义 shell profile、远程 shell 或 Linux/macOS 特定登录 shell，需要把提示符检测样本扩展为平台化策略。
- 如果终端输出需要跨应用重启恢复，应另开切片实现输出持久化和 session 恢复。
