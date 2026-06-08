# BetaV0.1.1 优化记录

> 开发日期：2026-06-08。开发分支：`BetaV0.1.1`。目标：优化 `betaV0.1` 的前端体验，并引入项目级 Workspace 管理。

## 定位

`BetaV0.1.1` 是 `betaV0.1` 的体验优化版本，不改变底层 PostgreSQL 执行能力，重点解决两个问题：

- 前端从临时三栏页面升级为面向商业化产品的桌面 IDE 工作台。
- 引入 Workspace/项目概念，让 SQL、脚本、文档和导出物能够按项目沉淀。

## 已实现范围

- 新增 `WorkspaceProject`、`WorkspaceSummary`、`WorkspaceRecentState` 等共享类型。
- 新增 Workspace IPC：选择目录、新建项目、打开项目、最近项目、当前项目。
- 新增 `workspace-project-store.ts`，在主进程创建真实项目目录和 `.dbagent/workspace.json`。
- 标准模板生成 `.dbagent/`、`queries/`、`sql/`、`scripts/`、`skills/`、`docs/`、`outputs/`、`notebooks/`。
- 最近项目写入 Electron `userData/data/workspaces.json`，打开项目时自动置顶。
- 项目文件树展示 `sql/`、`queries/`、`scripts/`、`docs/`、`outputs/`。
- SQL 编辑器支持将当前 SQL 保存到 `sql/analytics/`，并写入 `@name`、`@connection`、`@tags`、`@updated` 元信息。
- 点击项目文件树中的 SQL 文件，可回读到中间编辑器继续编辑或运行。
- 顶部 `File` 下拉菜单支持新建项目弹窗和打开项目；新建项目时可选择同时建立数据库连接，也可以先跳过。
- 顶部 `Settings` 下拉菜单支持项目配置弹窗，可修改 SQL 库、脚本、文档和输出目录。
- 中间编辑器升级为 Monaco Editor，支持 SQL 和 Python 语法高亮。
- Renderer 改为左侧项目/连接/Schema、中间 SQL 编辑器/结果、右侧对话/历史的三栏工作台。
- 顶部加入文件、运行、设置下拉菜单和语言切换入口。
- 新增中英文 UI 字典，默认中文，支持切换英文。

## 测试

新增和更新测试：

- `workspace-project-store.test.ts`：创建真实项目目录、写入配置、生成 starter 文件、打开已有项目、最近项目置顶、拒绝普通目录、保存/读取可复用 SQL、拒绝非受管路径读取。
- `i18n.test.ts`：默认中文、英文切换、未知语言回退。
- `ipc-contract.test.ts`：纳入 Workspace IPC 快照。

当前已通过：

```bash
pnpm --filter @dbagent/shared test
pnpm --filter @dbagent/shared typecheck
pnpm --filter @dbagent/desktop test
pnpm --filter @dbagent/desktop typecheck
```

## 未完成事项

- Python 脚本运行、Agent 工具注册、SQL 参数化执行和文件 diff 预览仍属于后续增量。
- 右侧对话窗口目前是界面入口，尚未接入完整 Agent loop。
- 需要继续做打包验证和本地界面截图审查，确认商业化 UI 在真实窗口中不重叠、不白屏。
