# 2026-07-06 终端启动期输入队列

## 背景

终端是数据工程师运行 Python、依赖安装、项目脚本和调试命令的核心后端能力。真实 PTY 在 Windows PowerShell/ConPTY 下启动时会先输出终端能力协商和提示符，如果此时立即写入命令，部分输入可能在 shell 尚未完成初始化时被吞掉。

## 本次实现

- `TerminalService` 为新建 PTY session 增加启动期输入队列。
- `terminal:write` 在 shell 未就绪时先缓存输入，调用方仍立即得到成功响应。
- 后端检测到 shell 提示符后统一 flush 缓存输入。
- 如果 shell 不输出提示符，通过短超时兜底 flush，避免永久阻塞。
- 保留 `node-pty` 真实终端能力，不使用 renderer 文本框模拟终端。

## 用户级验收

- 新建终端后立即输入 `echo dbagent-terminal-ready` 应输出对应内容。
- 逐字符输入 `echo dbagent-char-input` 应完整进入 shell，而不是只输入前几个字符。
- 配置错误 shell 时应 fallback 到系统 shell 并能正常执行命令。
- 清空输出、指定 cwd、resize、输出缓冲裁剪不受影响。

## 测试

- `apps/desktop/src/main/terminal-service.test.ts` 使用真实 PTY/PowerShell 覆盖启动后立即写入、逐字符输入、fallback shell、cwd、clear、resize 和缓冲裁剪。
- `apps/desktop/src/main/python-environment.test.ts` 与终端测试一样显式标记真实系统进程用例的长时测试预算，避免默认 5 秒超时掩盖真实结果。

## 边界

- 本次只修复 desktop main 的终端进程服务，不恢复或重建正式前端 UI。
- 当前提示符检测覆盖 Windows PowerShell 和常见 Unix shell；如果后续引入自定义 shell profile 或远程 shell，需要增加对应检测样本。
