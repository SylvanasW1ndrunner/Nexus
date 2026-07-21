# 00 - 产品总览

> 文档版本：v1.0
> 产品路线：Headless Runtime / SDK-first
> 当前实现范围：[11-headless-mvp.md](./11-headless-mvp.md)

## 1. 一句话定位

> DBAgent 是面向中国数据库生态的可嵌入式 AI Database Agent Runtime，让 SaaS、数据平台、运维系统和 AI 客户端通过 SDK、API 或 MCP 获得自然语言查数与安全数据库运维能力。

我们不以“再造一个 Navicat、DBeaver 或 Cursor 风格 IDE”为目标。官方 WebUI 只用于试用、调试、审批和结果查看。

## 2. 目标用户

### 2.1 第一阶段

| 用户 | 典型需求 | 采用方式 |
|---|---|---|
| SaaS / ISV 开发团队 | 在自己的产品中嵌入自然语言查数 | TypeScript SDK / REST API |
| 企业数据平台团队 | 给内部系统增加统一数据库 Agent | 私有部署 Server / API |
| DBA 与研发效能团队 | 将查询、诊断和 Runbook 接入现有工具 | CLI / MCP / API |
| AI Agent 平台开发者 | 给通用 Agent 增加受控数据库工具 | MCP / Tool Plugin |

### 2.2 当前不作为主目标

- 需要完整可视化 BI 的业务用户。
- 需要传统数据库 IDE 全功能的重度 SQL 编辑用户。
- 希望零配置、纯云端托管数据库分析的个人用户。

不做复杂 UI 会降低终端用户获客范围，但能让三人团队把资源集中在准确率、安全、集成体验和中国数据库生态适配上。

## 3. 用户问题

当前自然语言转 SQL 产品普遍存在以下问题：

1. 只看到表结构，不理解业务口径和历史正确 SQL。
2. 生成 SQL 后缺少结构化校验、风险审计和执行隔离。
3. Demo 容易，嵌入生产系统困难：接口不稳定、凭证边界不清晰、无法审计。
4. 数据库运维能力通常与 Text-to-SQL 分离，无法共享上下文、工具和权限。
5. 国内模型、私有化环境、网络条件和国产数据库支持不足。

DBAgent 的核心价值不是“让模型写出一段 SQL”，而是让数据库任务在生产环境中 **可理解、可控制、可评测、可审计、可嵌入**。

## 4. 产品形态

```text
客户应用 / AI 客户端 / 自动化系统 / 极简 WebUI
                    │
        TypeScript SDK / REST / CLI / MCP
                    │
              DBAgent Runtime
       ┌────────────┼────────────┐
       │            │            │
 Schema RAG   SQL Safety    Agent / Tools
       │            │            │
 语义知识库     审批与审计     查询与运维任务
       └────────────┼────────────┘
                    │
          Database Driver Registry
                    │
              PostgreSQL（MVP）
```

### 4.1 同一核心，多种入口

- **SDK**：进程内使用 Runtime，适合 Node.js 服务和桌面/本地产品。
- **REST API**：语言无关，适合远程服务、内部平台和 OEM 集成。
- **CLI**：完成启动、健康检查、Schema 索引和自动化任务。
- **MCP Server**：将受控数据库工具暴露给外部 AI 客户端。
- **WebUI**：REST API 的官方参考客户端，不承载独有能力。

所有入口共享统一的请求、事件、错误和审批语义。任何核心能力都必须能在没有正式 UI 的情况下测试和使用。

## 5. 核心能力

### 5.1 Schema Context

- 从数据库 Catalog 提取表、字段、注释、主外键、索引和约束。
- 按连接隔离索引。
- 支持词法、显式引用、关系扩展和后续向量检索。
- 支持业务词汇、Verified SQL 和文档作为补充知识源。

### 5.2 Natural Language to SQL

- 根据问题检索相关 Schema，而不是把全库结构塞入 Prompt。
- 要求模型输出结构化 SQL、解释和假设。
- 生成结果必须经过本地 SQL 安全分析。
- 生成和执行分离，默认不执行。
- 用户修正的 SQL 后续可沉淀为 Verified Query。

### 5.3 Database Agent 与运维

- 将 Schema 检索、查询、EXPLAIN、慢 SQL、锁和会话诊断注册为受控工具。
- 通过 Tool Registry、权限策略和审批记录限制副作用。
- 运维动作优先生成建议和预览，写操作延后到安全体系成熟后开放。

### 5.4 生产化能力

- 运行状态、取消、超时和错误分类。
- 审批、审计和敏感信息脱敏。
- 可复现评测集与行为断言。
- 本地运行、BYOK 和私有化部署。
- Provider、数据库和工具适配器。

## 6. Headless MVP 范围

第一版验证以下完整闭环：

- OpenAI-compatible BYOK 模型。
- PostgreSQL 只读连接。
- Schema 抽取和内存索引。
- 自然语言问题生成单条只读 SQL。
- SQL 解释、假设、上下文证据和安全报告。
- 用户显式执行已生成 SQL。
- 查询结果行数限制和结构化错误。
- TypeScript SDK、本地 REST API、CLI 启动入口和极简 WebUI。

第一版明确不包含：写 SQL、复杂 Agent 规划、子 Agent、插件市场、多租户云服务、完整订阅系统和传统数据库 IDE。

## 7. 产品原则

1. **Headless first**：核心能力先以公共合同交付，再做客户端。
2. **Read-only first**：自动生成 SQL 默认只读，生成与执行分离。
3. **Evidence first**：返回检索证据、SQL 解释和安全判断，不只返回答案。
4. **Evaluation first**：正确率和安全性必须由固定案例持续验证。
5. **China-ready**：优先兼容国内 OpenAI-compatible 模型、私有化环境和后续国产数据库。
6. **One runtime, thin adapters**：SDK、REST、CLI、MCP、WebUI 不重复实现业务逻辑。
7. **Developer experience is UX**：文档、类型、错误、示例和十分钟接入体验就是核心界面。

完整原则见 [07-design-principles.md](./07-design-principles.md)。

## 8. 成功指标

### 8.1 MVP 指标

- 新用户从启动到第一次生成 SQL不超过 10 分钟。
- SDK 完成最小集成不超过 30 行核心代码。
- 固定测试集中，只读 SQL 安全拦截无漏放。
- 每次生成都返回可解析结构和安全报告。
- Runtime、API 和 WebUI 对同一任务返回一致语义。
- PostgreSQL 真实集成测试覆盖连接、索引、生成后的执行和断连。

### 8.2 产品指标

- 执行正确率，而不是仅语法正确率。
- 用户接受或少量修改后执行的比例。
- Verified Query 被复用后带来的准确率提升。
- 第三方产品完成嵌入所需时间。
- 团队环境中的审批、审计和私有化转化率。

## 9. 商业化方向

- **Community**：本地单用户、BYOK、基础 SDK/API/CLI/MCP。
- **Team**：共享语义知识、Verified SQL、评测、RBAC、审计和集中 Secret。
- **Enterprise**：私有化、高可用、SSO、国产数据库适配、自定义策略和 SLA。
- **OEM / Embedded**：供软件厂商嵌入，按环境、实例、并发或年度授权收费。
- **Managed LLM**：作为可选增值服务，不作为主要产品壁垒。

详见 [10-usage-and-subscription.md](./10-usage-and-subscription.md)。

## 10. 路线图

| 阶段 | 目标 | 主要交付 |
|---|---|---|
| H0 | 路线重构 | 产品文档、公共边界、MVP 验收 |
| H1 | 可试用 MVP | SDK Runtime、REST、CLI、极简 WebUI、PG 只读闭环 |
| H2 | 可嵌入 Beta | MCP Server、Verified Query、评测报告、持久化运行记录 |
| H3 | 运维 Agent | EXPLAIN、慢 SQL、锁、会话和受控 Runbook |
| H4 | 团队与商业化 | RBAC、审计、团队知识、私有化与 OEM |

当前只以 H1 为开发目标，不得用 H2-H4 的需求扩大 MVP。
