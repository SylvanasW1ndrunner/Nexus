# M2+ 后端优先阶段模块边界

本文补充 M0-M1.5 之后的模块边界。当前阶段继续冻结正式前端 UI，优先完成后端能力、服务合约、真实测试和中文工程文档。

## 总原则

- `packages/core-*` 不依赖 Electron。
- Electron main/preload 只负责组合 core 能力、安全边界、系统能力和 typed IPC。
- Renderer 只保留最小宿主和纯业务工具函数，不恢复旧 IDE UI。
- 能通过 service、typed IPC、CLI/test fixture 或 Vitest 验证的能力，不能依赖最终 UI 才算完成。
- 可插件化能力优先按官方插件候选设计。

## 模块边界

- `shared`：稳定类型、Result、错误码、IPC contract、导出契约。不得引入第三方框架对象模型。
- `core-db`：数据库 driver adapter、连接生命周期、SQL 安全、事务、回滚、Explain、schema 元数据、查询历史、导入导出、远程连接错误分类。
- `core-rag`：Schema document、索引、检索、context builder、连接级隔离、RAG eval。后续持久化和向量能力必须通过 adapter 隔离。
- `core-agent`：Agent runtime、权限、session、checkpoint、stream、Plan/Execute、失败恢复。不得直接绑定具体模型厂商 SDK。
- `core-tools`：统一 Tool Registry，接入 DB、RAG、workspace、Python、MCP 和官方插件工具。工具必须带权限、危险等级、schema 和审计元数据。
- `core-workspace`：工作区、文件、Python runtime、脚本执行、autosave、制品目录和 workspace tool 声明。
- `core-skills`：Skill 解析、校验、加载顺序、allowed tools 约束和执行计划。
- `core-llm`：Provider contract、OpenAI-compatible/SiliconFlow/Ollama/vLLM 等适配、stream 事件、token usage 和 resilience。
- `core-auth` / `core-usage`：本地账户、验证码、密码 hash、会话、用量、订阅/gateway 预留。
- `apps/desktop`：Electron 主进程、preload、IPC handler、系统对话框、安全存储、打包配置和最小 renderer 宿主。

## 官方插件候选边界

以下能力不得无边界地硬编码进单一服务，应优先保留插件化边界：

- Schema RAG 评估、ER 图、Schema 文档生成。
- SQL 优化、Explain 解释、数据库诊断。
- Python 数据分析脚本、报告生成、结果导出。
- MCP stdio adapter、market 安装、工具健康检查。
- workspace script tool 和第三方 Skill。

官方插件与第三方插件必须共用公开合约：manifest、权限、生命周期、Tool Registry 映射、健康检查、审计和禁用/卸载行为。

