# BetaV0.1.1 表设计器 DDL 预览

## 范围

本次新增 `core-db` 的表设计器 DDL 预览能力，用于支撑产品文档中的“表设计器”和“所有变更先预览 DDL 再执行”。本次只实现后端合同，不包含前端 UI。

## 功能

- 新增 `buildCreateTablePreview()`。
- 新增 `buildAlterTablePreview()`。
- 新建表支持：
  - 字段名称、类型、NULL、默认值、identity、unique、check。
  - 主键。
  - 表注释、列注释。
  - 索引。
  - 外键。
- 修改表支持：
  - 新增字段。
  - 新增索引。
  - 新增外键。
  - 更新表注释。
- 生成结果包含：
  - `sql`
  - `statements`
  - `riskLevel`
  - `requiresConfirmation`
  - `warnings`

## 安全边界

- 该模块只生成 DDL，不执行 DDL。
- DDL 预览默认标记为 `dangerous`，必须确认。
- schema、table、column、index、constraint 名称使用 PostgreSQL identifier quote。
- 注释内容会转义单引号。
- 字段类型拒绝 `;` 和 `--` 等明显危险 token。
- 新建表没有主键时返回 warning，因为后续行编辑不能安全定位记录。

## 测试

- `packages/core-db/test/table-designer.test.ts`
  - 新建表 DDL，包含字段、主键、注释、索引、外键。
  - 无主键 warning。
  - ALTER TABLE 添加字段、索引、外键和注释。
  - 注释单引号转义。
  - 拦截危险字段类型。
  - 拦截外键列数不一致。
  - 拦截空 ALTER。

## 限制

- 当前只支持 PostgreSQL 方言。
- 修改已有列类型、重命名字段、删除字段、删除索引、删除外键暂未实现。
- 默认值和 CHECK 表达式仍属于 SQL 片段，调用方必须展示并要求用户审查。
