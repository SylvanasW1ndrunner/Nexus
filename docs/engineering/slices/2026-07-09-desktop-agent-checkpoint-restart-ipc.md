# 2026-07-09 desktop Agent ReAct checkpoint 重启恢复 IPC

## 范围

本切片补齐 ReAct checkpoint 恢复的 `restart` 动作，使恢复摘要中的 `continue`、`restart`、`abandon` 三类动作都有后端服务入口。

改动包括：

- `core-agent` 的 `AgentRecoveryService` 新增 `restart` 方法。
- shared typed IPC 新增 `agent:restart-checkpoint`。
- `HeadlessAgentService` 新增 `restartCheckpoint`，按当前请求重新计算工具权限。
- Electron 主进程注册 `agent:restart-checkpoint` handler。
- 增加 core 和 desktop 服务级测试，使用真实临时 checkpoint 文件验证生命周期。

## 设计决策

ReAct restart 与 continue 的区别：

- continue 注入旧 session 和旧 iteration，从中断点继续。
- restart 不注入旧 session，而是用原始用户任务、旧中断位置、旧工具结果摘要生成 restart prompt，让 Agent 新建 session 重新执行。
- restart 成功后旧 checkpoint 标记为 abandoned；restart 失败或返回非 done 状态时旧 checkpoint 继续保留为 recoverable。

本次没有新增第三方依赖，继续复用项目内 recovery/store 能力。

## 验收结果

- `packages/core-agent` 类型检查通过。
- `packages/shared` 类型检查通过。
- `apps/desktop` 类型检查通过。
- `packages/core-agent/test/recovery.test.ts`、`packages/core-agent/test/recovery-runner.test.ts`、`apps/desktop/src/main/agent-service.test.ts` 通过。

## 后续

- 最终 UI 恢复面板可以直接绑定三个动作：继续、重启、放弃。
- live Agent/RAG eval 后续补真实 provider 中断后 restart 行为。
