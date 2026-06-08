# BetaV0.1.1 增量记录：右侧助手上下文

开发日期：2026-06-08。分支：`BetaV0.1.1`。

## 已实现

- 右侧对话窗口增加上下文卡片，展示当前项目、当前连接和当前编辑文件。
- 上下文卡片复用 Workspace、Connection 和 EditorDocument 状态，不引入新的持久化。
- 查询历史为空时展示明确空状态，避免右栏下半区空白。
- 新增右栏上下文和历史空状态的中英文文案。

## 验证

已通过：

```bash
pnpm run ci
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop exec electron-builder --dir
pnpm package:verify
```

## 设计说明

BetaV0.1.1 的右侧助手暂未接入完整 Agent loop，但界面需要提前体现“对话基于当前项目和当前文件”的产品心智。本轮只做只读上下文展示，避免在 Agent 能力尚未完成前制造不可用的承诺。
