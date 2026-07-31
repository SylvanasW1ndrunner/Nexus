# SQL 生成、权限与执行

## 1. 目的

将 SQL 生成和数据库执行放入同一个可反馈 Agent 流程，同时把权限判断从模型中分离。Agent 负责尽可能完成任务，Parser、Permission Manager 和数据库账号负责执行边界。

## 2. SQL 解析

SQL 解析器输出：

```text
dialect
valid
statementCount
statementKinds
requiredPermission
tables
columns
hasWhere
parseError
```

优先使用支持多方言的通用 AST Parser。当前 PostgreSQL 适配器使用 `node-sql-parser`，Parser 不支持的 PostgreSQL 专有语法由现有语句扫描器提供保守分类；解析失败不能被伪装为安全 SQL。

第三方 AST 类型只存在于 `core-db` 内部，公共合同只暴露稳定的分类结果。

## 3. 三档权限

| 当前模式 | 自动允许                                                      | 超出范围                            |
| -------- | ------------------------------------------------------------- | ----------------------------------- |
| `read`   | SELECT、只读 WITH、VALUES、SHOW、只读 EXPLAIN、资源和知识读取 | 弹出单次许可请求                    |
| `edit`   | read + INSERT、UPDATE、DELETE、MERGE                          | DDL、权限和管理语句弹出单次许可请求 |
| `full`   | 当前数据库账号允许的全部 SQL                                  | 不增加产品级审批                    |

权限等级只表示产品授权范围，不能绕过数据库账号权限。用户 Skills 可以进一步限制对象或工作流，但不能提高当前授权等级。

权限层只判断 SQL 所需的 `read/edit/full` 等级，不推断用户的业务意图，也不增加第二套语义保护规则。全局提示词、运行策略和内置 Skills 只定义工具使用、权限、执行反馈与验收框架，不规定模型应选择的具体 SQL 操作路径；在 `full` 模式下，模型提交的合法 DDL 会按数据库账号权限直接执行。

Agent 不根据列名或内容猜测“哪些数据不该读”。数据内容边界由数据库账号、用户 Skills 与宿主策略决定，运行时不擅自改变查询结果。

一个 `sql_execute` 工具同时执行读、编辑和完全权限 SQL。运行时在工具执行前解析实际 SQL，动态计算最低权限，避免把 SELECT 因为共用工具而错误识别成高权限动作。

## 4. 执行反馈

1. Agent 生成 SQL。
2. Parser 检查语法、方言和语句类型。
3. Permission Manager 判断当前模式。
4. 需要时创建可取消、可追踪的许可请求。
5. 数据库 Driver 执行 SQL。
6. SDK/API/CLI 得到独立的有界结果载荷，每次执行最多 1,000 行。
7. Agent 在本次运行的临时观察中默认最多看到 100 行且受 64 KiB 上限约束；持久 Tool 消息只保存无行值摘要。
8. Agent 需要更多证据时生成更窄的聚合、过滤或显式分页 SQL，不读取隐藏的完整缓存。
9. SQL 失败时把数据库错误返回 Agent，由错误恢复 Skill 决定是否修正。
10. 运行时在 Verify → Finalize 阶段确认最后一次相关执行成功且最终答复已经交付；“让我继续验证”等过程语句不能作为完成。
11. 已提交 DDL 触发知识目录增量刷新；回滚不刷新。

`read` 模式不仅依赖 AST 分类：PostgreSQL 执行时还进入数据库级只读事务，因此被伪装成 SELECT 的 `VOLATILE` 写入函数也会被数据库拒绝。`edit` 和 `full` 按各自权限正常执行。

取消信号贯穿 SQL、EXPLAIN、统一 Query Job 和 PostgreSQL Driver；超时或用户取消会请求数据库取消正在运行的查询。DDL 已提交但知识刷新失败时，执行仍返回成功并附带刷新警告，绝不能自动重放 DDL。

统计、清洗、连接、窗口计算和异常检测应由数据库 SQL 完成。SchemaNaut 不先读取整表，再让模型或默认 Python 流程计算。完整导出必须走显式数据库 Query/导出链路并直接流向目标文件，不进入交互缓存、模型上下文或 Session。

执行轨迹保存事实，不保存隐藏推理：

```text
工具名称
参数摘要
SQL
解析结果与所需权限
批准结果
执行耗时
影响行数、必要小结果或结果元数据
错误分类
知识版本变化
```

上述完整轨迹用于内部审计。用户轨迹只投影生成 SQL、重要修正、批准、执行结果和产物。

## 5. SQL 覆盖

功能测试至少覆盖：

- SELECT、过滤、排序、LIMIT。
- INNER/LEFT/FULL JOIN。
- 聚合、HAVING、GROUPING SETS。
- 子查询、相关子查询、EXISTS。
- CTE、递归 CTE。
- 窗口函数、Top-N、累计值。
- JSONB 提取、展开和条件过滤。
- 数组、日期区间、时区和空值。
- UNION / INTERSECT / EXCEPT。
- INSERT、UPSERT、UPDATE、DELETE、MERGE。
- CREATE、ALTER、DROP、TRUNCATE。
- 视图、物化视图、函数和带引号的中文标识符。
- 语法错误、字段不存在、类型不匹配和权限不足后的有限修正。

测试不比较 SQL 字符串是否完全一致，而验证语法、权限分类、实际执行结果和数据库最终状态。

## 6. 工程路径

- SQL Parser：[`packages/core-db/src/sql-parser.ts`](../../packages/core-db/src/sql-parser.ts)
- SQL 安全与性能提示：[`packages/core-db/src/sql-safety.ts`](../../packages/core-db/src/sql-safety.ts)
- PostgreSQL 执行：[`packages/core-db/src/postgres-driver.ts`](../../packages/core-db/src/postgres-driver.ts)
- 权限管理：[`packages/core-agent/src/permission-manager.ts`](../../packages/core-agent/src/permission-manager.ts)
- AI SQL 工具：[`packages/core-tools/src/ai-sql-tools.ts`](../../packages/core-tools/src/ai-sql-tools.ts)
- SDK：[`packages/sdk/src/runtime.ts`](../../packages/sdk/src/runtime.ts)

## 7. 依赖决策

`node-sql-parser` 采用 Apache-2.0 许可证，提供统一接口并支持 PostgreSQL、MySQL、MariaDB、SQLite、BigQuery、Redshift、TransactSQL、FlinkSQL 等方言。它是纯 JavaScript 依赖，没有原生二进制和运行时下载，适合 SDK、CLI 和私有部署。

它不被视为 PostgreSQL 语法的唯一真相：数据库实际执行结果仍然是最终判定，现有语句扫描器负责多语句、美元引号和 Parser 不支持语法的保守回退。

该依赖包含多方言构建，安装体积高于 PostgreSQL 专用 Parser；首版接受这一成本，是为了保持后续 MySQL、数仓方言的统一适配边界。`pgsql-ast-parser` 等专用方案会缩小安装体积，但会把多方言扩展重新变成多套解析管线；自研 Parser 则不具备足够的语法覆盖。Parser 已封装在 `core-db` 内，可在不改变公共合同的前提下替换。
