# 开源优先开发规范

## 目标

DBAgent 的 Agent、Schema RAG、MCP、SQL、Python、终端、插件和打包能力都属于复杂系统。开发这些模块时，默认先评估成熟开源项目、SDK、库和架构模式，再决定复用、适配、fork、借鉴设计或自研。

这不是无条件堆依赖。我们的最终交付形态是桌面程序，任何依赖都必须同时满足产品能力、许可证、离线可用、跨平台、打包、性能和安全边界。

## 必须先评估的场景

- Agent runtime：tool calling、ReAct/Plan workflow、checkpoint、memory、tracing、eval、guardrail、多 Agent 协作。
- Schema RAG：metadata extraction、FTS/vector index、hybrid retrieval、rerank、embedding、context builder、RAG eval。
- MCP/plugin：MCP client/server SDK、tool adapter、process manager、marketplace manifest、permission model。
- SQL 能力：SQL parser、formatter、lint、lineage、explain analysis、query cancellation、result export。
- Python/terminal：PTY、process supervision、venv/conda detection、package installation、streaming logs。
- 打包与运维：native module、runtime binary、license inventory、diagnostics、auto update。

## 评估维度

每次引入或拒绝一个重要开源方案，都必须在对应模块文档或 release note 中记录：

- 候选项目：项目名、仓库/文档链接、评估的具体能力。
- 许可证：是否允许闭源商业分发，是否存在传染性许可证或 NOTICE 要求。
- 打包影响：包体积、native module、postinstall、动态下载、模型文件、Electron asar/unpacked 要求。
- 离线行为：安装后无网络是否可用；首次运行是否需要下载；失败时是否可降级。
- 跨平台：Windows、Linux、macOS 的路径、shell、二进制和权限差异。
- 安全边界：secret 暴露、工具执行、沙箱逃逸、prompt/tool injection、日志脱敏。
- 产品适配：是否能映射到 DBAgent 的 typed IPC、Tool Registry、Permission Manager、Provider、Session、RAG storage 等合同。
- 测试计划：默认单测、真实 PostgreSQL/进程/LLM 门控测试、打包烟测。
- 决策结论：复用、适配、fork、只借鉴设计或自研，并说明原因。

## 决策原则

- 通用基础能力优先复用成熟开源：例如 PTY、schema validation、SQL parser、RAG eval、vector index、MCP SDK。
- 产品差异化能力可以自研：例如 DBAgent 的连接级 Schema RAG 语义、数据工程权限策略、SQL 审查策略、Agent 与工作区制品的组合合同。
- 对桌面端打包不稳定、许可证不清晰、默认联网下载、难以离线使用或安全边界不清的依赖，默认拒绝或延后。
- 先通过 adapter 隔离第三方依赖，不把外部库类型泄露成 DBAgent 的公开合同。
- 引入 native module 前必须有打包烟测；引入模型/向量库前必须有离线降级策略。

## 当前优先观察方向

以下项目只作为评估方向，不代表已经决定引入。具体版本、许可证和打包影响必须在实际切片中重新确认。

- Agent/Workflow：LangChain/LangGraph、LlamaIndex.TS、Haystack 的 agent、tool、workflow、tracing、eval 设计。
- Schema RAG：LlamaIndex、Haystack、pgvector、SQLite FTS/向量扩展、RRF/rerank 相关实现。
- SQL：成熟 SQL parser/formatter/linter，优先选择支持 PostgreSQL 且可在 Node/Electron 中稳定打包的方案。
- MCP/plugin：官方 MCP SDK、Smithery 或兼容 marketplace 的 manifest/安装/健康检查模式。
- Terminal/Python：node-pty、xterm.js、conda/venv 生态的标准检测方式。

## 文档落点

- 新依赖或重大依赖升级：更新 `docs/engineering/open-source-first.md` 或对应模块文档。
- Agent/RAG/MCP 设计借鉴：写入 `docs/engineering/modules/core-agent.md`、`core-rag.md`、`core-tools.md` 或 release note。
- 打包影响：写入 `docs/engineering/packaging.md` 或对应 release note。
- 测试影响：写入 `docs/engineering/test-strategy.md` 或模块测试说明。
