# 2026-07-09 desktop Agent ReAct checkpoint 恢复 IPC

## 范围

本切片完成 desktop 主进程的 ReAct checkpoint 恢复入口，不开发 renderer UI。

改动包括：

- 在 shared typed IPC 中新增 `agent:recoverable-checkpoints`、`agent:continue-checkpoint`、`agent:abandon-checkpoint`。
- 在 `HeadlessAgentService` 增加可恢复 checkpoint 列表、继续执行、放弃恢复方法。
- 在 Electron 主进程中注入 `AgentRecoveryService` 并注册对应 IPC handler。
- 增加 desktop 服务级测试，使用真实临时 checkpoint 文件验证恢复生命周期。

## 设计决策

恢复运行必须按当前请求重新计算工具权限，而不是继承旧 checkpoint 的权限。这样能保证用户在恢复前调整 readonly 或插件状态后，恢复任务仍遵守当前授权边界。

本次没有新增开源依赖。原因是项目已有 `core-agent` checkpoint 恢复服务，本切片只是把能力暴露到 desktop IPC；引入外部 workflow/agent runtime 会扩大打包和迁移风险。

## 验收结果

- `packages/shared` 类型检查通过。
- `apps/desktop` 类型检查通过。
- `apps/desktop/src/main/agent-service.test.ts`、`packages/core-agent/test/recovery.test.ts`、`packages/core-agent/test/recovery-runner.test.ts` 共 27 个测试通过。
- 指定文件 ESLint 通过。

## 后续

- 如果 UI 需要“从头重启 ReAct 任务”，再为 `restart` action 设计明确 IPC 行为。
- 将这些接口接入最终 Agent 恢复面板。
- 在 live Agent/RAG eval 中增加真实 provider 的中断恢复场景。
