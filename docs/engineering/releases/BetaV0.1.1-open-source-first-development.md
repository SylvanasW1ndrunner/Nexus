# BetaV0.1.1 - 开源优先开发约束

## 背景

Agent、Schema RAG、MCP、SQL、Python、终端和打包能力都属于复杂系统。后续开发不能默认全部自研，应主动借鉴和复用优秀开源项目、SDK、组件和成熟架构模式，在保证许可证、打包、离线、安全和跨平台要求的前提下降低开发成本、提高迭代速度和技术质量。

## 变更内容

- 新增 `docs/engineering/open-source-first.md`，作为项目级开源组件评估规范。
- 明确 Agent、RAG、MCP、SQL、Python、终端、打包等模块在重大切片前必须做开源评估。
- 强化 `dbagent-dependency-packaging-review` 的使用地位：引入、升级或拒绝重要开源方案都要记录理由。
- 要求后续 release note 和模块文档记录依赖决策、许可证、打包影响、离线行为、安全边界和测试计划。

## 执行要求

后续开发涉及复杂能力时，必须先回答：

- 是否已有成熟开源实现或可借鉴架构。
- 该方案是否适合 Electron 桌面程序打包。
- 是否支持 Windows/Linux/macOS。
- 是否允许闭源商业分发。
- 是否会引入 native module、动态下载、模型文件或联网初始化。
- 是否能被 DBAgent 的 typed IPC、Tool Registry、Permission Manager、Provider、Session、RAG storage 等合同隔离。
- 如果不引入，拒绝理由是否充分。

## 验证

本次只更新工程文档和开发规范，不改变运行时代码。后续新功能切片在提交前必须把开源评估结论写入对应中文文档。
