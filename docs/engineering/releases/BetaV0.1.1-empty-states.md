# BetaV0.1.1 增量记录：工作区空状态与快速入口

开发日期：2026-06-08。分支：`BetaV0.1.1`。

## 已实现

- 左侧项目面板在未打开 Workspace 时展示明确的空状态。
- 空状态提供“新建项目”和“打开项目”两个快速入口，复用顶部 `File` 菜单的项目流程。
- 最近项目区域增加标题和空列表提示，避免首次打开时出现无意义空白。
- 已打开项目但文件树为空时，展示标准目录骨架：`.dbagent/workspace.json`、`sql/`、`scripts/`、`docs/`、`outputs/`。
- 移除 `Settings` 菜单里没有行为的“语言设置”项；语言切换保留在右上角显式控件。
- 相关文案纳入中英文 i18n 字典。

## 验证

已通过：

```bash
pnpm run ci
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop exec electron-builder --dir
pnpm package:verify
```

## 设计说明

首次打开体验是 BetaV0.1.1 前端商业化观感的重要部分。用户没有项目时，界面应该主动告诉用户下一步做什么，而不是只显示空面板。该空状态只提供项目入口，不在页面内重复数据库连接向导，避免破坏“项目优先、连接可后建”的产品路径。
