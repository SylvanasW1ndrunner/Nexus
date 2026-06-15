# BetaV0.1.1 Python 环境配置校验加固

## 背景

项目设置中的 Python 环境配置需要支持 system、venv、conda 三种模式，并且 venv 与 conda 的配置项必须互斥。此前模式切换和目录选择已经做了互斥处理，但手动输入 venv 目录时仍可能写入绝对路径或越界路径，创建 conda 环境也主要依赖前端按钮禁用，主进程缺少同等强度校验。

## 本次调整

- 新增 `isWorkspaceRelativeDirectoryPath`，用于校验手动输入的 venv 目录必须是项目内相对目录。
- Python 配置表单中手动输入 venv 路径时即时拦截绝对路径、空值和 `..` 越界路径。
- 主进程创建 conda 环境时拒绝 `.venv` 这类保留给项目 venv 的名称，避免绕过前端直接调用 IPC。

## 测试

- `python-config.test.ts` 覆盖 venv 手动路径的合法和非法输入。
- `python-environment.test.ts` 覆盖 conda 环境名称在调用 conda 之前被拒绝。

## 验收要点

- venv 模式只保存项目内相对目录，例如 `.venv`、`.venv/smoke`。
- conda 模式只保存 conda 环境名或 conda prefix，不应混入 venv 路径字段。
- IPC 层不能创建名为 `.venv` 的 conda 环境。
