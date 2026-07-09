# BetaV0.1.1 desktop Schema RAG 启动恢复接线

## 变更

- desktop 启动恢复改为调用 core-rag `restoreAll`。
- 新增最近一次启动恢复摘要。
- 新增官方只读工具 `get_schema_rag_startup_recovery`。
- 官方插件策略纳入该工具。

## 验证

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run apps/desktop/src/main/schema-rag-startup-cleanup.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts --passWithNoTests`
- `eslint apps/desktop/src/main/schema-rag-startup-cleanup.ts apps/desktop/src/main/schema-rag-startup-cleanup.test.ts apps/desktop/src/main/agent-tool-bootstrap.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts apps/desktop/src/main/main.ts packages/core-tools/src/official-plugin-registry.ts packages/core-tools/test/official-plugin-registry.test.ts`

## 风险

- 本切片不包含 UI。
- 启动 summary 仅保存在当前主进程内存中。
