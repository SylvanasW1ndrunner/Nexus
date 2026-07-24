# AI SQL 功能与性能验收

## 1. 测试原则

- 不以“服务能启动”作为完成标准。
- 纯逻辑使用确定性功能测试。
- 数据库行为使用真实 PostgreSQL。
- Agent 编排使用确定性模型验证工具顺序、权限和错误恢复。
- SQL 准确率使用真实模型和真实 PostgreSQL执行结果验证。
- 真实模型测试由环境变量显式开启，测试日志不得输出 API Key。

## 2. PostgreSQL Fixture

测试数据库同时包含英文和中文对象：

- 英文电商域：customers、orders、order_items、products、payments、events。
- 中文供应链域：`供应商`、`采购订单`、`采购明细`。
- JSONB 事件流：只有事件键、来源、时间和复杂 payload。
- 复合主键与多级外键。
- 自引用组织树。
- 表、字段、索引和约束注释。
- 普通视图、物化视图、函数、触发器。
- 相似命名表，用于检索消歧。

Fixture 位于 [`scripts/dev-db/init.sql`](../../scripts/dev-db/init.sql)。

## 3. 功能测试

### 3.1 知识目录

- 资源树层级、稳定 ID、父子入口和跨树关系正确。
- 业务知识本地绑定、子树继承、多节点绑定和冲突正确。
- 不同连接不能互相读取节点、关系、知识和索引。
- 中文表、英文列和中文问题可以相互检索。
- JSON 字段业务知识能定位到对应字段。

### 3.2 Merkle

- 相同内容不受输入顺序影响。
- 单字段变化只改变该节点、祖先和 Catalog 根。
- 跨树关系变化进入全局根，但不会产生循环递归。
- 根相同立即验证通过。
- 根不同能定位到具体子树。
- Snapshot 损坏被识别并安全回退。

### 3.3 检索

- 显式表/字段引用优先。
- BM25、业务词典、图扩展和可选向量通道独立评分。
- RRF 融合顺序稳定。
- 没有 Embedding Provider 时功能完整退化。
- Embedding Fingerprint 改变后向量索引变为 stale。
- 检索结果受最大上下文占用限制，不会一次输出无限 Schema。

### 3.4 Agent 与权限

- Agent 能按 Skill 组合资源、知识、SQL 和结果工具。
- `read`、`edit`、`full` 对每类 SQL 的行为符合文档。
- 超权调用必须产生审批请求，拒绝后无数据库副作用。
- Tool allowlist 无法通过模型伪造调用绕过。
- SQL 错误修正达到上限后停止，不无限消耗 Token。
- Session 保存工具轨迹和知识版本引用。
- 达到模型窗口阈值时先缩短旧 Tool 输出，再生成累积语义检查点。
- 多次压缩保留上一检查点、当前任务、用户偏好、最近完整消息和精确数据库事实。
- 自动与手动压缩使用同一管线，手动 `focus` 会进入压缩请求。
- 压缩前后完整 Session 消息数量和内容不变；历次检查点可查询。
- Assistant Tool Call 与 Tool Result 不会被压缩边界拆开。
- 压缩模型失败时使用确定性恢复摘要并产生降级记录。
- 模型工作视图不包含知识 Hash、节点 ID、树索引和检查点元数据。

### 3.5 真实模型 SQL

真实模型至少完成以下类型的执行验证：

1. 多表收入、退款和净收入统计。
2. 窗口函数计算客户排名和累计金额。
3. 递归 CTE 查询组织树。
4. JSONB 事件 payload 的数组展开和字段提取。
5. 中文表与英文表联合查询。
6. 时间分桶、时区和空值处理。
7. 相关子查询或 EXISTS。
8. 在 `edit` 模式下执行 UPSERT 和带条件 UPDATE。
9. 在 `read` 模式下拦截写入并完成单次审批路径。
10. 错误字段名触发一次结构重读和修正。

## 4. 性能测试

| 场景 | 数据规模 | 目标 |
|---|---:|---:|
| 构建知识目录和 Merkle | 10,000 节点 | ≤ 1,500 ms |
| 根哈希一致性比较 | 任意规模 | ≤ 1 ms |
| 单分支差异定位 | 10,000 节点 | P95 ≤ 20 ms |
| 直接子节点浏览 | 单父节点 10,000 子节点 | P95 ≤ 20 ms |
| 本地精确/BM25 检索 | 10,000 检索文档 | P95 ≤ 100 ms |
| 图扩展 | 2 跳、最多 200 节点 | P95 ≤ 50 ms |
| 100 个结果分页读取 | 已缓存结果 | P95 ≤ 10 ms |
| 构建压缩后的模型工作视图 | 10,000 条 Session 消息 | P95 ≤ 50 ms |
| 自动压缩规划 | 10,000 条 Session 消息 | P95 ≤ 100 ms |
| SQLite 追加并恢复 Session | 10,000 条 Session 消息 | P95 ≤ 500 ms |
| 自动压缩后的窗口占用 | 达到压缩阈值 | 低于模型可用输入窗口 |

性能报告必须记录 Node.js、操作系统、CPU、数据规模、P50/P95、最大值和阈值结论。

## 5. 测试入口

```bash
pnpm test:ai-sql
pnpm test:ai-sql:performance
pnpm test:ai-sql:context-performance
pnpm test:ai-sql:context-live
pnpm test:postgres
pnpm test:ai-sql:live
pnpm typecheck
pnpm lint
```

真实模型测试读取 `.env` 中的测试 Provider 配置，并产生单独报告；默认测试不依赖 Secret。

上下文压缩报告：

- `reports/ai-sql/context-compaction-performance.json`
- `reports/ai-sql/context-compaction-live.json`
