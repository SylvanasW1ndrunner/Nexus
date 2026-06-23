# BetaV0.1.1 - Agent/RAG 开源优先开发纪律强化

## 背景

当前开发路径是先完成除最终前端 UI 外的所有核心能力。Agent 和 Schema RAG 是 DBAgent 的核心复杂系统，不能默认全部自研，也不能无约束堆依赖。后续开发需要主动借鉴优秀开源项目、SDK、组件和成熟架构模式，同时保证 Electron 桌面打包、离线可用、许可证、安全边界和 typed contracts 稳定。

## 本次调整

- 强化 `docs/engineering/open-source-first.md`：
  - 新增编码前开源调研流程。
  - 新增 Agent/RAG 特别要求。
  - 新增 release note / 模块文档记录模板。
- 强化 `docs/engineering/modules/core-agent.md`：
  - Agent runtime、workflow、tool calling、checkpoint、session、tracing、eval、guardrail 等能力必须优先调研成熟方案。
  - 第三方 Agent 框架只能通过 adapter 接入，不能污染 `ToolRegistry`、权限、会话、用量和 IPC 稳定合同。
- 强化 `docs/engineering/modules/core-rag.md`：
  - RAG 的向量索引、FTS、RRF/rerank、embedding、metadata parser、eval、图扩展等能力必须优先评估成熟实现。
  - 第三方 RAG 框架或向量库只能接入 extractor/indexer/retriever/provider/storage 层，不能定义 DBAgent 对外模型。
- 强化仓库内开发 skill：
  - `dbagent-feature-first-development`
  - `dbagent-agent-tooling-development`
  - `dbagent-schema-rag-development`
  - `dbagent-dependency-packaging-review`

## 执行要求

后续涉及 Agent、RAG、MCP、SQL parser、embedding、向量存储、Python runtime、终端进程、插件市场或打包链路的切片，编码前必须先回答：

- 是否有成熟开源项目、SDK、组件或架构模式可复用。
- 是否查阅了官方仓库、官方文档、许可证和 release/build 说明。
- 该方案是否兼容闭源商业分发、Electron 打包、Windows/Linux/macOS、离线使用和安全边界。
- 能否通过 adapter 映射到 DBAgent 的 typed IPC、Tool Registry、Permission Manager、Provider、Session、RAG storage 等合同。
- 如果不复用，拒绝理由是否充分。

## 验证

本次只更新中文工程文档和开发 skill，不改变运行时代码。后续功能切片提交前，review 应检查对应 release note 或模块文档中是否存在开源评估结论；缺少结论时不能视为开发闭环完成。
