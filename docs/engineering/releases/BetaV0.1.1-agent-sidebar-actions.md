# BetaV0.1.1 Agent 侧栏顶部动作完善

## 背景

右侧 Agent 侧栏在 M1.5 阶段只需要完成 IDE 外壳和交互骨架，不接入真正 Agent 执行链路。但顶部三个按钮必须是可理解、可操作的界面，而不是纯装饰。

## 本次实现

- 保留右侧 Agent 侧栏单一入口，不再出现 Chat / Agent 双标签。
- 顶部右侧三个按钮分别对应：
  - 对话历史：展示已归档会话，支持点击恢复。
  - 设置：控制是否把项目、连接、当前文件上下文显示在输入框上下文区。
  - 新对话：归档当前含用户消息的对话，并创建新的欢迎会话。
- 新增 `agent-chat` 状态辅助模块，用于会话标题生成、会话归档、欢迎消息创建。
- 历史归档最多保留 20 条，避免本地状态无限增长。

## 当前边界

- 当前仍不接入真实 Agent 执行、模型调用、RAG 或工具链。
- 对话历史当前存于前端运行态，后续应接入本地工作区存储或账号侧同步。
- 设置项当前只控制上下文 chip 的显示，后续接入 Agent 时应成为请求上下文选择策略的一部分。

## 验证

- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/agent-chat.ts apps/desktop/src/renderer/src/agent-chat.test.ts`
- `vitest run apps/desktop/src/renderer/src/agent-chat.test.ts apps/desktop/src/renderer/src/i18n.test.ts`
