# SchemaNaut 上线前旧版本残留审计（最终）

> **历史 2026-07 审计（已退役）：** 本报告针对已退役的 SDK/Server 架构，不能作为当前发布边界；请参阅[当前验证记录](../../docs/engineering/verification.md)。下文旧名称仅保留作历史证据。

审计日期：2026-07-26
判定基线：`README*`、`docs/product-functional-overview.md`、`docs/agent`、`docs/ai-sql`、`docs/foundation`、`docs/sdk`
主状态索引：[00-traceability-matrix.md](00-traceability-matrix.md)

## 最终结论

未发现旧 AgentIDE 的可执行产品残留。

源码、依赖、入口、文档和最终发布归档中均未发现 Electron 桌面壳、旧 IDE 项目树、终端 UI、旧账号/登录体系、旧 Agent 面板或独立治理运维 Agent。当前实现与 SchemaNaut v0.1 文档描述的可嵌入 AI SQL Agent Runtime 一致。

以下内容是当前产品合同，不是旧版本残留：

- Connector、Connection Profile、Resource、Observation、Audit 和 Metric；
- 用于连接、模型配置、Schema 发现和基础试用的轻量 WebUI；
- 公开 API 名称 `DatabaseAgentRuntime` 与 `DatabaseAgentError`；
- 与真实 Git remote 一致的 `Nexus` 仓库 URL；
- monorepo 内部构建使用的 `@dbagent/*` 包名。

不应为了“清理残留”删除这些现行能力或做无版本边界的破坏性 API 改名。

## 最终核对

| 项目              | 判定                                          | 证据                                  |
| ----------------- | --------------------------------------------- | ------------------------------------- |
| Electron/桌面壳   | 未发现                                        | 依赖、入口与构建配置扫描              |
| 旧 IDE 布局       | 未发现项目树、旧 Agent 面板或终端 UI          | `apps/server` 与 WebUI 复核           |
| 旧账号体系        | 未发现注册、登录、密码找回服务                | 源码与文档扫描                        |
| 治理运维 Agent    | 未发现独立产品面                              | Agent/Tool/Database foundation 调用链 |
| 轻量 WebUI        | 与 v0.1 定位一致                              | 产品功能文档                          |
| 公开 wire 标识    | 使用 `$schemanautType`/`schemanaut.*`         | 合同测试与最终归档扫描                |
| 内部 `@dbagent/*` | 仅存在于 monorepo；未泄漏到公开 `dist` import | 最终归档扫描                          |
| `Nexus` URL       | 与真实 remote 一致                            | Git 元数据                            |

## 发布物复核结果

最终 `.tgz` 已重新生成并完成解包扫描：

- 未发现 `@dbagent/` workspace-only import；
- 未发现 `$dbagentType` 或旧 `dbagent.*` 公开 wire 契约；
- 未包含旧 release 目录、内部报告、脚本、`.github` 或 `.env`；
- SDK 主入口、`@nwlworkshop/schemanaut/server`、CLI 和 REST 均从隔离安装目录成功运行。

因此，“是否仍有前期 AgentIDE 残留”这一审计项已关闭为通过。
