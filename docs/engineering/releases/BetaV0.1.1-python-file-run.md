# BetaV0.1.1 Python 文件路径运行增量

## 目标

上一轮 Python 运行已经能执行当前编辑器内容，但实现方式是 `python -c code`。本轮补齐 IDE 更常见的运行语义：如果当前 Python 文档已经保存到项目内，则按真实文件路径执行；只有未保存文档才回退到执行编辑器内容。

## 执行策略

- 已保存 Python 文件：
  - 如果有未保存修改，前端先保存当前文件。
  - 保存成功后调用 `python:run-script`，传入 `relativePath`。
  - 主进程解析为 workspace 内绝对路径后执行 `python script.py`。
- 未保存 Python 内容：
  - 前端传入 `code`。
  - 主进程继续使用 `python -c code` 执行。

## 安全边界

主进程负责校验 Python 文件路径：

- 必须是相对路径。
- 必须留在 workspace 根目录内。
- 必须是 `.py` 文件。

renderer 不直接拼接 shell 命令，也不允许传入绝对路径绕过 workspace 边界。

## 测试

- `apps/desktop/src/main/python-environment.test.ts` 增加：
  - 按 workspace 相对路径运行 Python 文件。
  - 拒绝 `../escape.py` 这类路径逃逸。

## 后续

后续仍需补：

- 运行配置面板。
- 取消运行。
- 长任务和后台任务列表。
- 输出文件登记。
- 环境变量配置。
