# BetaV0.1.1 Python Conda 执行补齐

## 背景

项目设置允许用户选择 `condaEnvName`，但执行层此前只识别 `pythonPath` 或 `condaPrefix`。这会导致用户在界面中填写 `base`、`analytics` 这类 Conda 环境名后，Python 脚本无法按该环境运行。

## 本次实现

- `PythonEnvironmentService.runScript` 改为构造统一执行调用。
- `system` 和 `venv` 模式继续直接调用 Python 解释器。
- `condaPrefix` 继续解析为环境目录中的 Python。
- `condaEnvName` 现在通过 `conda run -n <name> python ...` 执行。
- 项目配置里的 Python 表单按当前模式过滤自动检测结果。
- Conda 模式保持单一输入框，可手动填写环境名，也可用目录选择写入环境目录。

## 测试

- 新增 Conda 环境名执行测试。
- 测试在本机可用 Conda 时执行真实 `conda run -n base python`，不可用时跳过，避免破坏无 Conda 的构建机。
