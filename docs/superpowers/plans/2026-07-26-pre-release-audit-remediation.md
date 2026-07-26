# SchemaNaut v0.1 上线前审计与整改计划

> 日期：2026-07-26
> 范围：当前工作树中的产品文档、SDK、REST/CLI/WebUI、Agent/Tool/LLM/DB/RAG/MCP/Workspace 运行时、测试与 npm 发布物
> 原则：保留用户现有改动；每个行为修复先增加能够复现问题的失败测试，再做最小修复；最终门禁必须禁用 Turbo 缓存并以真实 PostgreSQL 和实际 `.tgz` 复验。

## 1. 产品基线

当前公开产品是 SchemaNaut v0.1 alpha：

- 核心交付面是 TypeScript SDK 与本地 REST，CLI 和轻量 WebUI 是辅助入口。
- v1 主路径是数据库连接、Schema RAG、AI SQL Agent、审批后执行、结果句柄和会话恢复。
- 当前不交付 Electron/桌面 IDE、项目树、终端 UI、账号系统或治理运维 Agent。
- Database Access、Resource、Observation、Audit、Metric 是文档明确保留的通用基础原语；它们不等同于治理运维 Agent。

## 2. 整改波次

### Wave A：安全与数据正确性（发布阻断）

1. 修复 Anthropic 流式错误可能回显 API Key。
2. 在 Database Access 统一执行 SQL 权限等级，缺少授权上下文时不得执行写入或 DDL。
3. 修复 bigint、Date、Uint8Array 等公开列值在结果句柄、字节统计和 Agent Tool 结果中被序列化失败或丢失。
4. 数据库结果不得因列名为 `password`、`token`、`secret` 等而改写业务数据；配置、参数和错误仍须脱敏。
5. 修复 MCP 配置损坏被静默覆盖、未知 transport 被降级为 stdio。

验收：每项均有先红后绿的定向测试；公开 JSON 仍使用 Portable JSON；写入/DDL 权限不能仅靠 `confirmed` 绕过。

### Wave B：Agent、异步任务和生命周期语义（发布阻断）

1. max-iterations、取消和异常不能标记为 `verified=true`、`done` 或成功用量。
2. queued/running 异步任务不能提前写为审计成功；终态审计必须且只能追加一次。
3. 非流式 HTTP 断连也必须取消 Agent/LLM 工作；Runtime 关闭须主动取消并等待活跃运行。
4. Shell 取消/超时须覆盖进程树，并处理调用前已取消的信号。
5. 子 Agent 的父子关系、状态和终态须持久化；父任务取消须向子任务传播。

验收：状态、审计、checkpoint、usage、取消信号和恢复后的父子关系相互一致。

### Wave C：SDK/RAG 主数据管线（发布阻断）

1. 注入的 `databaseAccess` 必须成为连接、索引、Agent SQL 和快捷查询的同一数据库边界，避免产生平行 runtime/driver。
2. 外部 DDL 导致 source revision 变化时，Agent 运行前自动刷新 Schema 索引。
3. DDL 后重建索引不得丢失调用方的 `maxTables` 配置。
4. 将已实现的 RAG snapshot/progressive index 能力接入 SDK 生命周期，保证中断恢复与索引一致性。
5. 为结果句柄增加进程级总字节预算，避免 100 个 8 MiB 句柄造成约 800 MiB 常驻；截断不得先复制完整大结果。

验收：连接→发现→索引→检索→生成→审批→执行→结果句柄→会话证据形成一条可追踪的数据管线，并覆盖外部 DDL 和恢复场景。

### Wave D：流量、缓存和资源边界（高优先级）

1. LLM 流式帧、缓冲区、文本和 Tool 参数设置明确上限。
2. REST 流式输出尊重背压，并在连接关闭时释放工作。
3. LLM response cache 返回深拷贝，调用方不能修改缓存中的嵌套 Tool 参数。
4. Resource scoped view 补齐按 id、状态、Observation、Event 的 scope 过滤。
5. Workspace 在可移植能力范围内进一步收紧路径竞态；无法完全消除的同用户 TOCTOU 风险写入部署边界。

验收：故障注入不会导致无界内存、跨 scope 读取或取消后继续工作。

### Wave E：发布与供应链门禁（发布阻断）

1. npm 包验证器必须校验 `SHA256SUMS.txt`。
2. 扩展 Secret 扫描规则并提供不会打印秘密值的回归测试。
3. 校验 root/server/package/README/CHANGELOG 的版本一致性。
4. CI 显式设置最小权限、checkout 不持久化凭据，并增加 Windows 关键门禁。
5. 从隔离安装的实际 npm 包运行 PostgreSQL connect/query/read-only/cancel 验收。
6. 生成最终 `.tgz` 与 SHA-256，并对解包内容、SDK、CLI、REST、类型声明和旧内部包名做实物复验。

验收：候选包、哈希、测试报告均来自同一工作树；安装包而非源码能够通过 PostgreSQL 验收。

## 3. 不作为缺陷整改的审计项

- 不移除通用 Database Access/Resource/Observation/Audit/Metric：它们是当前 foundation 与 SDK 文档的明确合同；需要修的是权限与一致性，不是删除合同。
- 不删除轻量 WebUI 中的连接状态、资源发现和基础指标：当前页面没有旧 AgentIDE 的项目树、终端、桌面壳或治理操作面。
- 不把 `DatabaseAgentRuntime`/`DatabaseAgentError` 仅凭命名判定为旧 AgentIDE 功能；它们是当前公开文档中的 Agent SDK 类型。品牌命名迁移应单独作为破坏性 API 决策。
- 不把真实远端仓库名 `Nexus` 判定为错误链接。
- `@dbagent/*` 是 monorepo 内部 namespace；发布物必须继续强制证明其不泄漏，但本轮不做高风险的全仓包名迁移。
- 身份认证、Web SSRF、数据库 RLS/对象权限、持久 Secret Vault 和 OS 沙箱继续属于文档已声明的宿主边界。

## 4. 最终验证顺序

1. 所有新增定向测试。
2. 无缓存 typecheck、lint、全仓单元/集成测试。
3. LLM、Database、Resource、AI SQL 与公开 API 性能门禁。
4. 本机 PostgreSQL 16 全场景测试。
5. npm 候选包生成、哈希校验、隔离安装、SDK/CLI/REST/类型与真实 PostgreSQL 测试。
6. 跟踪文件和候选包的 Secret 扫描；依赖漏洞查询仅在用户明确授权发送依赖元数据后执行。
7. 由未参与实现的独立审查 Agent 复核代码、文档和验证证据。
