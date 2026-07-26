# SchemaNaut v0.1 上线前审计追踪矩阵

更新日期：2026-07-26

## 总体判定

**本地发布候选有条件通过。** 代码、数据管线、真实 PostgreSQL、性能和最终安装包门禁均已通过；未发现旧 AgentIDE 的可执行残留，也没有尚未修复的本地 P0/P1/P2 实现缺陷。

“有条件”仅指三类外部证据尚未产生：GitHub 托管 CI 实际运行、依赖漏洞公告查询、真实付费 LLM。它们不能由本地确定性测试冒充。

## 追踪矩阵

| ID          | 领域                 | 最终结论                                                                           | 状态           | 证据                                       |
| ----------- | -------------------- | ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| LEG-01      | Electron/AgentIDE    | 未发现桌面壳、项目树、终端 UI、旧账号体系、旧 Agent 面板或治理运维 Agent           | 通过           | 源码/依赖/入口扫描                         |
| LEG-02      | Database foundation  | Database Access/Resource/Audit/Metric 是现行产品基础，不是旧残留                   | 产品边界确认   | 产品文档与调用链                           |
| LEG-03      | 轻量 WebUI           | 当前单页仅承担连接、配置、发现和基础试用                                           | 产品边界确认   | WebUI 与功能文档                           |
| LEG-04      | 公共类型命名         | `DatabaseAgentRuntime`/`DatabaseAgentError` 是当前公开合同                         | 产品边界确认   | 双语 SDK 文档                              |
| LEG-05      | `Nexus` URL          | 与真实 Git remote 一致                                                             | 误报撤销       | Git 元数据                                 |
| LEG-06      | 内部包/旧 wire       | monorepo 可保留 `@dbagent/*`；公开包无内部 import、`$dbagentType` 或旧 `dbagent.*` | 通过           | 最终 `.tgz` 扫描                           |
| SEC-01      | LLM Secret           | 流式/非流式错误、嵌套 Detail 和自定义 Header Secret 均脱敏                         | 通过           | core-llm 与归档扫描                        |
| SEC-02      | SQL 权限             | 所有公共 Query 统一执行 `read/edit/full` 与物理只读约束                            | 通过           | 单元与真实 PostgreSQL                      |
| DATA-01     | Portable DB 值       | bigint/Date/bytes 在 SDK/REST/Tool/Result 链路保真                                 | 通过           | 合同、SDK、Server、安装包                  |
| DATA-02     | 业务列保真           | `password`/`token` 等业务列名不再触发配置 Secret 脱敏                              | 通过           | AI SQL 结果回归                            |
| DATA-03     | Result 内存          | 单项、条目数、TTL 和进程总预算均有限制                                             | 通过           | 压力与全量测试                             |
| AGENT-01    | 完成语义             | max-iterations/取消不会产生虚假 `verified=true`                                    | 通过           | core-agent                                 |
| AGENT-02    | Checkpoint/Usage     | 成功、失败、取消的终态/Checkpoint/Usage 一致                                       | 通过           | core-agent                                 |
| AGENT-03    | 子 Agent 持久化      | 父子关系、状态和结果进入 SQLite 并可恢复                                           | 通过           | 重启恢复测试                               |
| AGENT-04    | 取消/等待            | 父 Abort 传播，停止和关闭等待实际执行收口                                          | 通过           | core-agent + SDK                           |
| DB-01       | 异步审计             | submit/running/terminal 按真实 Job 状态记录且终态幂等                              | 通过           | 真实 PostgreSQL                            |
| SDK-01      | 数据库双路径         | 注入 Runtime/兼容 Driver 与 Agent 快捷路径收敛到统一边界                           | 通过           | SDK/Server/DB                              |
| SDK-02      | 外部 DDL             | 默认 PostgreSQL 路径比较稳定 revision 并去重刷新                                   | 通过           | 真实 PostgreSQL                            |
| SDK-03      | 索引配置             | 自动刷新保留最后成功的 `maxTables`                                                 | 通过           | SDK/RAG                                    |
| SDK-04      | freshness 并发取消   | 共享刷新不继承首请求信号，每个等待者可独立取消                                     | 通过           | SDK 并发测试                               |
| SDK-05      | Runtime 关闭         | 新任务被拒绝；Agent、子 Agent、Chat、Stream、Batch 均取消并等待                    | 通过           | SDK/Server                                 |
| RAG-01      | Snapshot 生命周期    | 快照接入 SDK，并按租户/Project 隔离                                                | 通过           | 重启、损坏回退、跨 Scope                   |
| RAG-02      | 索引原子性/向量      | 构建与增量失败回滚；增量重建并持久化向量                                           | 通过           | core-rag                                   |
| HTTP-01     | 断连取消             | JSON/Stream 请求生命周期与 Abort 绑定                                              | 通过           | Server                                     |
| HTTP-02     | 优雅关闭             | Server 先 Abort 活跃工作再等待 HTTP/Runtime                                        | 通过           | 原始/包装 close 回归                       |
| HTTP-03     | SSE 背压             | 慢客户端等待 drain，断连退出                                                       | 通过           | Server                                     |
| LLM-01      | 流/响应内存          | SSE frame、文本、Tool 参数和响应体均有字节上限                                     | 通过           | core-llm                                   |
| LLM-02      | Response Cache       | Provider/tenant 隔离、主备顺序、深克隆和字节预算完整                               | 通过           | core-llm                                   |
| LLM-03      | 异步 Job             | tenant + Runtime owner 隔离；输入/结果深快照；数量和字节预算终态可回收             | 通过           | async-jobs、Gateway、SDK                   |
| LLM-04      | 自定义 Header Secret | 默认 Header 认证值进入递归脱敏集合                                                 | 通过           | Provider 安全测试                          |
| MCP-01      | 配置损坏             | JSON 损坏与不存在分离，后续写入 fail closed                                        | 通过           | MCP                                        |
| MCP-02      | transport            | 未知 transport 明确拒绝，不回退 stdio                                              | 通过           | MCP                                        |
| RES-01      | Scope view           | by-id/state/Observation/Event 均使用 Scope 绑定 API                                | 通过           | Resource/REST                              |
| WS-01       | Shell 取消           | 取消/超时终止完整进程树，预取消不启动                                              | 通过           | Windows 真实进程树                         |
| WS-02       | 路径竞态             | 规范根路径/真实路径/Resource 门面已加固；同 OS 用户 TOCTOU 由宿主隔离              | 缓解并接受残余 | 低权限 OS 身份或 Sandbox                   |
| CONTRACT-01 | Query params         | `QueryRequest.params` 统一为 `DbColumnValue[]`                                     | 通过           | 类型与 REST Portable                       |
| TLS-01      | PostgreSQL TLS       | 支持 disable/require/verify-ca/verify-full，拒绝语义不完整的 prefer                | 通过           | core-db TLS                                |
| PKG-01..08  | 发行归档             | 最终包、Hash、来源绑定、状态隔离、Secret/旧标识、导出与真实数据库均通过            | 通过           | [04-release-gates.md](04-release-gates.md) |
| CI-01       | Workflow 权限        | `contents: read`，checkout 不持久化凭据                                            | 静态通过       | release gate                               |
| CI-02       | 双平台 CI            | Ubuntu/PostgreSQL/Windows Job 已接线                                               | 待外部运行     | GitHub Actions URL                         |
| DEP-01      | CVE                  | 未授权发送依赖图，不能声明无已知 CVE                                               | 待外部证据     | 受信 CI 或明确授权                         |
| DEP-02      | 在线依赖解析         | 兼容范围已通过 fresh 隔离安装                                                      | 当前候选通过   | 每次发布重复验证                           |
| SUPPLY-01   | Action 固定          | 所有第三方 Action 固定到审计过的 Node 24 兼容 40 位提交 SHA                        | 通过           | Workflow + release gate                    |
| LIVE-01     | 真实 LLM             | 明确 opt-in 的付费门禁，未获 Token 消耗授权                                        | 待外部证据     | 获授权后执行                               |

## 本次最终门禁证据

- 全量构建、TypeScript、ESLint、`git diff --check`：通过。
- 确定性测试：93 个文件、653 项通过；24 项外部依赖用例在通用运行中跳过。
- 真实 PostgreSQL：Driver 7/7、Connector 5/5、SDK 6 通过/1 个真实 LLM 跳过、复杂场景 4 通过/1 个真实 LLM 跳过。
- 六组性能基准：最终隔离运行全部通过。Resource Snapshot 恢复的一次同批运行值为 5.239 秒，隔离复跑为 4.640 秒并低于 5 秒阈值；该抖动保留为后续 CI 观察项。
- Release/provenance gate：9/9 通过。
- 最终 npm 包：来源绑定、隔离安装、SDK、Session、Server、REST、CLI、类型及真实 PostgreSQL 全部通过。
- 来源清单：186 个源码/配置输入、250 个构建输出、281 个归档 payload 文件；工作树状态明确记录为 `not-asserted`，不声称 clean。
- 归档 SHA-256：`f138d57ef54d77b32bc7497fe07d4e799c80b58675cbec2e98276276151023fa`。

任何后续源码、文档或依赖变更都会使本矩阵中的候选物证据失效，必须重新运行对应门禁并重新生成归档。
