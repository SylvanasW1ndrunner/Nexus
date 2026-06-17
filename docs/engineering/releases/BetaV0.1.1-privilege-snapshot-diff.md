# BetaV0.1.1 权限快照差异计划

## 新增能力

本次在 `packages/core-db` 新增 `privilege-snapshot.ts`，补齐用户与权限管理中“修改前自动备份当前权限快照”的后端基础：

- 定义角色、角色成员关系和对象权限快照结构。
- 接收当前快照与目标快照，生成最小 SQL 变更计划。
- 输出执行前快照 `preChangeSnapshot`，供调用方在执行前持久化。
- 复用 `privilege-preview.ts` 生成 GRANT/REVOKE/ALTER ROLE 预览，保持风险标记和二次确认一致。

## 安全边界

- 本模块不连接数据库、不执行 SQL。
- 生成的 SQL 仍必须经过用户确认。
- 当前快照必须在执行变更前由调用方持久化，便于失败恢复和人工回滚。
- 该模块不处理密码和密钥。

## 验证

已运行：

```powershell
$env:Path='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\tsc.CMD -p packages\core-db\tsconfig.json --noEmit
.\node_modules\.bin\vitest.CMD run packages\core-db\test\privilege-snapshot.test.ts
```

结果：

- `packages/core-db` 类型检查通过。
- `privilege-snapshot.test.ts` 4 个测试通过。

## 当前限制

- 尚未实现 PostgreSQL 权限快照采集 SQL；当前由调用方传入快照。
- 暂不生成自动回滚 SQL，只保留执行前快照和正向变更计划。
