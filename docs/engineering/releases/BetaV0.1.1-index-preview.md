# BetaV0.1.1 索引管理 DDL 预览

## 新增能力

本次在 `packages/core-db` 新增 `index-preview.ts`，为产品文档中的索引管理提供后端合同：

- 生成 `CREATE INDEX` / `CREATE UNIQUE INDEX` 预览。
- 支持 `CONCURRENTLY`、btree/hash/gin/gist/brin、复合索引、列排序、`NULLS FIRST/LAST`、operator class。
- 支持表达式索引和部分索引 `WHERE`。
- 生成 `DROP INDEX` 预览，支持 `CONCURRENTLY`、`IF EXISTS` 和 `CASCADE`。

## 安全边界

- 本模块只生成 SQL，不直接执行数据库。
- 所有索引 DDL 预览均为 `riskLevel=dangerous` 且 `requiresConfirmation=true`。
- `CONCURRENTLY` 会返回 warning，提示 PostgreSQL 不能在显式事务块内执行。
- `DROP INDEX CONCURRENTLY` 与 `CASCADE` 的非法组合会在预览阶段拒绝。
- WHERE 和表达式属于 SQL 片段，会拒绝明显多语句/注释 token，但仍必须展示给用户审查。

## 验证

已运行：

```powershell
$env:Path='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\tsc.CMD -p packages\core-db\tsconfig.json --noEmit
.\node_modules\.bin\vitest.CMD run packages\core-db\test\index-preview.test.ts
```

结果：

- `packages/core-db` 类型检查通过。
- `index-preview.test.ts` 6 个测试通过。

## 当前限制

- 当前只生成 PostgreSQL 方言索引 DDL。
- 表达式索引和 WHERE 不做完整 SQL AST 解析；后续如引入 SQL parser，可进一步提升静态校验能力。
- UI 层的索引列表、新建索引窗口和执行确认留到最终前端重建阶段。
