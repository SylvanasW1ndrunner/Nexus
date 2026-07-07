# BetaV0.1.1 桌面端诊断报告服务

## 变更范围

- 新增桌面主进程诊断报告服务。
- 新增 `app:generate-diagnostic-report` typed IPC。
- 诊断报告现在可以收集桌面端配置、主进程日志、Agent 审计日志和 crash 快照，并落盘为本地目录。
- 新增真实文件系统测试，覆盖采集、脱敏、缺失目录容忍和路径逃逸防护。

## 产品价值

用户遇到 Agent、RAG、连接、Python 或插件问题时，后续 UI 可以直接调用该服务生成可反馈的诊断包。测试 Agent 和发布验收也可以把本地 Agent 审计日志纳入同一份报告，形成可复盘证据链。

## 安全边界

- 不读取 `credentials.json`。
- renderer 只得到报告目录和摘要，不直接拿报告内容。
- 报告内容由 `core-tools` 统一脱敏。
- 当前不生成 zip，不新增压缩依赖。

## 验证

- `pnpm --filter @dbagent/shared build`
- `pnpm --filter @dbagent/desktop typecheck`
- `pnpm --filter @dbagent/desktop test -- src/main/diagnostic-report-service.test.ts`
- `pnpm --filter @dbagent/shared test -- test/ipc-contract.test.ts`

说明：桌面端 Vitest 在默认 sandbox 下会触发 Vite/esbuild 配置读取权限问题，实际验证使用非 sandbox 命令完成。

## 已知边界

- 诊断报告当前输出目录，不输出 zip。
- 暂未收集 PostgreSQL 运行诊断、MCP 健康状态和插件健康快照。
- 最终 UI 入口尚未实现，前端仍处于冻结阶段。
- 后续 P0 测试缺口仍包括真实 PostgreSQL + 真实 LLM 的 Agent/RAG 联合验收。真实 PostgreSQL 查询取消端到端已在后续切片补齐。
