# BetaV0.1.1 终端管理细节补齐

## 背景

底部控制台需要接近 VSCode 和 JetBrains 的多终端管理体验。此前已经支持创建多个持久 shell 会话和关闭终端，但前端不允许关闭最后一个终端，也缺少清空输出的基础操作。

## 本次实现

- 新增 `terminal:clear` IPC 通道。
- `TerminalService.clear(id)` 清空服务端输出缓冲，不关闭 shell 进程。
- 前端终端 tab 允许关闭最后一个终端。
- 当没有终端时，底部控制台显示空状态和创建终端按钮。
- 当前终端增加清空输出按钮。

## 测试

- `terminal-service.test.ts` 覆盖清空输出后 shell 仍保持运行。
- `ipc-contract.test.ts` 覆盖新增 IPC 通道。
