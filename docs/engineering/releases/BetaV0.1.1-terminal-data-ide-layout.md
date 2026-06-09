# BetaV0.1.1 终端面板数据 IDE 化调整

## 背景

用户明确指出：底部终端区域不是要一比一复制 VSCode，而是借鉴其成熟的信息组织方式，并把对 DBAgent 有用的内容设计成适合数据工程师和分析师的终端面板。

## 本次实现

- 底部标签改为产品本地化标签：问题、输出、终端、端口；移除当前阶段没有实际功能的 `DEBUG CONSOLE` 占位。
- 终端分屏按钮从禁用占位变为可用：
  - 点击后创建第二个 shell 会话。
  - 左侧保留原 active 终端，右侧展示新终端。
  - 两个终端各自保留输出、输入和运行状态。
- 终端最大化按钮从禁用占位变为可用：
  - 最大化时隐藏编辑器区域，终端面板占满中间工作区。
  - 再次点击恢复编辑器 / 底部面板布局。
- 新增终端布局选择辅助函数，覆盖 active 终端、split 终端、缺失会话和重复会话等边界。

## 产品取舍

- 保留 VSCode / JetBrains 的紧凑面板、标签栏和右侧动作区思路。
- 不机械复制 VSCode 的完整面板集合；当前阶段只保留对数据 IDE 有明确价值的入口。
- 分屏优先服务于数据工程常见场景：左侧跑 Python 脚本，右侧观察环境、日志、依赖安装或辅助命令。

## 验证

- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/terminal-layout.ts apps/desktop/src/renderer/src/terminal-layout.test.ts`
- `vitest run apps/desktop/src/renderer/src/terminal-layout.test.ts apps/desktop/src/main/terminal-service.test.ts apps/desktop/src/renderer/src/i18n.test.ts`
