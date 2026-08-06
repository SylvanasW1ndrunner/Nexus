# SchemaNaut 测试链路

## 1. 目标

本链路验证 SchemaNaut 的真实功能、性能、数据边界和发行包，不以服务启动或简单连通性作为完成标准。

测试分为五层：

1. 确定性单元与组件测试：合同、权限、Session、计划、上下文压缩、Skills、MCP、工具和错误恢复。
2. 真实 PostgreSQL 功能测试：Driver、Connector、SDK、Agent、权限、Schema 刷新和独立结果载荷。
3. 通用 Agent 场景：在无数据库 Project 中读取/修改代码、运行真实进程、验证产物和收敛。
4. 业务场景与性能测试：电商、流量清洗与异常检测、大科学数据，以及 Schema 目录快速收敛。
5. 发行验收：npm 包安装、SDK、REST、CLI、WebUI、内置 Skills、文档链接和密钥扫描。

```mermaid
flowchart LR
    Build["类型检查与构建"] --> Unit["全仓功能测试"]
    Unit --> Prepare["重建专用 PostgreSQL 测试库"]
    Prepare --> Fixtures["加载三类复杂场景"]
    Fixtures --> DbTests["Driver / Connector / SDK / Agent"]
    DbTests --> Perf["场景性能与上下文性能"]
    Perf --> General["通用 Project Agent 真实模型验收"]
    General --> Package["npm 打包与安装验收"]
    Package --> Review["用户视角 + 工程师视角复核"]
```

## 2. 标准执行顺序

| 阶段        | 命令                                                                                                                                                              | 通过条件                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 类型        | `pnpm typecheck`                                                                                                                                                  | 所有生产源码和各包测试源码均通过 TypeScript 检查                                 |
| 构建        | `pnpm build:server`                                                                                                                                               | 所有公共包和 Server 编译成功                                                     |
| 全仓功能    | `pnpm test`                                                                                                                                                       | 非外部依赖测试全部通过                                                           |
| PostgreSQL  | `pnpm test:postgres`                                                                                                                                              | Driver、Connector、SDK 和三类场景全部通过                                        |
| AI SQL 性能 | `pnpm test:ai-sql:performance`                                                                                                                                    | RAG、工具、结果投影和上下文压缩不超过阈值                                        |
| Agent Runtime 性能 | `pnpm test:agent-runtime:performance`                                                                                                                       | 1,000 Tool 目录、搜索、暴露、执行路由和 1,000 文件 Project 编译通过门禁           |
| 基础性能    | `pnpm test:llm-platform:performance`、`pnpm test:database-platform:performance`、`pnpm test:resource-state:performance`、`pnpm test:public-contracts:performance` | 对应报告按其合同记录 `status: "passed"` 或 `passed: true`                        |
| 发行包      | `pnpm test:npm-package:functional`                                                                                                                                | SHA-256、版本元数据、密钥扫描、隔离安装、SDK、REST、CLI、Skills 和类型声明均通过 |

真实模型测试是显式链路，不混入可重复的默认测试：

```powershell
pnpm test:ai-sql:live
pnpm test:ai-sql:context-live
pnpm test:agent-runtime:live
pnpm test:performance:live
pnpm test:llm-multi-model-live
pnpm test:agent-multi-model-live
```

这些命令从本地 `.env` 或进程环境读取凭据。测试代码、日志和报告不得记录 API Key、数据库密码或完整请求头。

`test:llm-multi-model-live` 使用多个模型验证原生结构化 Tool Call、Tool Result 回传、最终答复和文本伪调用拦截。`test:agent-multi-model-live` 在同一套真实 PostgreSQL Fixture 上分别运行 Schema 目录、电商、Kafka 清洗和大科学任务；每个模型/场景独立落报告，单一模型失败不会阻止其余用例收集证据。两个入口都使用公共 Provider、Gateway、Agent、RAG 与数据库管线，不注入测试专用 Tool Hook。

## 3. PostgreSQL 场景

统一入口是 [`scripts/run-postgres-tests.mjs`](../scripts/run-postgres-tests.mjs)。它只允许重建名称符合 `dbagent_*_test` 的专用数据库；默认目标为 `dbagent_core_db_test`，不得指向业务库。

### 3.1 电商平台

Fixture：[`ecommerce.sql`](../scripts/dev-db/scenarios/ecommerce.sql)

- 英文 Schema、中文 Schema、外键、索引、支付、退款、库存和业务目标。
- 20,008 个订单、20,009 个订单项与 20,008 笔支付，防止聚合性能在玩具数据上假通过。
- CTE、窗口函数、多表 Join、时区、条件聚合和财务口径。
- `read / edit / full` 权限递进，以及越级操作的单次许可和拒绝。
- DDL 成功后重新索引并读取最新 Schema。

### 3.2 流量清洗与异常检测

Fixture：[`traffic-cleaning.sql`](../scripts/dev-db/scenarios/traffic-cleaning.sql)

- Kafka 风格单列 JSON `value`、重复事件、脏时间、无效类型和阈值表。
- 20,017 条原始事件，覆盖 200 个额外分钟桶，同时保留重复、缺字段和类型错误。
- Agent 先提交错误字段查询，再根据数据库错误和最新结构修正。
- 只读取有限 JSON 样例；去重、清洗、聚合和异常判断全部下推 PostgreSQL。

### 3.3 大科学数据

Fixture：[`big-science.sql`](../scripts/dev-db/scenarios/big-science.sql)

- 实验、样本、仪器、分区观测表、高精度数值、数组和 JSON 元数据。
- 分区确认、窗口、样本级统计和实验级聚合。
- 大结果由 SDK/API 独立接收最多 1,000 行并通过 `hasMore` 标识后续数据库行；模型临时投影默认最多 100 行且不超过 64 KiB，Session 与偏好中不保留行值。

场景功能测试位于 [`postgres-scenarios.integration.test.ts`](../packages/sdk/test/postgres-scenarios.integration.test.ts)，场景性能入口位于 [`postgres-scenario-performance.mjs`](../scripts/tests/postgres-scenario-performance.mjs)。

### 3.4 Schema 目录快速收敛

真实模型链路还包含一个简单目录问题：要求优先使用 `knowledge_search`，在最多 5 次迭代内交付多个中英文 Schema 名。它用于防止简单问题退化为重复查询系统目录，不替代前三个复杂业务场景。

### 3.5 无数据库 Project Agent

[`general-agent.live.integration.test.ts`](../packages/sdk/test/general-agent.live.integration.test.ts) 创建一个真实临时 TypeScript/JavaScript Project：Agent 必须读取项目说明、发现文件/进程工具、修复实际代码错误、执行真实测试并以 Runtime 文件与进程证据完成。该场景明确断言未调用 SQL/RAG 工具，并记录迭代、Token、Tool 顺序、耗时、Artifact 和完成状态。

## 4. 功能验收标准

- Agent 调用的是公共 LLM Runtime、统一数据库 Runtime、RAG、权限和 Session 管线，不使用测试专用捷径。
- 中文问题、英文对象和中文对象均可检索。
- SQL 语法、实际执行、错误修正、许可、拒绝和 DDL 后刷新都有断言。
- `read` 模式在数据库事务层阻止 SELECT 包装的 `VOLATILE` 写入函数；`edit/full` 的对应路径正常执行。
- SQL、EXPLAIN 和 SDK Query Job 的取消会传播到 PostgreSQL；DDL 已提交但 Schema 刷新失败时只返回警告，不重放语句。
- 聚合统计由数据库完成；模型上下文中不存在完整大结果。
- SQL 交互结果每次最多 1,000 行，模型临时投影默认最多 100 行且不超过 64 KiB；持久 Session、Agent Run 和用户偏好中均无查询行或缓存 ID。
- REST Session 视图不包含 Tool 消息、Tool Call、Skill 正文、知识哈希、节点 ID 或检索分数。
- MCP 使用官方 SDK 完成能力协商、分页、通知、取消、超时、进程退出和远程传输测试。
- MCP 还覆盖风险提示不降权、Secret/URL 校验、启动竞态、允许工具过滤，以及 REST 默认禁止进程型 stdio 管理。
- CLI 覆盖项目初始化、Session、Skills、MCP、权限切换、任务追加、手动压缩和取消。
- Agent 覆盖计划依赖与证据校验、并发 Session 串行化、转向时取消旧许可，以及文本化 Tool Call 的恢复门禁。
- Provider 覆盖 OpenAI Chat、OpenAI Responses、Anthropic、Ollama 和 vLLM 协议映射；结构化 Tool Call 跨协议归一化，严格 Endpoint 的 System 消息首位约束以及重复 Tool Call ID 的幂等回放均有回归断言。
- 模型窗口优先读取 Endpoint 元数据，再使用内置 models.dev 快照；未知值不得回退为 32K。自动压缩只在已知物理窗口将满时触发，手动压缩不依赖窗口元数据。
- 动态 Tool 覆盖隐藏/禁用项不可见、目录 revision 失效、Run 级激活隔离、允许列表向子 Agent 传播和并发读/串行写屏障。
- 通用 Project 场景必须用真实文件和真实进程完成，不使用 Hook 伪造工具结果；真实模型调用只由显式 live 命令开启。
- 每个真实模型场景独立执行并独立记录成功或失败；筛选单场景时只验收被选场景，某一场景失败不会阻止其他场景运行。
- 场景用例要把配置表、字典表、过滤和有效性口径写清楚；只验证最后一条同时满足验收值的 SQL 结构化结果以及真正进入终态的最终答复，不把之后的局部核验误当最终结果，也不扫描多条历史 SQL 拼凑成功。
- PostgreSQL `date/timestamp` 结果按测试数据库的场景时区（默认 `Asia/Shanghai`，可用 `DBAGENT_TEST_TIME_ZONE` 指定）归一化后比较，不能把本地月份转成 UTC 字符串再做字面量断言。
- 最终答复必须独立可读；“让我继续验证”和“结果如上表 / shown above”均作为非终态回归，不能依赖 CLI 未展示的中间 Assistant 消息通过验收。

### 4.1 真实模型失败归因

真实模型用例失败时按固定顺序定位，不把所有异常归因给模型：

1. Provider/协议适配：请求是否带有正确 Tool Schema，响应是标准 `tool_calls` 还是退化的文本标记。
2. Agent Runtime：Tool 是否注册和可见，参数是否解析，权限、计划状态、完成门禁和恢复分支是否正确。
3. Tool/数据库：SQL 是否真正提交，取消与错误是否完整返回，数据库状态是否符合预期。
4. 模型决策：只有前三层均正确且证据完整时，才评价模型是否忽略规则、重复探索或生成错误 SQL。

报告记录脱敏后的层级、错误分类、工具顺序、数据库事实与恢复结果，不记录密钥、完整请求头或隐藏推理。代码能够兼容、修复或约束的问题一律作为工程缺陷处理。

## 5. 性能验收标准

性能脚本对直接 `pg.Client.query()` 和 `DatabaseAccessRuntime + PostgresConnector` 两条路径分别预热至少 10 秒，再交替记录至少 40 对原始样本以及 `p50 / p95 / max`。每个 SchemaNaut 样本读取后显式释放 Result Handle，避免基准本身把已消费结果保留到后续场景。数据库查询本身的绝对耗时只作为环境事实；产品门禁只判断 SchemaNaut 路径相对直接 pg 的额外 P95。

默认本地阈值：

| 门禁                                      | 默认阈值 |
| ----------------------------------------- | -------: |
| SchemaNaut P95 − 直接 pg P95（每个场景） |  ≤ 50 ms |

阈值可通过 `DBAGENT_SCENARIO_PLATFORM_OVERHEAD_P95_MS` 配置，但不得通过放宽阈值掩盖回归。报告保存两条路径和成对差值的全部原始样本、数据规模、PostgreSQL 版本、Node.js、操作系统和 CPU，避免把 PostgreSQL 的 CPU 密集查询误报为产品回归。

定位单个场景时可设置 `DBAGENT_SCENARIO_PERF_FILTER`，多个场景用逗号分隔；未知场景名会直接失败，筛选运行不得代替最终四场景总门禁。

## 6. 测试证据

真实场景运行后生成：

- `reports/postgres-scenarios/functional.json`：9 段 Agent 运行日志，包含工具顺序、状态、耗时、独立有界结果、终态和 Token 用量。
- `reports/postgres-scenarios/live.json`：最近一次显式真实模型测试的汇总；`reports/postgres-scenarios/live-cases/<scenario>.json` 为每个场景独立写入成功/失败证据，普通确定性回归不会覆盖真实模型证据。
- `reports/postgres-scenarios/performance.json`：四类 SQL 的直接 pg、SchemaNaut、成对额外耗时原始样本，及各自 p50、p95、最大值和门禁结论。
- `reports/postgres-scenarios/manifest.json`：本次运行 ID、Git 状态、Fixture 哈希和本次生成的报告哈希；只有整条链路成功后才原子生成。使用 `--live-llm` 时还会校验并纳入同一运行的 `live.json`。
- [`ai-sql/performance.json`](../reports/ai-sql/performance.json)：AI SQL 与检索性能。
- [`ai-sql/context-compaction-performance.json`](../reports/ai-sql/context-compaction-performance.json)：长会话压缩性能和信息保留。
- [`llm-platform/performance.json`](../reports/llm-platform/performance.json)：模型 Runtime 性能。
- [`llm-platform/multi-model-tool-live.json`](../reports/llm-platform/multi-model-tool-live.json)：多模型原生 Tool Call 与结果回传证据。
- [`database-access-performance.json`](../reports/database-access-performance.json)：统一数据库接入性能。
- [`agent-runtime/performance.json`](../reports/agent-runtime/performance.json)：1,000 Tool 目录检索/暴露、执行路由和 Project Compiler 本地开销。
- [`agent-runtime/live-project.json`](../reports/agent-runtime/live-project.json)：真实模型完成无数据库代码修复任务的脱敏证据。
- [`postgres-scenarios/live-model-matrix.json`](../reports/postgres-scenarios/live-model-matrix.json)：多模型四场景汇总；单场景完整轨迹位于 `reports/postgres-scenarios/live-model-matrix/`。

报告是工程验收证据，不是最终用户功能，也不通过公开 API 暴露内部评测轨迹。

## 7. 双视角复核

### 用户视角

- 首次安装后能从 README 完成项目初始化、连接、提问、批准和恢复 Session。
- CLI 只显示目标理解、计划变化、SQL、许可、结果和产物等有用信息。
- 错误说明具体原因和下一步，不返回抽象内部状态。
- 大结果不会卡住对话，也不会把整表数据塞进模型。

### 工程师视角

- 公共类型、SDK、REST、CLI 和文档字段一致；生产源码与测试源码都进入 TypeScript 门禁。
- 测试失败能够定位到合同、组件、数据库场景或性能阈值。
- 测试数据可重复创建，清理范围严格限定在专用测试库。
- npm 临时安装不依赖 Monorepo 路径，不携带 `.env`、密钥、内部缓存或旧产品代码。

发行验证由 [`verify-npm-package.mjs`](../scripts/verify-npm-package.mjs) 执行。

验证器默认使用 pnpm 离线缓存创建隔离消费者；本机缓存缺少 registry 元数据时，可设置 `SCHEMANAUT_PACKAGE_VERIFY_INSTALL_MODE=prefer-offline` 做一次干净网络安装验证。`online` 仅用于明确要求完全忽略缓存的发行诊断。

在已经由 `pnpm test:postgres` 重建的专用测试库上，可设置
`SCHEMANAUT_PACKAGE_VERIFY_POSTGRES=1`。发行验证器会仅从进程环境读取
`SCHEMANAUT_PACKAGE_VERIFY_PG_*`，使用隔离安装后的 npm 包完成连接、`SELECT`、物理只读阻断和查询取消验收；
数据库名必须以 `_test` 结尾，验证器不会读取或打印 `.env` 凭据。

## 8. Release-gate contract (English)

`pnpm test:npm-package:functional` accepts a local archive only when its single
`SHA256SUMS.txt` entry matches in constant time, root/server/README/CHANGELOG
versions agree, the expanded secret scan is clean, the public TypeScript API
matches its reviewed baseline, and an isolated consumer can exercise the SDK,
REST server, CLI, Skills, and declarations. The archive also contains a
CycloneDX SBOM, license inventory, vulnerability-scan status, and provenance;
an offline `not-scanned-offline` status is explicit and is never presented as
“zero vulnerabilities.”

Set `SCHEMANAUT_PACKAGE_VERIFY_POSTGRES=1` only after preparing a dedicated
database whose name ends in `_test`. The optional acceptance uses the installed
package for connect, `SELECT`, physical read-only enforcement, and cancellation.
It reads `SCHEMANAUT_PACKAGE_VERIFY_PG_*` from the process environment and never loads or
prints `.env` credentials.
