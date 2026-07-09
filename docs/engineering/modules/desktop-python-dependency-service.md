# Desktop Python 依赖服务

## 目标

本模块补齐 Workspace Python 后端在“运行脚本前确认环境可用、必要时安装依赖”这一层能力。当前阶段不开发前端 UI，只提供 typed IPC 和主进程服务，供后续设置页、Agent 工具和诊断报告复用。

## 接口

- `python:verify-dependencies`
  - 输入：`rootPath`、`WorkspacePythonConfig`、模块名列表、可选超时。
  - 行为：在配置指定的 system / venv / conda 解释器中真实执行 Python，用 `importlib.util.find_spec` 检查模块是否可导入。
  - 输出：每个模块的 `installed` 状态、执行命令、cwd、stdout、stderr、耗时和整体 `valid`。

- `python:install-dependencies`
  - 输入：`rootPath`、`WorkspacePythonConfig`、可选 requirements 路径、可选 package spec、可选超时和 upgrade 标记。
  - 行为：在目标解释器内执行 `python -m pip install --disable-pip-version-check`。
  - 输出：复用 `PythonRunResult`，保留 command、cwd、exitCode、stdout、stderr 和耗时。

## 安全边界

- requirements 路径必须是 Workspace 内相对路径，禁止绝对路径和 `..` 越界。
- package spec 使用 `execFile` 参数数组传递，不拼接 shell 命令。
- package spec 拒绝以 `-` 开头的 pip option，避免 UI 或 Agent 输入升级成任意 pip 参数。
- 验证模块名只允许标准 Python dotted module name，避免把任意表达式写入 `python -c`。
- 服务只在主进程运行，renderer 不直接拼接命令。

## 开源与依赖评估

本切片不引入新依赖。

- pip 是 Python 环境的事实标准入口，`python -m pip` 能稳定落到当前解释器所在环境。
- `pipdeptree`、`uv`、`pip-audit` 等工具适合后续做依赖图、漏洞检查和高速安装，但会增加桌面打包、离线可用和平台差异成本。
- 当前目标是最小可用闭环：验证导入、安装 requirements、保留结构化结果。复杂依赖治理后续应沉淀为官方插件或 adapter。

## 测试

`apps/desktop/src/main/python-environment.test.ts` 覆盖：

- 真实系统 Python 检查标准库 `json` 和不存在模块。
- 真实 `python -m pip` 安装空 requirements 文件，验证命令链路可用且不访问包索引。
- requirements 越界路径在启动 pip 前被拒绝。
- package spec 中的 pip option 注入在启动 pip 前被拒绝。

## 后续

- 将依赖验证接入 Workspace 打开和 Agent 脚本运行前置诊断。
- 增加可取消的长时间 pip 安装任务和进度流。
- 在官方插件层评估 `uv`、`pipdeptree`、`pip-audit`，用于更快安装、依赖图和安全审计。
