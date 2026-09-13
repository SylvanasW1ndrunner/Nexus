# SchemaNaut 发行、依赖与包边界审计（最终门禁）

> **历史 2026-07 审计（已退役）：** 本报告针对已退役的 SDK/Server 架构，不能作为当前发布边界；请参阅[当前验证记录](../../docs/engineering/verification.md)。

审计日期：2026-07-26
范围：npm 包、公开导出、Secret/旧标识扫描、Checksum、版本一致性、隔离安装、真实 PostgreSQL、CI 与供应链
主状态索引：[00-traceability-matrix.md](00-traceability-matrix.md)

## 结论

本地发行候选门禁已通过。最终归档来自本次审计后的源码状态，并完成了隔离安装、SDK、Session、Server 子路径、REST、CLI、类型声明和真实 PostgreSQL 验收。

- 归档：`release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz`
- SHA-256：`f138d57ef54d77b32bc7497fe07d4e799c80b58675cbec2e98276276151023fa`
- 归档大小：442,830 bytes
- Checksum 文件：`release/SchemaNaut-v0.1.0/SHA256SUMS.txt`
- Provenance 文件：`release/SchemaNaut-v0.1.0/PROVENANCE.json`
- Release/provenance gate：9/9 通过
- 隔离安装：通过
- 安装包真实 PostgreSQL：连接、`SELECT`、物理只读阻断、取消与关闭均通过

这表示本地候选物可以进入发布流程；它不等于 GitHub 托管 CI、依赖漏洞服务或真实付费 LLM 已经产生外部证据。

## 门禁结果

| ID        | 门禁                                             | 最终结果                                         |
| --------- | ------------------------------------------------ | ------------------------------------------------ |
| PKG-01    | 最终 `.tgz` 与源码状态对应                       | 通过                                             |
| PKG-02    | 归档文件名与 SHA-256 强校验                      | 通过                                             |
| PKG-03    | Secret、旧 wire 标识与内部路径扫描               | 通过                                             |
| PKG-04    | root/server/docs/CHANGELOG 版本一致性            | 通过                                             |
| PKG-05    | 隔离安装包真实 PostgreSQL                        | 通过                                             |
| PKG-06    | `@nwlworkshop/schemanaut/server` 导出与启动/关闭 | 通过                                             |
| PKG-07    | `$dbagentType`、旧 `dbagent.*` 公开标识拒绝      | 通过                                             |
| PKG-08    | Server/SDK/CLI 状态目录不读写宿主默认位置        | 通过                                             |
| CI-01     | 最小 `contents: read` 与 checkout 凭据不持久化   | 静态门禁通过                                     |
| CI-02     | Ubuntu/PostgreSQL/Windows 关键 Job               | Workflow 已接线；托管运行待外部证据              |
| SUPPLY-01 | 第三方 Action 固定不可变提交                     | 通过；所有 `uses:` 已固定到 Node 24 兼容审计 SHA |

## 公开包合同

已验证最终归档满足：

- 包名 `@nwlworkshop/schemanaut`，ESM，Node.js `>=22.13.0`；
- 主入口导出 SDK，`./server` 子路径导出 Server；
- `schemanaut` CLI 可执行；
- 双语 README、SDK Guide/API Reference、许可证和第三方通知存在且链接有效；
- `dist/**/*.js|d.ts` 不含 `@dbagent/` workspace-only import；
- 公开代码、类型、JSON 和文档不含旧 wire 契约；
- 归档不含 `reports`、`scripts`、`.github`、`.env` 或内部计划目录；
- Checksum 只描述本次预期归档且与归档内容一致。

## 来源绑定与状态隔离

`PROVENANCE.json` 使用逐文件 SHA-256 清单绑定当前归档：

- 186 个源码、配置、文档和 Skill 输入；
- 250 个实际编译输出；
- 281 个解包后的归档 payload 文件；
- `.tgz` 文件名、大小和 SHA-256。

打包脚本在打包前后复核输入，并在归档后重新解包记录真实 payload。验证器会在联网安装前比较当前输入、编译输出、payload 和归档；现场修改一处 `core-llm` 源码后，旧包已被门禁立即拒绝。

当前工作树包含本次审计改动，因此 provenance 明确写入 `workingTreeState: not-asserted`，不虚假声称 clean 或绑定未生成的提交。最终发布仍应在提交后保存 commit/CI 关联。

安装验证的 SDK、PostgreSQL 与 Server Runtime 均显式使用临时验证根目录中的 Project、用户 Skills 和 Session DB；CLI 的 HOME、USERPROFILE、LOCALAPPDATA、XDG 数据目录和状态库也指向该临时根目录。验证结束后统一清理。

## 依赖与供应链

锁文件中的直接运行时版本为：

- `@modelcontextprotocol/sdk@1.29.0`
- `ajv@8.20.0`
- `node-sql-parser@5.4.0`
- `pg@8.21.0`
- `yaml@2.9.0`

公开包保留兼容范围；本次已用 2026-07-26 当时 registry 可解析版本完成 fresh 隔离安装并通过完整功能验证。未来解析结果仍可能变化，因此每个发布候选都必须重复隔离安装门禁。

本地许可证元数据扫描覆盖 259 个有名称的 `package.json`，未发现缺失许可证字段或无效 JSON；这不是法律意见。

## 尚缺的外部证据

1. `npm audit`/等价漏洞公告查询未执行。该操作会向服务端发送依赖图，当前没有得到该数据外发授权，不能宣称“无已知 CVE”。
2. GitHub Actions Workflow 已静态复核并固定第三方 Action SHA，但本地环境不能替代 GitHub 托管 Ubuntu/Windows 的实际运行结果。
3. 真实 LLM 会消耗外部 Token，未获明确付费授权，因此没有执行；本地确定性 Provider 测试不能冒充真实模型验证。

正式发布记录应保存归档、Checksum、测试日志、PostgreSQL evidence、CI URL、依赖公告结果和构建提交 SHA。
