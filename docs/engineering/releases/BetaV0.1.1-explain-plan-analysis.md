# BetaV0.1.1 EXPLAIN 计划分析器

## 新增能力

本次在 `packages/core-db` 新增 `explain-plan.ts`，用于解析 PostgreSQL `EXPLAIN (FORMAT JSON)` 结果：

- 将 PostgreSQL 原始 JSON 转换为稳定的树形计划节点。
- 提供扁平节点列表，便于 UI、Agent 和后续火焰图消费。
- 提取 planning time、execution time、cost、actual rows/time、filter、index condition 等关键字段。
- 生成性能 warning：顺序扫描、高成本、高耗时、大量过滤、嵌套循环大输入和排序溢出风险。

## 安全边界

- 本模块不执行 SQL，只分析已经返回的 EXPLAIN JSON。
- SQL 执行仍由 `apps/desktop/src/main/explain-workflow.ts` 负责包装只读查询。
- 不依赖 LLM，不上传数据库计划。

## 验证

已运行：

```powershell
$env:Path='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\tsc.CMD -p packages\core-db\tsconfig.json --noEmit
.\node_modules\.bin\vitest.CMD run packages\core-db\test\explain-plan.test.ts
```

结果：

- `packages/core-db` 类型检查通过。
- `explain-plan.test.ts` 4 个测试通过。

## 当前限制

- warning 阈值是轻量启发式，后续应结合真实查询历史和表统计信息调优。
- 暂不解析 buffer、I/O timing、JIT 等高级字段。
- UI 的树形视图和火焰图仍留到最终前端重建阶段。
