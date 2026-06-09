# BetaV0.1.1 Python 环境路径加固

## 背景

Python 环境配置是数据工程 IDE 的核心能力。前端已经把 venv 和 conda 做成互斥配置，并提供自动检测、目录选择和环境创建；但主进程也必须独立兜底，不能只依赖前端约束。

## 本次实现

- `PythonEnvironmentService` 在运行 venv 脚本时校验 `venvPath`：
  - 禁止绝对路径。
  - 禁止 `..` 逃逸 workspace。
  - 运行前即失败，不启动外部 Python 进程。
- Conda 单输入框语义在主进程补齐：
  - `condaEnvName` 如果是普通名称，继续使用 `conda run -n <name> python`。
  - 如果输入看起来像路径，则按 Conda prefix 解析，直接使用该 prefix 下的 Python 解释器。
- 这样即使用户手动编辑 `.dbagent/workspace.json`，运行层也不会执行越界 venv 配置。

## 测试覆盖

- Python 服务检测不抛错。
- 系统 Python 执行 inline code。
- workspace 相对 `.py` 文件执行。
- 拒绝 workspace 外 Python 脚本路径。
- 拒绝 workspace 外 venv 路径。
- Conda 单输入框传入路径时按 prefix 执行，而不是误当成环境名。
- Conda 环境名在可用时继续走 `conda run -n`。

## 验证

- `vitest run apps/desktop/src/main/python-environment.test.ts`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/main/python-environment.ts apps/desktop/src/main/python-environment.test.ts`
