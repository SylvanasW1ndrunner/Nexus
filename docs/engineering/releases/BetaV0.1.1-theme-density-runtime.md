# BetaV0.1.1 主题与密度运行时生效增量

## 目标

此前 IDE 设置已经可以保存 `theme` 和 `density`，但前端工作台仍固定深色视觉。本轮把设置真正接到运行时 UI，使主题和界面密度在保存后可见生效。

## 实现

- `App.tsx` 在根节点挂载：
  - `theme-dark` / `theme-light`
  - `density-compact` / `density-comfortable`
- Monaco 编辑器主题随 IDE 主题切换：
  - dark -> `vs-dark`
  - light -> `light`
- `styles.css` 末尾增加 runtime override，覆盖旧的固定深色块。

## 覆盖范围

当前 light 主题覆盖：

- 顶部栏
- 左右侧栏
- 编辑器外围
- 结果区
- 设置弹窗
- 命令面板
- 终端输出
- Agent 对话侧栏
- 状态栏

密度设置覆盖：

- 按钮高度和 padding
- 输入框 padding
- 顶栏高度
- 常用标题栏高度
- 设置卡片和弹窗 padding

## 后续

后续仍需要继续减少历史硬编码颜色，把所有组件统一迁移到变量体系；但本轮已经保证用户保存的主题和密度设置有真实可见效果。
