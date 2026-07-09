# BetaV0.1.1 desktop Headless Agent 策略接线

## 本次增量

- 桌面无 UI Agent 服务支持 ReAct 与 Plan & Execute。
- typed IPC 合同增加策略字段和计划执行摘要。
- 普通任务默认保持 ReAct，复杂分析任务可自动升级到 Plan & Execute。
- 桌面主进程已创建 PlanExecuteAgent，并把计划快照保存到本地用户数据目录。

## 验证

- shared / core-tools / desktop 类型检查通过。
- 目标 lint 通过。
- desktop Agent 服务与工具装配测试通过：15 passed。
- core-tools Skill runner 回归通过：9 passed。

## 限制

- 暂未暴露 Plan 恢复 IPC。
- 暂未运行真实 SiliconFlow + PostgreSQL Plan & Execute live eval。
- 本轮不包含前端 UI 和多数据库能力。
