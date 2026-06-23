# BetaV0.1.1 Workspace Python Runtime 检测

## 范围

本切片为 `packages/core-workspace` 增加 Python runtime 解析与检测能力，并让脚本 runner 支持解释器前置参数。不涉及前端 UI。

## 用户场景

用户会在不同机器上使用 system Python、项目 venv 或 conda 环境。后端必须能把工作空间配置解析成实际可执行命令，并在运行脚本前判断解释器是否可用，避免脚本失败时只返回低质量的系统错误。

## 实现

- 新增 `resolveWorkspacePythonRuntime(workspace)`：
  - `system`：显式 `pythonPath` 优先，否则 `python`。
  - `venv`：根据 `venvPath` 生成 Windows / Linux/macOS 解释器路径。
  - `condaPrefix`：根据 prefix 生成环境内解释器路径。
  - `condaEnvName`：生成 `conda run -n <env> python` 命令结构。
  - `embedded` / `docker`：保留合同，明确标记当前未实现。
- 新增 `detectWorkspacePythonRuntime(workspace)`：
  - 真实执行 `--version`。
  - 成功返回版本和解析信息。
  - 不可用时返回 `available: false` 和错误信息，不向上抛出裸异常。
- `runWorkspacePythonScript()` 支持 `pythonArgs`，用于 conda 等需要前置参数的运行方式。

## 开源与依赖评估

未引入新依赖。原因：

- runtime 解析是路径和命令合同问题，Node 原生 `child_process.execFile` 足以检测解释器。
- 目前不需要创建 venv、安装依赖或管理 conda 环境生命周期，因此暂不引入 `conda` wrapper、Python 发行版管理器或原生扩展。
- 保持 core-workspace 无 Electron 依赖，便于单测和后续主进程接线。

## 测试

`packages/core-workspace/test/python-runtime.test.ts` 覆盖：

- 使用本机真实 Python 执行 `--version`。
- 无效解释器返回 unavailable。
- venv 解释器路径在 Windows 与 Linux/macOS 布局下正确。
- conda env name 解析为 `conda run -n <env> python`。
- embedded runtime 当前返回未实现合同。

## 已知边界

- 还未创建 venv 或 conda 环境。
- 还未安装 requirements。
- docker / embedded 只保留配置合同，尚未执行。
- 不做系统级资源限制；脚本进程超时、取消和输出截断由 core-tools runner 负责。
