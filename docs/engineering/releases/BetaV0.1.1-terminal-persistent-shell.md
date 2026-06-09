# BetaV0.1.1 持久终端增量

## 目标

本轮把底部终端从“一次性命令执行器”推进为“持久 shell 会话”。这一步是对齐 VS Code / JetBrains 终端体验的基础改造：用户可以创建多个终端，每个终端背后都有独立 shell 进程，前端通过写入 stdin 和读取输出缓冲来持续展示内容。

## 主进程模型

- `apps/desktop/src/main/terminal-service.ts` 为每个终端会话启动一个系统 shell。
- Windows 默认使用 `ComSpec`，通常是 `cmd.exe`；Linux/macOS 默认使用 `SHELL` 或 `/bin/sh`。
- 每个会话维护 `TerminalSession` 元数据和主进程 runtime。
- `terminal:write` 写入 shell stdin。
- `terminal:read` 按 cursor 读取新增输出，避免重复传输全部历史。
- `terminal:close` 会终止对应 shell 进程并移除会话。
- `terminal:run` 暂时保留，作为非交互式命令执行兼容入口和单元测试辅助路径。

## 前端模型

- 渲染层为每个终端维护独立 `cursor`、输入框、输出文本和运行状态。
- 输入框回车后调用 `terminal:write`，不再等待一次性命令返回。
- 前端每 500ms 轮询 `terminal:read`，将新增输出追加到当前终端。
- 输出中主动显示 `> command`，因为非 PTY stdin 通常不会像真实终端一样回显用户输入。

## 当前限制

当前实现仍不是完整 PTY：

- 不能完整支持 TUI 程序、ANSI 光标控制、窗口 resize、复杂交互式输入和 shell 行编辑行为。
- 不能可靠拿到“每一条命令”的退出码，只能拿到 shell 进程退出码。
- 后续要达到 VS Code / JetBrains 级体验，应接入 `node-pty`，并在打包链路中验证 Windows/macOS/Linux 原生模块产物。

## 测试

- `apps/desktop/src/main/terminal-service.test.ts` 覆盖会话创建、列表、一次性命令执行、关闭，以及持久 shell 写入和按 cursor 读取输出。
- `packages/shared/test/ipc-contract.test.ts` 覆盖 `terminal:write` 与 `terminal:read` IPC 通道加入契约列表。
