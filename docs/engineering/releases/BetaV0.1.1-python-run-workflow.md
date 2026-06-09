# BetaV0.1.1 Python 运行闭环增量

## 目标

本轮把已有的 `python:run-script` 主进程能力接到 IDE 前端，使用户可以从当前 Python 编辑器直接运行脚本，并在底部控制台看到 stdout、stderr、退出码和耗时。

## 入口

- 原生菜单：`运行 -> 运行当前 Python`
- 快捷键：`F6`
- 命令面板：
  - `Run Current Python File`
  - `dbagent.python.runCurrentFile`

## 执行流程

1. 前端确认当前编辑器语言是 Python。
2. 前端确认已经打开项目，因为 Python 运行目录必须是项目根目录。
3. 前端调用 `python:run-script`，传入：
   - `rootPath`
   - 当前项目 Python 配置
   - 当前编辑器内容
   - 运行超时
4. 主进程根据 `WorkspacePythonConfig` 解析解释器：
   - `system`
   - `venv`
   - `conda`
5. 执行结果追加到底部控制台。

## 插件命令

官方 Python Runner 插件新增贡献命令：

- `dbagent.python.runCurrentFile`

该命令只在当前编辑器是 Python 且已经打开项目时启用。

## 当前边界

- 当前运行方式是 `python -c code`，适合脚本内容执行，但还不是完整的“运行文件路径”模型。
- 暂未支持取消运行、长期后台任务、环境变量面板和输出文件登记。
- 后续应支持按真实文件路径执行、运行配置、任务列表和进程取消。
