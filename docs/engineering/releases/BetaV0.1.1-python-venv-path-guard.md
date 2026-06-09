# BetaV0.1.1 Python venv 路径保护

## 背景

项目配置要求 `venvPath` 必须是工作区内相对路径。此前用户通过目录选择器选择 venv 时，renderer 会把绝对路径直接写入草稿，保存项目设置时由主进程拒绝，体验不清晰，也容易让 Windows 用户误以为目录选择不可用。

## 本次实现

- 新增 renderer 路径工具 `toWorkspaceRelativeDirectory`。
- venv 目录选择只接受项目目录内的目录。
- 工作区内目录会转换为相对路径保存，例如 `.venv` 或 `envs/Py39`。
- Conda 环境目录仍保存为 `condaPrefix`，允许绝对路径。
- 选择项目根目录本身或项目外目录时，前端直接提示并阻止写入无效配置。

## 测试

- 覆盖 Windows 路径转换。
- 覆盖 POSIX 路径转换并保留大小写。
- 覆盖空 root、项目根目录和项目外目录拒绝。
