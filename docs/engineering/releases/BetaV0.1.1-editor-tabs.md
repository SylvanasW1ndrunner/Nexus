# BetaV0.1.1 增量记录：编辑器标签与当前文件状态

开发日期：2026-06-08。分支：`BetaV0.1.1`。

## 已实现

- 中间编辑区增加当前文档标签，展示文件名、语言类型和未保存状态。
- 左侧 Workspace 文件树会高亮当前打开的 SQL/Python 文件。
- 打开 SQL 文件时，编辑器标签记录文件路径并清除未保存状态。
- 打开 Python 文件时，Monaco 切换到 Python 语言并记录当前文件。
- 从 Schema 生成预览 SQL 或从历史查询恢复 SQL 时，会进入临时 SQL 文档并标记为未保存。
- 保存 SQL 后，当前编辑器标签更新为保存后的 Workspace 路径。

## 验证

已通过：

```bash
pnpm run ci
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop exec electron-builder --dir
pnpm package:verify
```

## 设计说明

本轮仍然只实现单编辑器标签，但已经把“匿名编辑器”升级为“有当前文档状态的 IDE 编辑器”。后续如果做多 tab，只需要把当前 `EditorDocument` 扩展成文档数组，并将当前文件树高亮、保存状态和 Monaco 内容切换复用到多文档模型。
