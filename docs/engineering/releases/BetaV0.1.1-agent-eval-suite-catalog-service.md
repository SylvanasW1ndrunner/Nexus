# BetaV0.1.1 Agent Eval Suite Catalog Service

## 范围

本次版本切片新增 Agent/RAG 评测套件目录查询服务，继续遵守“功能优先、前端冻结”的开发路线。

新增能力：

- `AgentEvalSuiteCatalogService.list()`：查询官方插件和工作区 eval suite 的安全摘要。
- `AgentEvalSuiteCatalogService.get()`：按 `suiteId` 查询单个 suite。
- 支持按 suite id、来源类型和环境过滤。
- 默认不返回完整 manifest/suite；调用方必须显式开启 `includeManifest` 或 `includeSuite`。

## 兼容性

- 未修改 renderer UI。
- 未修改 Electron 主进程、preload 或 IPC 合同。
- 未新增 npm 依赖。
- 未改变现有 runner、manifest parser、workspace loader、official plugin registry 的执行语义。

## 验收重点

- service 查询不会触发 Agent、LLM、PostgreSQL 或报告写入。
- 官方 eval suite 仍默认关闭，必须显式启用。
- 工作区 suite 仍只从调用方指定的工作区读取。
- 返回明细使用深拷贝，调用方修改不会污染后续查询。

## 已知限制

- 当前 service 只提供后端查询合同，尚未暴露 typed IPC。
- 当前不负责 suite 执行权限确认；执行仍由 release/test gate 或后续主进程服务控制。
- 当前不接入第三方 eval 平台；后续如接入，应放在官方插件 adapter 层。
