# BetaV0.1.1：Agent 工作区高级文件工具

## 新增能力

- Agent 现在可以通过官方工作区文件工具执行精确文件编辑、文件删除、glob 查找和内容搜索。
- `delete_workspace_file` 不会永久删除文件，而是移动到 `outputs/_trash/deleted/...`。
- `glob_workspace` 和 `grep_workspace` 支持用户级常见场景：
  - 查找 SQL 脚本：`sql/**/*.sql`
  - 查找 Python 脚本：`scripts/**/*.py`
  - 搜索指标、表名、函数名或报告内容。

## 安全和边界

- 所有工具都限制在 workspace 托管目录内。
- 搜索默认跳过 `.git`、`.dbagent`、`node_modules` 和 `_trash`。
- 读写编辑仍走 `core-workspace` 路径边界和原子写入。
- 官方插件清单中新增工具风险等级：
  - safe / readonly：`glob_workspace`、`grep_workspace`
  - medium / writable：`edit_workspace_file`、`delete_workspace_file`

## 测试结果

- core-tools TypeScript 检查通过。
- workspace 文件工具真实文件系统测试通过。
- 官方插件注册测试通过。
- 桌面端 Agent 工具 bootstrap 测试通过。
- 桌面 TypeScript build、diff check、smoke check 通过。

## 当前限制

- glob/grep 当前使用轻量 Node 实现，没有引入额外搜索依赖。
- 删除恢复能力目前保留在后端回收目录中，正式 UI 阶段再提供用户可见恢复入口。
