# BetaV0.1.1 Terminal 输出缓冲上限

## 范围

本切片改进 `apps/desktop/src/main/terminal-service.ts` 的后端终端服务，不涉及前端 UI。

## 用户场景

终端是用户运行系统命令、Python、依赖安装和调试脚本的基础能力。长时间运行命令可能产生大量 stdout/stderr，如果主进程无限保存输出，会造成内存增长，并影响后续读取和 UI 渲染。

## 实现

- `TerminalService` 增加 `maxOutputChars` 配置。
- 默认最多保留约 1MB 输出。
- 主进程读取 IDE 设置时，把 `terminal.scrollback` 转成近似字符上限传给服务。
- 输出超过上限时裁剪旧内容，同时维护绝对 cursor。
- `terminal:read` 继续按 cursor 增量读取；即使旧输出已经被裁剪，也不会向调用方返回重复内容。

## 开源与依赖评估

当前服务继续使用已有 `node-pty`。本切片不引入新依赖，因为缓冲上限和 cursor 映射是服务内部状态管理问题，直接实现比引入日志或 ring-buffer 依赖更简单，且不会增加 Electron 打包风险。

## 测试

`apps/desktop/src/main/terminal-service.test.ts` 新增真实 PTY 测试：

- 创建小缓冲终端。
- 写入长输出，确认旧内容被裁剪。
- 验证 read cursor 单调递增。
- 从旧 cursor 继续读取新命令输出，确认不会重复读到被裁剪的旧内容。

现有终端测试继续覆盖：创建、list、run、close、fallback shell、逐字符输入、指定 cwd、clear 和 resize。

## 已知边界

- `terminal.scrollback` 当前按近似 200 字符/行转换，不是严格终端行回放。
- 还未实现终端输出持久化到 workspace。
- 还未把终端进程异常退出做成可恢复任务。
