# BetaV0.1.1 SQL 对象 DDL 预览

## 新增能力

本次在 `packages/core-db` 新增 `sql-object-preview.ts`，为传统数据库 IDE 的视图、函数和存储过程编辑提供后端合同：

- 视图：生成 `CREATE OR REPLACE VIEW` 预览，并限制定义只能是单条 `SELECT` 或 `WITH` 查询。
- 函数：生成 `CREATE OR REPLACE FUNCTION` 预览，支持参数、返回类型、语言、稳定性和 security 选项。
- 存储过程：生成 `CREATE OR REPLACE PROCEDURE` 预览，支持参数模式。
- 删除：生成视图/函数/过程的 drop 预览，函数和过程支持签名定位重载。
- 测试调用：生成参数化函数/过程调用 SQL，避免把用户输入直接拼接进 SQL 文本。

## 安全边界

- 本模块只生成 SQL，不直接连接或执行数据库。
- 所有 DDL 预览均标记 `riskLevel=dangerous` 和 `requiresConfirmation=true`。
- 视图定义拒绝多语句和非查询语句。
- 例程参数类型、返回类型和语言名会拒绝明显危险 token。
- 函数体使用 `$dbagent$` delimiter，并拒绝正文包含该保留 delimiter。

## 验证

已运行：

```powershell
$env:Path='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\tsc.CMD -p packages\core-db\tsconfig.json --noEmit
.\node_modules\.bin\vitest.CMD run packages\core-db\test\sql-object-preview.test.ts
```

结果：

- `packages/core-db` 类型检查通过。
- `sql-object-preview.test.ts` 9 个测试通过。

## 当前限制

- 例程正文只做 delimiter 和非空校验，不解析 PL/pgSQL 语义。
- 默认只生成 PostgreSQL 方言 SQL；未来多数据库支持应放到 dialect adapter。
- UI 层的编辑器、保存按钮和测试调用窗口仍在后续统一前端重建阶段实现。
