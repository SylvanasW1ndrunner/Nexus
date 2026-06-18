# BetaV0.1.1 - 开源优先开发约束

## 背景

Agent、RAG、MCP、SQL、Python、终端等模块都属于复杂系统。后续开发不能默认自研所有能力，应主动借鉴和复用优秀开源项目、SDK、组件和成熟架构模式，在保证许可证、打包、离线、安全和跨平台要求的前提下降低开发成本、提高迭代速度和技术质量。

## 变更内容

- `dbagent-agent-tooling-development`：新增 Agent 复杂能力的开源评估要求。
- `dbagent-schema-rag-development`：新增 RAG 子系统开源评估要求。
- `dbagent-dependency-packaging-review`：补充 Agent/RAG/MCP/SQL/Python/终端等能力的主动开源调研要求。
- `docs/engineering/development-skills.md`：同步推荐开发顺序，要求复杂能力先做开源组件和打包影响评估。

## 评估要求

引入或拒绝开源方案时，需要记录：

- 候选项目或库，以及评估的具体能力。
- 许可证和商业分发兼容性。
- 包体积、原生模块、模型下载、离线安装、Windows/Linux/macOS 和 Electron 打包影响。
- 安全边界：密钥、工具执行、沙箱逃逸、prompt/tool injection、日志脱敏。
- 与 DBAgent 合同的适配：Tool Registry、Permission、Session、RAG storage、Provider、typed IPC。
- 决策结论：复用、适配、fork、只借鉴设计或自研。

## 验证

- 本次只更新开发流程文档和 skill，不改变运行时代码。
- 后续涉及复杂能力的新切片必须把开源评估结果写入对应模块文档或 release note。
