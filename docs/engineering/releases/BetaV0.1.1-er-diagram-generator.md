# BetaV0.1.1 ER 图 Mermaid 生成器

## 范围

本次新增 `core-rag` 的 ER 图 Mermaid 生成能力，用于支撑产品文档中的“ER 图查看”和“导出 mermaid 文本”。本次不包含前端渲染、SVG/PNG 导出或拖拽编辑。

## 功能

- 新增 `generateMermaidErDiagram()`。
- 输入 `TableDetail[]`。
- 输出 Mermaid `erDiagram` 文本。
- 返回：
  - 表数量。
  - 关系数量。
  - 被截断字段的表。
  - warnings。
- 支持：
  - 主键标记。
  - 外键标记。
  - nullable/not_null 标记。
  - 外键关系线。
  - 每表最大字段数。
  - 选择部分表生成子图。
  - Mermaid identifier 清洗。

## 安全与体验边界

- 不连接数据库，不读取文件，不执行 SQL。
- 默认每表最多 10 个字段，避免大表生成不可读图。
- 表数量超过 30 时返回 warning，建议使用关系子图。
- 选择的表不存在时返回 warning。

## 测试

- `packages/core-rag/test/er-diagram.test.ts`
  - 生成 users/orders/order_items Mermaid 图。
  - 验证主键、外键、关系线。
  - 验证字段截断和 warning。
  - 验证 selectedTables 子图。
  - 验证 Mermaid identifier 清洗。
  - 验证大 schema warning。

## 限制

- 只生成 Mermaid 文本，不负责渲染。
- 不支持手动布局和拖拽编辑。
- Mermaid entity name 是清洗后的显示 ID，原始 schema 名称应由调用方在详情面板中展示。
