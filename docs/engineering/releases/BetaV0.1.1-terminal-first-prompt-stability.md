# BetaV0.1.1 终端首屏与状态同步加固

## 背景

用户反馈点击新建终端后仍可能出现终端不显示、无法正常输入或交互反馈不稳定。此前已经接入 `node-pty` 和 xterm，但渲染端仍依赖 React effect 更新终端引用后再由轮询读取输出；在新建终端的首个渲染周期内，首屏 prompt 可能延迟显示。

## 本次调整

- 新建终端后同步更新终端引用，并立即触发一次输出读取，降低首屏空白概率。
- 关闭、清空、轮询输出、Python 输出追加路径均同步维护终端引用，避免旧 cursor 或旧会话状态参与下一轮读取。
- 新增 `appendTerminalSession`，创建终端时按 id 替换旧副本并追加到会话列表末尾。
- Windows 默认 PowerShell 启动参数增加 `-NoProfile`，避免用户本机 profile 脚本在 IDE 终端内输出异常内容或阻塞启动。

## 测试

- `terminal-layout.test.ts` 覆盖终端追加与同 id 替换规则。
- `terminal-service.test.ts` 继续覆盖真实 PTY 输入输出、逐字符输入、工作目录、清屏和错误 shell 回退。

## 验收要点

- 登录后打开终端面板，应按需创建终端并尽快显示 shell prompt。
- 新建多个终端后，活动终端和输出读取不应错乱。
- 清空终端后，后续输出不应从旧 cursor 位置恢复旧内容。
