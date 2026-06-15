# BetaV0.1.1 终端面板显示与交互修复

## 背景

用户验收反馈：点击新建终端后，终端无法正常显示，也无法输入正常指令交互。此前底层 PTY 测试已经覆盖真实 shell 写入和读取，但 UI 层仍可能因为 xterm 父容器高度不稳定、面板未切换、初始化 fit 时机过早导致显示和输入异常。

## 本轮调整

- 新建终端时强制切换到底部“终端”面板，避免创建成功但用户仍停留在输出面板。
- 点击底部“终端”标签时，如果当前没有终端，会自动创建一个终端会话，避免空面板让用户误以为终端不可用。
- 为终端区域增加 `terminal-panel-body` 容器，明确作为 flex 内容区，保证 xterm 父级有稳定高度。
- xterm 初始化后先执行一次 fit，再通过 `requestAnimationFrame` 在 DOM 布局完成后重新 fit，并在活动终端上聚焦。
- 保留真实 PTY 逐字符输入测试，用于验证终端后端可以按用户键盘输入方式工作。
- 如果用户在 IDE 设置里配置了不可启动的默认 shell，主进程会回退到系统默认 shell，避免终端创建后空白或不可交互。

## 相关收敛

- 右侧栏组件收敛为 `AgentPanel`，顶部动作固定为对话历史、设置、新对话。
- Agent 面板结构类名收敛为 `agent-panel` / `agent-titlebar`，避免继续保留 Chat/Codex 双标签式结构。

## 验证

- `terminal-service.test.ts` 覆盖真实 PTY 创建、逐字符输入、输出读取、工作目录和清屏。
- `terminal-service.test.ts` 也覆盖错误默认 shell 配置下的系统 shell 回退。
- `terminal-input.test.ts` 覆盖 xterm 控制序列过滤。
- `terminal-layout.test.ts` 覆盖新建终端后必须切换到终端面板。
- `agent-panel.test.ts` 固定右侧 Agent 面板顶部三个动作。
- TypeScript 与 ESLint 均通过。
