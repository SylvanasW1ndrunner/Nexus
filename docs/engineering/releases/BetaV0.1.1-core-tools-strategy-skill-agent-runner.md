# BetaV0.1.1 core-tools 策略化 Skill Agent Runner

## 本次增量

- 官方 Skill / Auto Skill 后端 runner 已支持 `react` 与 `plan-execute` 两种策略。
- 默认策略仍为 ReAct，不破坏现有官方插件、Skill 自动匹配和 eval runner。
- Plan & Execute 路径继续遵守官方插件工具白名单、Skill allowedTools 和 runtime tool 权限边界。
- 为后续 headless Agent 服务、Plan 面板、checkpoint 恢复和用户级复杂分析任务接线做准备。

## 验证结果

- core-tools 包类型检查通过。
- core-tools runner 目标测试通过：9 passed。
- core-tools 全测试目录通过：23 个测试文件，137 passed，4 skipped。
- core-agent Plan & Execute / recovery 回归通过：14 passed。
- 目标文件 lint 通过。

## 已知限制

- 本切片只完成 core-tools adapter，不自动选择策略；策略自动选择留给后续 orchestrator/headless service。
- 本切片未运行真实 LLM live test；真实 PostgreSQL + SiliconFlow 组合 eval 将作为下一轮服务层接线后的验收项。
- `packages/core-tools/test/tsconfig.json` 仍有 3 个既有测试类型债，运行测试不受影响，后续可单独清理。
