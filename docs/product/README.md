# DBAgent 产品文档

> 面向中国数据库生态的可嵌入式 AI Database Agent Runtime
> 文档版本：v1.0（Headless / SDK-first 路线）
> 路线生效日期：2026-07-21

## 1. 文档仲裁顺序

发生范围、架构或优先级冲突时，按以下顺序处理：

1. [07-design-principles.md](./07-design-principles.md)：最高产品与工程原则。
2. [00-overview.md](./00-overview.md)：产品定位、用户、架构和长期路线。
3. [11-headless-mvp.md](./11-headless-mvp.md)：当前可试用 MVP 的唯一范围基线。
4. [05-development-guide.md](./05-development-guide.md)：实现顺序、代码边界和质量门禁。
5. 其他模块设计：说明各核心能力的详细设计，不得扩大 MVP 范围。

## 2. 文档索引

| # | 文档 | 当前定位 | 状态 |
|---|---|---|---|
| 00 | [产品总览](./00-overview.md) | Headless Runtime、目标用户、产品架构与路线 | 当前 |
| 01 | [产品入口与极简 WebUI](./01-ui-design.md) | SDK、API、CLI、MCP、参考 WebUI | 当前 |
| 02 | [Schema RAG](./02-rag-design.md) | Schema 提取、索引、检索和上下文构建 | 核心模块 |
| 03 | [Agent 与工具](./03-agent-design.md) | Agent Loop、权限、工具、Skill、MCP | 核心模块 |
| 04 | [配置与凭证](./04-config-design.md) | Provider、数据库连接、Secret 和配置边界 | 核心模块 |
| 05 | [开发指南](./05-development-guide.md) | SDK-first 架构、里程碑和验收规则 | 当前 |
| 06 | [传统数据库 IDE 能力](./06-classic-features.md) | 后续可选客户端能力，不属于当前 MVP | 延后 |
| 07 | [设计原则](./07-design-principles.md) | 所有决策的最高仲裁文件 | 当前 |
| 08 | [工作空间与 Python](./08-workspace-design.md) | 后续工具/插件扩展能力 | 延后 |
| 09 | [错误与恢复](./09-error-recovery.md) | Runtime、API 和任务运行的恢复原则 | 核心模块 |
| 10 | [商业模式与用量](./10-usage-and-subscription.md) | Community、Team、Enterprise、OEM | 当前 |
| 11 | [Headless MVP](./11-headless-mvp.md) | 第一版可运行范围、API 和试用流程 | 当前 |

## 3. 已确认的产品决策

- DBAgent 的主体是 **可嵌入式 Database Agent Runtime**，不是数据库 IDE。
- TypeScript SDK 和本地 REST API 是首要公共入口。
- CLI、MCP 和 WebUI 都是同一 Runtime 的薄适配层，不拥有独立业务逻辑。
- WebUI 只承担连接配置、提问、SQL 审核、执行和结果查看。
- PostgreSQL 是第一版唯一真实数据库；其他数据库通过 Driver 接口逐步增加。
- 所有自动生成 SQL 默认只读；执行必须经过独立的安全审计和显式动作。
- API key 和数据库密码只存在于服务端内存或 Secret Store，不进入浏览器、日志和运行结果。
- 当前不重建复杂 Electron UI；已有桌面端保留为兼容宿主和能力参考。
- 付费价值是生产化、治理、评测、团队知识和私有化，不以转售 LLM token 为核心。

## 4. 当前 MVP

第一版只验证一条端到端路径：

1. 用户在本机启动 DBAgent Server。
2. 配置 OpenAI-compatible 模型和只读 PostgreSQL 连接。
3. Runtime 抽取并索引 Schema。
4. 用户用自然语言提出查询问题。
5. Runtime 检索相关 Schema，生成单条只读 SQL 并给出解释。
6. SQL 经过安全审计后展示给用户。
7. 用户显式执行，查看表格结果。

MVP 的完整验收标准见 [11-headless-mvp.md](./11-headless-mvp.md)。

## 5. 当前不做

- 复杂 SQL IDE、表设计器、ER 编辑器和 BI 仪表盘。
- 桌面端多栏工作台重建。
- 自动执行写 SQL、DDL 或数据库修复动作。
- 多数据库并行适配。
- 插件市场和复杂安装 UI。
- 云端账号、支付、团队管理和用量计费后台。
- 多 Agent、子 Agent、通用工作流平台和大规模 Python 工作空间。

## 6. 开发入口

- 当前切片与实现顺序：[05-development-guide.md](./05-development-guide.md)
- MVP 合同与试用方式：[11-headless-mvp.md](./11-headless-mvp.md)
- 工程模块说明：[../engineering/modules.md](../engineering/modules.md)
- 测试策略：[../engineering/test-strategy.md](../engineering/test-strategy.md)
