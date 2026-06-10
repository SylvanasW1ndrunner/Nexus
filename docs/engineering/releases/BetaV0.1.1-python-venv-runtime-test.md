# BetaV0.1.1 Python venv 运行链路验证记录

## 背景

产品面向数据工程师和分析师，Python 脚本执行是 IDE 的核心能力。仅检测 Python 或执行系统 Python 不足以证明 venv 配置可用，因此本轮补充真实 venv 创建和执行链路测试。

## 本次补强

- 在 `PythonEnvironmentService` 测试中新增真实 venv 场景。
- 测试会在临时工作区中调用 `python -m venv` 创建 `.venv/smoke`。
- 创建成功后通过该 venv 执行 Python 代码。
- 断言输出包含业务标记 `venv-run-ok`，并确认 `sys.prefix` 指向临时工作区内的 venv。

## 测试策略

该测试依赖本机 Python 的 venv 能力：

- 如果 `python -m venv --help` 不可用，测试会跳过真实创建步骤。
- 如果可用，则必须完整创建 venv 并通过该 venv 执行脚本。

这种策略避免把用户机器缺失 Python 解释器误判为产品失败，同时在具备 Python 的开发机上覆盖真实业务路径。
