# SchemaNaut 上线前功能与数据管线审计（最终）

> **历史 2026-07 审计（已退役）：** 本报告针对已退役的 SDK/Server 架构，不能作为当前发布边界；请参阅[当前验证记录](../../docs/engineering/verification.md)。下文旧名称仅保留作历史证据。

审计日期：2026-07-26
覆盖：SDK、REST、CLI、WebUI、Agent、LLM Gateway、Database Runtime、Resource、Schema RAG、Session/Result、Skills、MCP
主状态索引：[00-traceability-matrix.md](00-traceability-matrix.md)

## 架构与数据管线

主执行链路：

```text
SDK / REST / CLI / WebUI
  -> DatabaseAgentRuntime
  -> LLM Gateway + Agent Runtime
  -> Tool Registry + Permission + Approval
  -> DatabaseAccessRuntime + Resource Registry
  -> PostgreSQL
  -> Portable JSON + Session-scoped Result Handle
```

Schema 上下文链路：

```text
ConnectionProfile(scope)
  -> Connector discovery
  -> scoped Resource graph
  -> Schema RAG index / durable snapshot
  -> stable revision freshness check
  -> retrieval
  -> SQL generation / Agent execution
```

该架构与产品文档一致：v0.1 的完整数据库实现是 PostgreSQL；SDK 是核心嵌入入口，REST/CLI/轻量 WebUI 是适配层；Agent、Skills、MCP 和 Schema RAG 均围绕安全 AI SQL 工作流服务。

## 审计发现与修复结论

| 领域             | 初始问题                                      | 最终状态                                                           |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| 数据库统一边界   | 注入 Runtime/兼容 Driver 可能形成双状态       | 快捷连接、发现、查询和 Agent 路径已收敛；通过                      |
| SQL 权限         | 公共 Query 可绕过 `read/edit/full`            | Runtime 统一授权并叠加物理只读；通过                               |
| Resource Scope   | by-id/state/Observation/Event 可能跨 Scope    | 统一 Scope 视图和冲突拒绝；通过                                    |
| Schema freshness | 外部 DDL、并发取消和 `maxTables` 处理不完整   | 稳定 revision、去重刷新、独立等待者取消和配置保留；通过            |
| 异步审计         | 提交即错误记录成功                            | submit/running/terminal 两阶段审计且终态幂等；通过                 |
| Portable JSON    | bigint/Date/bytes 可能破坏 SDK/REST/Tool 链路 | 公共边界统一 Portable JSON；通过                                   |
| 业务数据保真     | Secret 键规则误改写同名业务列                 | 配置 Secret 与数据库结果投影分离；通过                             |
| Result 生命周期  | 缺少进程总预算和安全裁剪                      | 单项/总量/TTL/Session 清理完整；通过                               |
| Agent 终态       | max-iterations/取消可能伪装完成               | verified、Checkpoint、Usage 与实际终态一致；通过                   |
| 子 Agent         | 仅内存、恢复/取消/等待不完整                  | SQLite 父子持久化、恢复与关闭等待完整；通过                        |
| RAG Snapshot     | 未接线、Scope/失败回滚/增量向量不完整         | SDK 接线、Scope 隔离、原子回滚和向量重建；通过                     |
| HTTP/SSE         | 断连不取消、关闭等待环、无背压                | Abort 生命周期、主动关闭、drain 背压；通过                         |
| LLM Cache/Job    | 跨租户/Runtime、主备顺序、浅拷贝和无界保留    | tenant + owner 隔离、输入/结果深快照、终态驱逐和分级预算完整；通过 |
| MCP              | 损坏配置被覆盖、未知 transport 开放失败       | fail closed；未知值拒绝；通过                                      |
| Workspace        | Shell 取消只终止直接子进程                    | Windows/Unix 进程树终止；通过                                      |
| PostgreSQL TLS   | `prefer` 无法保证预期语义                     | 支持四种明确模式并拒绝 `prefer`；通过                              |

## 所有权与一致性约束

- Connection Profile 的 `scope` 传播到每个发现 Resource；Connector 返回冲突 Scope 时失败关闭。
- 快捷连接绑定 `tenantId` 与规范化 Project 身份。
- Session 的读取、恢复、修改、删除、分叉和 Checkpoint 均按 Project 过滤。
- Result Handle 按 Session 隔离，并受大小、数量、TTL 与进程总预算限制。
- LLM 异步 Job 按 tenant 与 Runtime 随机 owner 复合隔离；Runtime 关闭只取消自身任务，终态任务重新执行数量驱逐。
- Schema Snapshot 按租户/Project 隔离；快照包含明文 Schema、注释、Glossary 和向量，目录安全由宿主负责。
- 默认 PostgreSQL 路径在生成/Agent 前检测外部 DDL。自定义兼容 Driver 的带外变更仍要求宿主调用 `indexSchema()`，这是公开边界而非隐藏自动能力。

## 最终验证

- TypeScript 构建、ESLint、差异格式：通过。
- 确定性测试：93 个文件、653 项通过。
- 真实 PostgreSQL：Driver、Connector、SDK、复杂业务场景和性能全部通过。
- 六组本地性能基准：最终隔离运行全部低于合同阈值；Resource Snapshot 恢复的一次同批运行抖动已通过隔离复跑核验。
- 最终 npm 包：来源清单校验通过，且隔离安装后的 SDK、Session、Server、REST、CLI、类型和 PostgreSQL 全链路通过。

真实 LLM 未运行，因为它会消耗外部 Token 且没有得到明确付费授权；本报告只把确定性 Provider 测试描述为本地模型边界验证。
