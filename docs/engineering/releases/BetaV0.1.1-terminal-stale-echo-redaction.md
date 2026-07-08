# BetaV0.1.1 - 终端旧输入回显清理

## 背景

桌面终端后端使用真实 PTY，不模拟系统终端。Windows PowerShell/ConPTY 会把用户输入和行编辑控制序列回显到输出流中。输出缓冲发生裁剪后，如果旧命令仍残留在保留窗口内，后续读取可能再次看到已经滚出窗口的旧输入片段，导致用户体验和测试结果不稳定。

## 变更内容

- `apps/desktop/src/main/terminal-service.ts` 在旧输入从 recent 转为 stale 时，同时清理当前保留缓冲区。
- 后续新增输出仍继续执行 stale input echo 清理。
- 不改变真实 shell 执行、写入、resize、clear、close 或 cursor 合同。

## 验收标准

- 终端输出超过 `maxOutputChars` 后，旧输出被裁剪。
- `read()` 返回的 cursor 保持单调递增。
- 后续命令输出中能看到新命令结果，但不再包含已裁剪旧命令的输入回显片段。
- 测试使用真实 PTY，而不是 mock 终端。

## 验证

- `pnpm --filter @dbagent/desktop test -- src/main/terminal-service.test.ts`
- `pnpm --filter @dbagent/desktop test`
- `pnpm --filter @dbagent/desktop lint`
