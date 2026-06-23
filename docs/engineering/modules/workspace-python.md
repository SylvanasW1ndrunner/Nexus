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

## 后端脚本执行器进展

`packages/core-tools/src/workspace-script-tools.ts` 已新增 `runWorkspacePythonScript()`，作为当前无 UI 阶段的真实 Python 子进程执行器：

- 支持显式 `pythonPath`，后续主进程可从 Workspace Python 配置传入 system / venv / conda 解释器路径。
- 脚本路径通过 workspace 路径规则校验，当前只允许执行工作空间内的 `.py` 文件。
- 运行时把 tool 参数以 JSON 传给脚本，避免拼接 shell 命令。
- 支持超时、取消、stdout/stderr 尾部截断和结构化失败结果。
- 支持运行归档：`scripts/_runs/<runId>/stdout.log`、`stderr.log`、`result.json`，并写入 `.dbagent/history.jsonl`。
- 非零退出、超时和取消都会抛出携带 `WorkspaceScriptRunResult` 的错误，便于 Agent 读取 stderr 后修复脚本。

这一步没有引入第三方 Python runner 或进程管理依赖，原因是当前能力可以用 Node 原生 `child_process.spawn` 稳定实现，新增依赖会增加 Electron 打包、离线安装和跨平台兼容风险。后续如果要支持伪终端、交互式 REPL 或更强资源限制，再单独评估成熟开源方案。

## Python Runtime 解析与检测

`packages/core-workspace/src/python-runtime.ts` 提供 Workspace Python 配置到实际执行命令的后端合同：

- `resolveWorkspacePythonRuntime(workspace)`：把 `WorkspacePythonConfig` 转成可执行命令、前置参数、requirements 路径、超时和网络策略。
- `detectWorkspacePythonRuntime(workspace)`：真实执行 `--version` 检测解释器是否可用，不可用时返回结构化错误而不是抛出到上层。

解析规则：

- `system`：优先使用显式 `pythonPath`，否则使用 `python`。
- `venv`：如果没有显式 `pythonPath`，根据 `venvPath` 拼出解释器路径；Windows 为 `Scripts/python.exe`，Linux/macOS 为 `bin/python`。
- `condaPrefix`：按 prefix 拼出环境内 Python；Windows 为 `python.exe`，Linux/macOS 为 `bin/python`。
- `condaEnvName`：解析为 `conda run -n <env> python`，因此脚本 runner 支持 `pythonArgs` 前置参数。
- `embedded` / `docker`：当前只保留合同，检测结果明确返回 unavailable 和未实现说明。

测试覆盖见 `packages/core-workspace/test/python-runtime.test.ts`：真实系统 Python 检测、坏解释器不可用、venv 跨平台路径、conda env name 解析、embedded/docker 未实现合同。
