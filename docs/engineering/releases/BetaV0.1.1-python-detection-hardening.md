# BetaV0.1.1 Python 环境检测增强

## 背景

数据工程师常在 Windows、Linux、macOS 上使用不同 Python 安装方式。此前自动检测只检查 `python`，在 Windows 上容易遇到 Microsoft Store 占位符，在 Linux/macOS 上也可能漏掉只有 `python3` 的系统。

## 实现内容

- 系统 Python 检测从单一 `python` 扩展为多候选：
  - 通用：`python`、`python3`
  - Windows：额外检测 `py`
- 检测结果会优先返回可用解释器；如果全部不可用，保留第一个不可用结果用于 UI 展示错误原因。
- 检测结果按解释器路径、venv 路径、Conda prefix/name 去重，避免列表重复。
- 新建 venv 时，如果用户已经选择了具体系统 Python 路径，会使用该解释器执行 `-m venv`，不再固定依赖 `python` 命令。
- 创建环境后复用 `selectPythonEnvironment` 更新草稿，确保 venv/conda 隐藏字段不会残留。

## 用户影响

- Windows 用户可以通过 `py` launcher 被自动检测到。
- Linux/macOS 用户只有 `python3` 时也能被识别。
- 在项目设置中先选择某个 Python，再新建 `.venv`，会用该 Python 创建虚拟环境。

## 测试覆盖

- `python-environment.test.ts` 覆盖不同系统的 Python 候选规则。
- `python-config.test.ts` 覆盖 venv 创建时解释器选择规则。
- 现有 Python 运行、路径保护、Conda prefix/name 行为继续复用原测试。
