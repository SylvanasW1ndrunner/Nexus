# BetaV0.1.1 真实交互式终端

## 背景

此前底部“终端”只是一个输入框加输出文本区域，本质上是命令执行面板，不是系统级交互终端。它无法稳定支持方向键、Ctrl+C、持续交互程序、全屏 TUI、shell 补全和真实提示符，因此不满足 IDE 产品要求。

## 技术方案

- 前端使用 `@xterm/xterm` 渲染终端，使用 `@xterm/addon-fit` 根据底部面板尺寸自适应列数和行数。
- 主进程使用 `node-pty` 创建系统 shell 的 PTY 会话。
- 渲染进程通过 IPC 将 xterm 的输入字节写入 PTY，将 PTY 输出流写回 xterm。
- 新增 `terminal:resize` IPC，在面板尺寸变化时同步 PTY 的 `cols/rows`。
- Windows 下启用 `node-pty` 随包 `conpty.dll`，减少关闭终端时的辅助进程异常输出。

## 用户体验

- 终端区域现在是完整 shell，不再需要额外输入框和运行按钮。
- 用户可以直接输入系统命令，按回车运行，输出和提示符保持在同一个终端画布中。
- 多终端、拆分、清空、关闭、重命名继续保留。
- Python 文件右键运行仍会把执行 transcript 写入当前终端，保持数据分析工作流连续。

## 打包注意

`node-pty` 是原生模块，桌面端构建已将其设为 Vite main external。当前 BetaV0.1.1 采用非 asar 打包，并关闭 electron-builder 的 npm rebuild：

```json
"asar": false,
"npmRebuild": false
```

原因是 pnpm workspace symlink 与 asar unpack 组合会误扫 app 目录外文件；同时当前 `node-pty` 预构建可被 Electron 33 直接加载，不需要本地 Python/C++ rebuild。后续恢复 asar 前，必须先处理 workspace 依赖复制策略，并确认 `node-pty` 的 `.node` 文件和 Windows `conpty` 资源位于 unpacked 目录。

本次已通过 `electron-builder --dir` 验证 `release/win-unpacked` 可生成，并通过打包后的 `DBAgent.exe` 校验 `require('node-pty')` 可加载。

## 测试覆盖

- `terminal-service.test.ts` 覆盖 PTY 创建、交互写入/读取、清空、resize、关闭。
- `ipc-contract.test.ts` 覆盖新增 `terminal:resize` 通道。
- TypeScript 构建覆盖 xterm 组件、IPC 请求/响应类型和主进程 handler。
