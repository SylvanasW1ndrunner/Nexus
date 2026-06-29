# BetaV0.1.1 - 终端有界输出 cursor 修正

## 变更

- 修正 desktop 主进程 `TerminalService.read()`：
  - `cursor=0` 仍表示首次读取当前快照。
  - 非零 cursor 如果已经落后于裁剪基线，不再回放当前整段缓冲，而是返回空 chunk 并推进到最新可读基线。
- 修正终端输出裁剪：
  - 超出 `maxOutputChars` 后优先按换行/回车边界裁剪。
  - 降低 Windows ConPTY 长命令重绘导致旧命令片段混入新读取窗口的概率。
- 增加有界缓冲下的 stale input echo 过滤：
  - 当历史输出已被裁剪后，再写入新命令时，把旧输入 echo 标记为 stale。
  - 后续 PTY 重绘旧输入片段时替换为 `[trimmed-input-echo]`，避免污染新 cursor 读取窗口。

## 验证

- `node .\node_modules\vitest\vitest.mjs run apps\desktop\src\main\terminal-service.test.ts`
- `node .\node_modules\typescript\bin\tsc -p apps\desktop\tsconfig.json --noEmit`

## 边界

- 本次不改 renderer UI，不引入新的终端依赖。
- 后续如果需要完全还原终端屏幕语义，应在 renderer 继续交给 xterm.js 处理 raw PTY stream；主进程只负责 bounded buffer 和 cursor 合同。
