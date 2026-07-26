# SchemaNaut 发布前安全与可靠性审计（最终）

审计日期：2026-07-26
范围：Secret、Provider/Gateway、HTTP/SSE、数据库权限、Workspace/Shell、MCP、内存预算、取消/关闭、租户/Project/Session 隔离
主状态索引：[00-traceability-matrix.md](00-traceability-matrix.md)

## 结论

本次代码审计发现的 P0/P1/P2 实现缺口均已修复并通过对应回归与最终门禁。当前没有已知的、仍未修复的本地高优先级代码问题。

安全结论限定于 SchemaNaut 自身的应用边界。SchemaNaut 不是账号系统、Secret Vault、数据库权限系统、网络 Sandbox 或 OS Sandbox；共享/对抗部署必须由宿主补齐这些边界。

## 已关闭问题

| ID        | 风险                                                | 最终控制                                                     |
| --------- | --------------------------------------------------- | ------------------------------------------------------------ |
| SEC-01    | Provider/SSE 错误回显 API Key                       | 已知 Secret、嵌套 Detail 和自定义认证 Header 递归脱敏        |
| LLM-01    | SSE frame、文本、Tool 参数和响应体无界              | 分层字节上限，超限取消 Reader/body                           |
| LLM-02    | Cache 浅拷贝、跨 Provider/tenant 污染或主备顺序错误 | 深克隆、完整隔离键、按候选顺序命中                           |
| LLM-03    | Cache/异步 Job 只有条目数限制                       | 单项、单 Job、全局字节预算与 LRU/回收                        |
| LLM-04    | 异步 Job 可跨租户/Runtime 读取或取消且历史索引无界  | tenant + owner 复合隔离、输入深快照、终态驱逐、无永久 ID Set |
| HTTP-01   | 客户端断开后端继续运行                              | request/response/shutdown 与 AbortSignal 绑定                |
| HTTP-02   | Server/Runtime 关闭等待成环                         | 原始与包装 `close()` 均先 Abort 和断连接，再等待收口         |
| HTTP-03   | SSE 忽略背压                                        | 等待 drain，断连退出                                         |
| DATA-03   | Result Store 保留过量内存                           | 大小、数量、TTL、进程总预算和安全裁剪                        |
| MCP-01    | 损坏 JSON 被当作不存在后覆盖                        | 解析失败 fail closed                                         |
| MCP-02    | 未知 transport 回退 stdio                           | Schema 和归一化层明确拒绝                                    |
| WS-01     | Shell 取消只杀直接子进程                            | Windows/Unix 终止完整进程树                                  |
| RES-01    | Resource/Observation/Event 跨 Scope                 | Scope 绑定视图与同 ID 冲突拒绝                               |
| SDK-05    | Runtime 关闭遗漏模型/子 Agent 工作                  | 拒绝新任务并取消、等待 Agent、子 Agent、Chat、Stream、Batch  |
| RAG-01/02 | 假 `ready`、向量丢失、Snapshot 失败不回滚           | Checkpoint/rollback、异步向量重建、成功后持久化              |
| TLS-01    | TLS 模式与 PostgreSQL 语义不一致                    | 明确映射 require/verify-ca/verify-full，拒绝 prefer          |

## 已确认的宿主责任

- **身份与 API 访问控制**：SchemaNaut 不提供注册/登录。共享服务必须由宿主认证授权，并把 `tenantId`/`userId` 绑定到可信身份。
- **数据库权限**：Agent mode 不能替代 PostgreSQL 最小权限账号、对象权限或 RLS。
- **Web/SSRF**：宿主 `webAdapter` 必须实现允许列表、凭据、限流和 SSRF 策略。
- **Shell**：默认关闭；启用后继承宿主进程权限，不构成 OS Sandbox。
- **stdio MCP**：REST 进程管理默认关闭；`allowProcessMcpManagement: true` 只适用于可信本机宿主。
- **Secret 持久化**：产品保存引用而不是持久 Vault；解析、轮换与销毁由宿主负责。
- **Schema Snapshot**：包含明文 Schema 名称、注释、Glossary 和向量；目录权限、备份、保留与安全删除由宿主负责。

## 残余风险

1. Workspace 已阻止常规路径穿越和符号链接逃逸，但同一 OS 用户可并发替换路径组件时仍存在跨平台 TOCTOU 边界。高对抗环境应使用独立低权限身份、容器或文件系统 Sandbox。
2. 远程 MCP 对端可能忽略取消；SchemaNaut 只能保证本地超时、断连和资源释放。
3. Secret/旧标识扫描是防误提交门禁，不等价于恶意代码审计或完整供应链证明。
4. 本地许可证元数据扫描不是法律意见。
5. Gateway 的 Job 数量与总保留字节是进程级共享容量；高负载租户可能提前驱逐其他租户的已完成结果，但不能跨 owner 读取或取消。需要强租户 QoS 时应由宿主拆分 Gateway/进程或增加配额层。
6. v0.1 Connector/Driver 与 SDK/Server 同进程；第三方 JDBC、原生依赖和不受信 Connector 的崩溃/OOM 隔离由宿主部署负责。

## 最终证据

- 93 个测试文件、653 项确定性测试通过。
- Windows 完整进程树取消/超时用例通过。
- 真实 PostgreSQL 的授权、只读、失败、取消和异步审计场景通过。
- 最终归档来源绑定、Secret/旧标识扫描、隔离状态安装与运行验证通过。
- LLM、Database、Resource、Public Contract、AI SQL、Context Compaction 六类性能报告全部通过。

## 未产生的外部证据

- 依赖 CVE 查询：未获向漏洞服务发送依赖图的授权，不能声称无已知 CVE。
- GitHub 托管 Ubuntu/Windows CI：Workflow 已静态验证并固定 Action SHA，但实际运行仍需远端 CI。
- 真实 LLM：会消耗外部 Token，未获明确授权。
