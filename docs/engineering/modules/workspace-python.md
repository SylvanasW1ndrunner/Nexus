# Workspace Python 环境与项目向导

## 目标

Nexus 面向数据工程师和分析师，项目不仅保存 SQL，也要保存 Python 脚本、依赖声明、运行输出和项目级配置。BetaV0.1.1 先完成配置与 UI 边界：用户新建或打开项目后，可以在 Workspace 配置中维护 Python 环境，后续脚本执行器必须读取这份配置。

## Workspace 配置

`WorkspaceProject` 增加 `python: WorkspacePythonConfig`：

- `mode`：`system`、`venv` 或 `conda`。
- `pythonPath`：可选解释器路径，例如系统 `python`、Windows `python.exe` 或 Conda 环境解释器。
- `venvPath`：可选项目内虚拟环境目录，例如 `.venv`。
- `requirementsPath`：依赖文件路径，默认 `scripts/requirements.txt`。

`workspace:create` 支持在创建项目时写入 Python 配置；`workspace:update-settings` 支持覆盖保存 Python 配置。主进程会创建 `requirementsPath` 的父目录，并在项目初始化时写入 starter requirements 文件。

## 路径约束

`requirementsPath` 和 `venvPath` 必须是 Workspace 内的相对路径，不能使用绝对路径或 `..` 逃逸。`pythonPath` 可以是系统路径，因为用户常常使用已经安装在操作系统或 Conda 环境中的解释器。renderer 不直接写配置文件，所有配置落盘都通过主进程完成。

## 新建项目向导

新建项目入口位于顶部 `File` 菜单。弹窗采用类似 JetBrains 的向导结构：

- 左侧是数据库类型列表，当前只开放 PostgreSQL，但结构上保留 MySQL 等后续数据库入口。
- 右侧填写项目名称、目录、描述和模板。
- 用户可以选择创建项目时同时创建数据库连接，也可以先跳过连接，后续再配置。
- 同一弹窗内提供 Python 环境配置，支持 system、venv 和 conda。

该设计把“项目资产管理”和“数据库连接”解耦。项目可以先被创建并保存脚本、SQL、文档；数据库连接仍作为全局资源保存，凭证不进入项目目录。

## 测试覆盖

`apps/desktop/src/main/workspace-project-store.test.ts` 已覆盖：

- 创建项目时写入默认 Python 配置和 `scripts/requirements.txt`。
- 创建项目时指定 venv、`.venv` 和自定义 requirements 路径。
- 项目设置中切换到 conda 后覆盖保存 Python 配置，并确认旧 venv 路径不会残留。
- 重新打开项目后，Python 配置可以从 `.dbagent/workspace.json` 复原。

## 后续开发约束

后续脚本执行器应基于 `WorkspaceProject.python` 决定解释器、依赖文件和运行目录，不能让 renderer 拼接 shell 命令。执行器还需要单独处理 Windows 与 Linux 路径差异、运行超时、stdout/stderr 日志、依赖安装失败、输出文件登记和取消运行。
