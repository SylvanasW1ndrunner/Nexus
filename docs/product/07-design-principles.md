# 07 - 设计哲学与原则

> 文档版本：v1.0
> 本文档是产品范围、架构和实现决策的最高仲裁文件。

## 1. 产品宗旨

> 用一个安全、准确、可评测的 Headless Runtime，把自然语言查数和数据库运维能力嵌入任何产品、Agent 和内部系统。

我们的差异化不是复杂 IDE，也不是模型聊天框，而是：

- 面向数据库场景的上下文工程。
- 生成、审计、审批和执行分离。
- 面向生产环境的稳定合同、恢复、评测和审计。
- 国内模型、私有化环境和中国数据库生态适配。

## 2. 七条最高原则

### 2.1 Headless first

- 核心能力必须先以 SDK/Runtime 公共合同交付。
- REST、CLI、MCP、WebUI 和 Desktop 都是薄适配层。
- 无 UI 时无法测试或使用的能力，不属于合格的核心能力。

### 2.2 One runtime, thin adapters

- 同一业务规则只实现一次。
- SQL 安全、Schema 检索、审批和错误语义不得在不同入口重复实现。
- 公共合同传输无关，不暴露 Electron IPC、HTTP 框架或第三方 SDK 类型。

### 2.3 Read-only and evidence first

- 自动生成 SQL 默认只读。
- 生成和执行是两个独立动作。
- 执行前必须本地重新审计。
- 输出应包含 SQL、解释、假设、Schema 证据和风险报告。
- 模型声明“安全”不能替代本地确定性安全规则。

### 2.4 Evaluation before feature breadth

- 优先提高固定业务案例的执行正确率，而不是增加更多按钮和 Agent 能力。
- 断言行为、工具调用、安全结果和数据库结果，不断言模型文案。
- Verified Query、用户修正和失败案例是长期产品资产。
- 没有评测方法的新智能能力不得成为默认路径。

### 2.5 Developer experience is user experience

- 十分钟 Quickstart、类型完整、错误可行动、示例可复制。
- API 稳定性、版本策略和文档质量等同于传统产品的界面质量。
- 不同时维护多套独立 SDK；TypeScript 与 REST 先稳定，其他语言从 OpenAPI 生成。

### 2.6 China-ready and deployable

- 优先兼容 OpenAI-compatible 国内模型、Ollama、vLLM 和私有 endpoint。
- 本地与私有化部署是一级形态，不是企业版补丁。
- 默认不要求把数据库凭证或完整业务数据上传到 DBAgent 云端。
- 数据库适配通过 Driver Registry 演进，先 PostgreSQL，再按真实需求扩展。

### 2.7 Small team discipline

- 三人团队优先完成薄垂直切片。
- 优先复用现有 core 包和成熟开源接口模式。
- 不用未来的多租户、市场、复杂 UI 和多 Agent 需求污染 MVP。
- 新依赖必须评估许可证、打包、离线、跨平台和维护成本。

## 3. 模块化边界

```text
core-db / core-rag / core-llm / core-agent / core-tools
                         ↑
                    public SDK
                         ↑
             REST / CLI / MCP / WebUI / Desktop
```

强制约束：

- core 包不依赖 Electron、React 或某个 HTTP 框架。
- Secret 只存在于可信服务端边界。
- WebUI 不拿数据库连接池、Provider 实例和长期凭证。
- Tool 通过 Registry 注册，权限由统一 Policy 决策。
- Skill 只能收窄工具权限，不能扩大权限。
- 插件优先采用声明式 manifest 或进程外/MCP 隔离。

## 4. 安全原则

### 4.1 默认策略

- 数据库连接默认并强制只读。
- 查询默认限制结果行数和执行超时。
- 多语句、写入、DDL、未知语句和需要确认的语句不得走 MVP 执行接口。
- Runtime 只能执行当前运行记录中保存的已生成 SQL，不能接受 WebUI 直接提交任意 SQL。

### 4.2 凭证

- API Key 和数据库密码不进入日志、错误、运行快照和前端存储。
- 本地 MVP 仅在内存中保存 Secret，进程退出即清除。
- 后续持久化必须使用 OS Keychain 或企业 Secret Manager。

### 4.3 网络

- 本地 Server 默认只监听 loopback。
- 远程监听必须先具备认证、TLS、租户隔离和审计，不能靠用户自行“注意安全”。
- 遥测默认关闭；启用时明确字段和用途。

## 5. 产品范围决策

### 5.1 MVP 必做

- PostgreSQL 只读连接。
- Schema 抽取、索引、检索和上下文。
- OpenAI-compatible NL2SQL。
- 本地 SQL 安全分析。
- 人工审核后执行生成 SQL。
- SDK、REST、CLI 启动和极简 WebUI。
- 确定性测试、真实 PostgreSQL 门控和真实模型门控。

### 5.2 后续能力

- MCP Server、Verified Query、OpenAPI 和 Python client。
- EXPLAIN、慢 SQL、锁、会话和长事务诊断。
- 团队语义知识、RBAC、审计、SSO 和私有化控制面。
- 国产数据库 Driver 和 OEM 能力。

### 5.3 当前不做

- 再造 Navicat、DBeaver 或完整 Cursor 数据库 IDE。
- 复杂 Electron / React 工作台重建。
- 表设计器、ER 编辑器、BI 仪表盘和可视化查询构建器。
- 自动写库和全自动修复。
- 插件市场 UI 和未经隔离的第三方进程内插件。
- 多 Agent 编排平台。
- 为所有语言手写 SDK。
- 以转售 LLM token 作为主要商业壁垒。

## 6. UI 原则

WebUI 只回答五个问题：

1. Runtime 是否准备好？
2. 当前连接和 Schema 是否可用？
3. 模型生成了什么 SQL，依据是什么？
4. SQL 是否安全，是否可以执行？
5. 执行结果或错误是什么？

如果一个界面元素不能服务这五个问题，默认不进入 MVP。

## 7. 开源与依赖原则

1. 先定义产品能力和公共合同。
2. 比较成熟依赖、小型依赖/平台能力和本地实现。
3. 第三方实现通过 adapter 隔离。
4. 不让第三方类型污染 SDK、运行记录和工具权限合同。
5. 记录许可证、包体积、native module、离线行为、Windows/Linux 和安全影响。
6. 已有可靠实现时不为“架构漂亮”重复引入框架。

## 8. 决策仲裁

发生争议时依次回答：

1. 是否让 Headless Runtime 更准确、安全或易集成？
2. 是否是当前 MVP 用户路径的必要环节？
3. 是否能由已有 core 能力完成？
4. 是否增加新的长期维护面？
5. 是否有确定性测试和真实门控验证？
6. 如果不做，用户还能否完成核心任务？

只要第 2 条为否且第 6 条为是，默认延后。

重大决策写入 `docs/engineering/adr/`，并同步修改 [00-overview.md](./00-overview.md)、[05-development-guide.md](./05-development-guide.md)和当前 MVP 文档。

## 9. 每个切片的完成清单

- [ ] 有具体用户场景。
- [ ] 所属模块和公共合同明确。
- [ ] Secret、SQL、文件、进程或网络安全边界明确。
- [ ] 不依赖正式 UI 即可调用。
- [ ] 成功、失败、非法输入、超时/取消和恢复路径有测试。
- [ ] 外部系统风险有真实门控验证。
- [ ] 中文文档、示例和已知限制已更新。
- [ ] 没有扩大当前 MVP。
