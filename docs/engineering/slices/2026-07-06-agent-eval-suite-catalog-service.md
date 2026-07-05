# Agent Eval Suite Catalog Service 切片

## 背景

当前开发路径是功能优先、前端最后统一重建。Agent/RAG 真实验收已经具备 runner、manifest、工作区 loader、官方插件 registry 和 catalog，但后续主进程、typed IPC、插件市场、发布门禁仍需要一个更稳定的查询服务入口。

本切片补齐 `core-tools` 内的 eval suite catalog service，让调用方可以安全列出、筛选和查看评测套件元数据，而不直接触碰执行逻辑。

## 实现范围

- 新增 `packages/core-tools/src/agent-eval-suite-catalog-service.ts`。
- 导出 `AgentEvalSuiteCatalogService`。
- 支持：
  - `list(options)`：列出官方/工作区 eval suite 摘要。
  - `get(options)`：按 `suiteId` 获取单个 suite。
  - `suiteIds`、`sourceKinds`、`environments` 过滤。
  - `includeManifest`、`includeSuite` 按需返回深拷贝明细。
- 更新 `packages/core-tools/src/index.ts` 统一导出。

## 明确不做

- 不执行 Agent。
- 不调用 LLM。
- 不连接 PostgreSQL。
- 不写评估报告。
- 不进入 Electron、preload、renderer 或最终 UI。
- 不保存 provider、model、API key、数据库密码或连接串。

## 设计边界

`loadAgentEvalSuiteCatalog()` 仍负责加载和合并 suite；`AgentEvalSuiteCatalogService` 只负责服务级查询 DTO、过滤和安全摘要。这样可以避免 runner、loader、IPC、插件市场之间相互耦合。

摘要字段包含：

- suite 基本信息：`suiteId`、`suiteName`、`environment`。
- 来源信息：`source`、`sourceLabel`。
- 验收规模：`caseCount`、`caseIds`、`notes`。
- 工具约束：`declaredToolNames`、`requiredToolNames`、`allowedToolNames`、`runModes`、`readonlyOnly`。

## 开源方案评估

本切片没有新增第三方依赖。原因：

- 功能是 DBAgent 内部 catalog 查询 DTO 和过滤，不是通用 eval runtime。
- 已有 runner 继续参考 OpenAI Evals、promptfoo、LangSmith/LangChain eval 的思路，但当前 service 不需要引入它们的执行框架。
- 不新增依赖可以降低 Electron 打包、离线安装和 Windows/Linux 兼容风险。
- 如果后续要接入第三方 eval 框架，应放在官方插件 adapter 层，而不是污染 `core-tools` 的稳定查询合同。

## 测试

新增 `packages/core-tools/test/agent-eval-suite-catalog-service.test.ts`，覆盖：

- 显式启用官方 eval suite，并从真实临时工作区读取 `.dbagent/evals/*.json`。
- 默认只返回安全摘要，不返回完整 manifest 或 suite。
- 按 suite id、来源类型、environment 过滤。
- 按需返回明细。
- 返回值深拷贝，调用方修改不会污染后续查询。
- suite 不存在时 `get()` 返回 `undefined`。

## 后续

- 主进程服务和 typed IPC 可以基于该 service 暴露只读查询入口。
- release gate 可以基于该 service 列出可运行 suite 后，再显式进入真实 LLM/PostgreSQL 验收。
- 插件市场后续可以把官方 eval suite 或工作区 suite 显示为可启用能力，但执行仍必须走权限门禁。
