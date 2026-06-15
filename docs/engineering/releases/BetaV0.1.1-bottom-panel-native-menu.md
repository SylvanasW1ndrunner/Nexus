# BetaV0.1.1 底部面板原生菜单入口

## 背景

底部面板已经支持 `问题 / 输出 / 终端 / 端口`，并且可以从命令面板打开。为了让桌面 IDE 的入口更接近 VS Code / JetBrains，原生菜单的 `视图` 菜单也应提供同样入口。

## 修复内容

- `视图` 菜单新增：
  - 问题
  - 输出
  - 终端
  - 端口
- `问题` 使用 `CmdOrCtrl+Shift+M`。
- `终端` 使用 `CmdOrCtrl+\``。
- renderer 侧复用 `bottom-panel-command.ts` 的映射，不再为菜单单独维护一套分发逻辑。
- `显示终端` 仍复用现有终端打开流程，没有终端时会创建真实终端会话。

## 测试覆盖

- `bottom-panel-command.test.ts` 覆盖命令面板 ID 和原生菜单 command 字符串都映射到同一动作。
- `bottom-panel.test.ts` 继续覆盖问题面板诊断规则。
