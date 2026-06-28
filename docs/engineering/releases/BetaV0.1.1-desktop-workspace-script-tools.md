# BetaV0.1.1 增量：桌面端 Agent 动态 Python 脚本工具

## 变更

- 桌面端 Agent runtime 支持刷新当前 active workspace 的 `workspace_script:*` 动态工具。
- 创建、打开、更新 workspace 后会刷新脚本工具；启动时也会尝试恢复上次 active workspace 的脚本工具。
- 切换 workspace 后旧脚本工具会被卸载，旧 handler 在执行前也会校验 active root。
- 工作区 Python 配置会被用于 Agent 脚本执行，包括 system、venv、conda 和默认超时。
- core-tools 在注册脚本工具前校验重复工具名，避免部分注册。

## 验证

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 动态脚本工具刷新、执行参数注入、stale workspace 拦截、项目切换卸载旧工具。
- `packages/core-tools/test/workspace-script-tools.test.ts`
  - 异步 root provider、重复工具名、真实 Python runner 既有路径。

## 已知限制

- 文件 watcher 尚未接入，脚本新增或修改后需要触发 workspace 刷新。
- 当前不是完整安全沙箱；已具备超时、取消、输出截断和 workspace 路径边界，后续再补网络、内存和依赖安装策略。
- 前端 UI 仍冻结，本增量只保证后端 Agent runtime 可用。
