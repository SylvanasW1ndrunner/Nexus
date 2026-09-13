# 真实模型数据分析验收

本文定义通用 Agent 在真实 PostgreSQL 数据分析项目中的工程验收合同。它不是用户操作指南，
也不为生产数据库建立新的配置入口。

## 目标与边界

- 使用 SiliconFlow OpenAI-compatible Endpoint 和 `deepseek-ai/DeepSeek-V4-Flash` 验证真实模型行为。
- 验收会话使用 `temperature = 0` 降低随机漂移；这不把真实模型调用变成确定性测试，失败报告仍须
  保留实际 Run 与 Tool 证据。
- Database Capability 必须由 Agent 按需发现和激活，连接信息只来自 Host 启动前已经存在的
  `DATABASE_URL` 或 PostgreSQL `PG*` 环境。
- Python 分析不新增专用 Capability。Agent 先用始终加载的 `result_read` 检查一个有界样本，再用
  `result_materialize` 将完整 Runtime NDJSON 临时交给 `process_exec` 中的 Python；只为脚本和用户明确
  要求的分析产物使用工作区 Tool 或 `result_save`。
- 测试不在线安装 Python 包。通过条件只依赖 Python 标准库；本机已有的第三方包可以使用，
  但不能成为验收前提。
- 所有项目数据均由测试在本机 PostgreSQL 中确定性生成。测试结束后删除临时 Schema 和工作区。
- 真实模型只接收合成任务描述、工具结果和必要分析数据。API Key 只通过测试进程环境传入，
  不写入报告、Journal、Fixture 或仓库文件。

## 场景清单

### `database-commerce-analysis`

电商经营分析项目包含客户、订单、订单明细、商品与营销活动。Agent 需要通过多表 SQL、CTE、聚合或
窗口函数回答收入趋势、品类贡献、复购和异常波动问题。

通过条件：

- 动态激活 Database Capability，并实际调用 `sql_execute`。
- 至少执行两次只读 SQL，且查询覆盖多个业务表。
- 收入、品类、复购和月度异常均只统计 `orders.status = 'completed'` 的已完成订单，避免把业务口径
  差异误判为模型计算错误。
- 最终输出固定的 `ANALYSIS_RESULT` JSON；关键指标与 PostgreSQL 独立 Oracle 精确一致。
- 最终说明不能只是查询输出，必须包含至少一项与指标一致的经营解释。

### `database-churn-ml`

SaaS 流失分析项目包含账户、订阅、每日使用和支持工单。Agent 先用 SQL 生成紧凑的账户特征集，再把
完整 NDJSON 临时物化给标准库 Python 分类脚本执行。

通过条件：

- 使用 `sql_execute` 生成特征集，并在结果被保留时以 `result_read` 的 record 模式读取一个不超过 40 条的
  有界样本；模型必须收到完整样本 `data`，不能只收到被二次截断、无法解析的外层 preview。
- 使用 `result_materialize` 将完整 NDJSON 特征集交给 Python；不得要求模型按 `nextCursor` 读到 EOF 或
  手工搬运所有页面。
- 使用 `workspace_apply_patch` 创建 Python 脚本，并使用 `process_exec` 真实运行脚本；临时 NDJSON 不作为
  工作区数据文件创建。只有用户明确要求保留的分析产物才可经 `result_save` 或工作区 Tool 持久化。
- 脚本输出机器可读指标，至少包含样本数、准确率、多数类基线和主要风险因素。
- 准确率不低于独立 Oracle 定义的最低阈值，并高于多数类基线；最终
  `ANALYSIS_RESULT` 与脚本输出一致。

这里验证的是完整 SQL → Runtime Result → Run-scoped Materialization → Python 流程，不规定模型必须使用某一种
分类算法，也不以精确系数作为通过条件。

Database Capability 不注册 Run-level 交付校验器，也不裁决 Agent 是否可以结束。`sql_execute` 之后可继续
调用 `result_read`、`result_materialize`、工作区 Tool 与 `process_exec`；场景测试通过独立 Oracle 和工具后置条件验收整条流程，
而不是让某个 Capability 根据跨 Tool 调用顺序决定 Run 最终态。

标准 bundled Host 必须为 `workspace_apply_patch` 提供真实本地条件写后端。若该基础 Tool 只返回
`conditional_mutation_backend_unavailable`，本场景失败；模型改用 shell 写文件不能替代这项验收。

### `database-fraud-investigation`

支付风险调查项目包含交易、商户和拒付数据，并确定性注入少量异常模式。Agent 需要先探索数据、形成
假设，再执行补充 SQL，并用标准库 Python 对商户进行风险评分。

通过条件：

- 至少两轮 SQL 调查，后续查询必须针对商户或拒付风险进行收敛。
- 使用工作区 Tool 和 `process_exec` 运行 Python 风险评分脚本。
- 最终 `ANALYSIS_RESULT` 给出有序的高风险商户和原因。
- 注入的异常商户必须进入 Top-K；报告中的计数和比率与 PostgreSQL 独立 Oracle 一致。

## Fixture 与 Oracle

每个场景由四部分组成：Fixture 创建、自然语言任务、独立 Oracle 和清理逻辑。Fixture 使用唯一且不超过
PostgreSQL 63 字节标识符上限的 Schema 名称，避免数据库静默截断，也避免并行或失败重试相互污染。
业务数据允许使用公式和固定种子生成，但 Oracle 必须直接查询 PostgreSQL，不能复用模型输出或模型生成的
Python 结果作为真值。

最终答案使用以下稳定尾标记供机器读取：

    ANALYSIS_RESULT {"scenario":"...","metrics":{...}}

测试只对稳定字段、数值容差、Top-K 命中和工具后置条件做断言，不断言自然语言措辞。

## 运行与报告

`DBAGENT_LIVE_ACCEPTANCE_SCOPE` 可以选择单个场景、逗号分隔的多个场景或 `all`。三个分析项目与现有
`database-long-result` 基础设施回归分开报告；后者继续验证长结果、Artifact 与 Evidence，不承担业务
分析质量判断。

每个场景报告至少记录状态、耗时、模型、工具调用名和状态、结果引用、机器可读指标以及失败原因。
汇总报告列出 required 和 selected 场景。真实模型和 PostgreSQL 前置条件缺失时记录 `not-run`，
required gate 不得把它写成通过。

默认单场景 Agent 截止时间不超过 300 秒。场景失败后仍必须关闭 Runtime、数据库连接并删除唯一
Schema；清理失败要进入失败报告，不能静默吞掉。

## 分层验证

1. Fixture/Oracle 单元测试：数据规模、已知异常和阈值稳定。
2. 真实 PostgreSQL + 确定性 Agent：验证动态 Capability、SQL、结果引用、工作区和进程链路。
3. SiliconFlow 真实模型：验证模型能够自主完成相同项目。
4. 受影响包 lint、typecheck、默认测试和脚本合同测试。
