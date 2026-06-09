# BetaV0.1.1 工作台本地化补齐

## 背景

产品默认中文界面需要避免中英文混杂。主进程原生菜单已经使用中文，但渲染端命令面板、终端工具栏和终端输入辅助标签仍存在硬编码英文，会在中文模式下破坏界面一致性。

## 本次实现

- 为命令面板增加 `commandPalette`、`searchCommands`、`noCommands` 本地化键。
- 为终端工具栏增加 `newTerminal`、`splitTerminal`、`moreActions`、`restorePanel`、`maximizePanel` 本地化键。
- 为终端输入框增加 `terminalCommand` 本地化键。
- 将 `App.tsx` 中命令面板和终端工具栏的硬编码英文替换为 `t(...)`。

## 用户体验约束

- 中文模式下，高频可见入口和 tooltip 不应混入英文。
- 英文模式继续保留原有英文文案。
- 新增文案必须进入 i18n 测试覆盖，避免后续 UI 改动绕过翻译层。

## 测试覆盖

- `i18n.test.ts` 覆盖命令面板和终端工具栏关键中文文案。
- 保留英文切换测试，确保新增键不会破坏英文模式。
