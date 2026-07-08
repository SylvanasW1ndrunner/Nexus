# BetaV0.1.1 - PostgreSQL 事务试运行与回滚预览

## 范围

本版本切片完成 PostgreSQL 写操作的 rollback-only 预览能力，保留现有 SQL 执行、确认、只读保护、查询历史和导出链路。前端 UI 不在本切片范围内。

## 功能

- SQL 执行请求支持 `transactionMode: 'rollback'`，在真实 PostgreSQL 事务中执行后强制 `ROLLBACK`。
- 写操作回滚预览仍必须显式确认，避免 Agent 或未来 UI 把试运行当成权限绕过入口。
- 执行结果、查询历史和 JSON 导出记录事务状态：开始、提交、回滚、rollback-only。
- 只读连接逐语句检查多语句批处理，后续语句写入也会被阻断。
- 回滚预览拒绝 PostgreSQL 不支持事务内运行的语句，给出明确 `UNSUPPORTED_OPERATION`。
- 旧 `dryRun: true` 保持兼容，但与 `transactionMode: 'auto'` 冲突时会被拒绝。

## 测试

- 覆盖 driver 单元测试、SQL safety 单元测试、查询历史测试、shared 导出测试、desktop query workflow 测试。
- 使用本地真实 PostgreSQL 验证复杂写入批处理在 rollback-only 模式下不会落库。
- `pnpm --filter @dbagent/core-db test:postgres` 已通过，包含真实 PostgreSQL 业务夹具、RAG/Agent 相关后端场景。

## 依赖与打包影响

无新增运行时依赖，无新增 native module，无 Electron 打包影响。

## 风险

- 当前仍是语句级安全检查，不等同完整 PostgreSQL AST parser。
- 参数化多语句暂不支持，避免参数绑定与审计语义不清。
- 未来如果要支持更复杂的 SQL 影响面分析，应评估成熟 parser 并放在 adapter 后面。
