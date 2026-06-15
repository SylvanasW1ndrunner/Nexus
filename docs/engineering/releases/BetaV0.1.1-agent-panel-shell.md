# BetaV0.1.1 右侧 Agent 面板结构收敛

## 背景

右侧栏目标是一个 Agent 对话面板，不是 Chat/Agent 双标签界面。顶部只保留一个 Agent 入口，并在右上角提供三个动作：对话历史、设置、开启新对话。

## 本轮调整

- 将右侧组件从 `ChatPanel` 收敛为 `AgentPanel`。
- 将面板结构样式从 `simple-chat-panel` / `chat-titlebar` 收敛为 `agent-panel` / `agent-titlebar`。
- 新增 `agent-panel.ts`，显式定义右侧栏顶部三个动作：
  - `history`
  - `settings`
  - `new-conversation`
- 顶部按钮由动作模型生成，避免后续误加 Chat/Codex 双标签或多余入口。

## 验证

- `agent-panel.test.ts` 固定右侧栏顶部动作数量和顺序。
- 该调整只收敛 Agent 面板外壳，不接入真正 Agent 执行循环。
