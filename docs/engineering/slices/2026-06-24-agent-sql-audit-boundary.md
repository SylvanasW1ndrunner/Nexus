# 2026-06-24 Agent SQL 预审与权限边界切片

## 目标

本切片补强 Agent 调用数据库时的执行边界：读查询只能通过只读工具执行；写 SQL 必须先被预审并显式确认；driver 层必须保留最后一道门禁，避免绕过 Agent 或工具层后误写生产数据库。

## 实现范围

- `core-db`
  - 扩展 `analyzeSqlSafety()`，对 writable CTE、`EXPLAIN ANALYZE` 包裹写操作、管理类语句和未知语句采取更保守的 review / confirmation 策略。
  - `PostgresDriver.execute()` 对所有 `requiresConfirmation` 且未确认的 SQL 返回 `CONFIRMATION_REQUIRED`，不触达 PostgreSQL pool。
- `core-tools`
  - 新增 `audit_sql` 只读工具，暴露 `QuerySafetyReport` 给 Agent。
  - 强化 `query_database`，只允许单条只读 SQL。
  - 强化 `execute_sql`，在 handler 层先做安全预审，再决定是否调用 driver。
- 测试
  - 新增 SQL 安全矩阵。
  - 新增工具层不触达 driver 的断言。
  - 更新真实 PostgreSQL integration 中需要写入的用例，显式传入确认标记。

## 用户级场景

- 数据分析师让 Agent 查询 GMV、退款率、渠道 ROI：Agent 只能通过 `query_database` 执行只读 SQL。
- 用户要求 Agent 删除订单数据：readonly 模式或未授权模式下，`execute_sql` 会在 Agent 权限层被拒绝。
- 工具层被直接调用并传入 `DELETE`：未确认时不会触达 driver。
- SQL 看起来像读操作但实际会写入，例如 writable CTE 或 `EXPLAIN ANALYZE DELETE`：安全预审会标记为危险并要求确认。

## 开源方案评估

- [`node-sql-parser`](https://github.com/taozhi8833998/node-sql-parser)：Apache-2.0，TypeScript/JavaScript 生态可直接接入，适合后续 AST 风险识别、table list、column list。当前暂不引入，避免在安全边界尚未稳定前扩大 parser 语义承诺。
- [`SQLGlot`](https://github.com/tobymao/sqlglot)：MIT，Python SQL parser/transpiler 生态成熟，跨方言能力强。当前 TypeScript core 直接依赖它会引入跨语言运行和打包复杂度，更适合作为后续 Python sidecar 或离线分析 adapter。
- [`libpg_query`](https://github.com/pganalyze/libpg_query) / [`pgsql-parser`](https://github.com/launchql/pgsql-parser)：复用 PostgreSQL parser，准确性强，但 native/parser 依赖需要额外验证 Windows、Linux、Electron 打包和离线安装。

本轮先采用保守启发式规则，因为目标是执行门禁闭环，不是完整 AST 语义分析。后续实现 affected tables、estimated rows、函数副作用识别、SQL 改写或跨数据库 parser 时，必须把 parser 隔离在 adapter 后面。

## 剩余风险

- 当前 SQL 安全分析仍是启发式规则，可能对字符串中的关键字产生误报。误报会让 SQL 进入确认或阻断路径，优先保护用户数据。
- `execute_sql.confirmed` 仍是布尔标记，后续需要升级为由 permission manager 或主进程签发的 approval context，防止模型参数和用户确认处于同一信任域。
- 真实 PostgreSQL planner 级 affected rows 和 readonly role 测试仍需在后续切片补齐。
