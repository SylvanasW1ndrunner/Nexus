# BetaV0.1.1 用户与权限 SQL 预览

## 新增能力

本次在 `packages/core-db` 新增 `privilege-preview.ts`，为 PostgreSQL 用户与权限管理提供后端合同：

- 角色创建、修改、删除预览。
- 角色成员关系 `GRANT role TO member` / `REVOKE role FROM member` 预览。
- schema、table、sequence、function、procedure 对象权限 `GRANT` / `REVOKE` 预览。
- 高危权限和可委派权限的二次确认标记。

## 安全边界

- 本模块只生成 SQL，不直接执行数据库。
- 所有权限变更均为 `riskLevel=dangerous` 且 `requiresConfirmation=true`。
- `SUPERUSER`、`REPLICATION`、`BYPASSRLS`、`WITH ADMIN OPTION`、`WITH GRANT OPTION`、`DROP ROLE` 会标记 `requiresExtraConfirmation=true`。
- 模块不接收、不保存、不输出明文密码。未来登录角色的密码设置应由主进程安全输入和凭证边界处理。
- 对象名、角色名和函数签名会拒绝明显危险 token。

## 验证

已运行：

```powershell
$env:Path='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\tsc.CMD -p packages\core-db\tsconfig.json --noEmit
.\node_modules\.bin\vitest.CMD run packages\core-db\test\privilege-preview.test.ts
```

结果：

- `packages/core-db` 类型检查通过。
- `privilege-preview.test.ts` 8 个测试通过。

## 当前限制

- 当前只生成 PostgreSQL 方言权限 SQL。
- 不实现真实权限快照备份；后续应由 driver introspection 查询 `pg_roles`、`information_schema.role_table_grants` 等系统视图生成快照。
- 不处理密码设置 SQL，避免明文凭证进入预览链路。
