# BetaV0.1.1 开发过程 Skills

## 新增能力

本次新增 6 个项目级开发 skill，用于约束当前“先完成核心功能、最后统一开发前端 UI”的开发模式：

- `dbagent-backend-slice-execution`
- `dbagent-contract-ipc-development`
- `dbagent-real-integration-testing`
- `dbagent-docs-sync-development`
- `dbagent-dependency-packaging-review`
- `dbagent-release-version-discipline`

## 影响范围

- 仅影响开发流程与任务执行规范。
- 不修改产品运行时代码。
- 不重建 renderer UI。

## 验证

已使用 skill-creator 的 `quick_validate.py` 校验 6 个 skill，均通过。

Windows 下需设置 `PYTHONUTF8=1` 后校验中文 skill 文件。

## 当前限制

这些 skill 位于仓库 `skills/` 目录中，便于版本管理；如需让本地 Codex 自动发现，需要后续同步到 Codex 的全局 skill 目录或在会话中显式引用。
