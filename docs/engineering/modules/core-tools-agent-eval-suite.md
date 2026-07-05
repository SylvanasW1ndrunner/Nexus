# core-tools Agent/RAG Eval Suite Runner

## 目标

上一阶段 `core-agent` 已经具备工具参数、工具结果和最终回答的结构化评估能力。本模块把它提升为可运行的后端套件能力：

- 批量运行 Agent 业务用例。
- 对每个真实 run 执行行为评估。
- 生成脱敏验收报告。
- 可选写入本地报告索引。
- 作为后续官方 “Agent/RAG Eval” 插件的后端底座。

该能力不依赖最终前端 UI，也不启动网络市场。

## 代码入口

- `packages/core-tools/src/agent-eval-suite-runner.ts`
  - `runAgentBehaviorEvaluationSuite(options)`
  - `AgentEvalSuite`
  - `AgentEvalSuiteCase`
  - `AgentEvalSuiteRunResult`
- `packages/core-tools/src/agent-eval-suite-manifest.ts`
  - `parseAgentEvalSuiteManifest(input)`
  - `parseAgentEvalSuiteManifestJson(json)`
  - `AgentEvalSuiteManifest`
- `packages/core-tools/src/agent-eval-suite-workspace-loader.ts`
  - `loadWorkspaceAgentEvalSuiteManifests(options)`
  - `WorkspaceAgentEvalSuiteSource`
- `packages/core-tools/src/agent-eval-suite-catalog.ts`
  - `loadAgentEvalSuiteCatalog(options)`
  - `AgentEvalSuiteCatalogEntry`
- `packages/core-tools/src/agent-eval-suite-catalog-service.ts`
  - `AgentEvalSuiteCatalogService`
  - `list(options)`
  - `get(options)`
- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增默认关闭的 `official.agent-rag-eval` manifest。
  - 声明内置 `official.agent-rag.business-readonly` eval suite manifest。
  - `resolveEvalSuites(options)` 按已启用官方插件解析可运行 suite。
- `packages/core-tools/test/agent-eval-suite-runner.test.ts`
  - 套件运行、报告落盘、失败提前停止、空套件错误。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 默认 scripted provider 业务夹具验收和 SiliconFlow live Agent/RAG 验收均通过 runner 执行。
  - live 验收通过 `loadAgentEvalSuiteCatalog()` 读取 suite，默认使用官方 `official.agent-rag.business-readonly`。
  - live 入口继续输出 `manifest.json`、`results.json`、`report.md` 和 `reports.json`。

## 运行合同

`runAgentBehaviorEvaluationSuite()` 接收：

- `agent`：提供 `run(options)` 的 Agent 实例或 adapter。
- `suite`：业务用例集合，每个 case 使用 `AgentBehaviorEvaluationCase` 描述验收规则。
- `baseRun`：公共 Agent 运行参数，例如 provider、model、mode、迭代数。
- `suiteSource`：可选来源信息，支持 official plugin、workspace manifest 或 manual，用于报告追踪。
- `reportStorePath`：可选报告索引路径。
- `stopOnFirstFailure`：可选，失败后立即停止，适合 release gate。

每个 suite case 可以通过 `run` 覆盖部分运行参数，例如更高的超时、更小的迭代上限或不同模式。最终 `userMessage` 固定来自 `case.userTask`，避免评估定义和真实任务输入脱节。

`AgentBehaviorToolExpectation` 支持 `caseSensitive: false`。该选项只影响单个工具期望里的 `argumentIncludes`、`argumentExcludes`、`resultIncludes` 和 `resultExcludes`。默认仍保持大小写敏感；live LLM 场景可以对 SQL 关键字、枚举值等开启大小写不敏感匹配，避免 `SELECT`/`select` 这类无业务差异导致真实验收误失败。

## Suite Manifest

`AgentEvalSuiteManifest` 是后续官方插件和工作区自定义验收的稳定入口，当前版本为 `version: 1`：

```json
{
  "version": 1,
  "suite": {
    "suiteId": "agent-rag-workspace-eval",
    "suiteName": "Agent/RAG 工作区验收",
    "environment": "postgres",
    "notes": ["从工作区 manifest 加载，不包含 provider、model 或 secret。"],
    "cases": [
      {
        "id": "WORKSPACE-EVAL-001",
        "userTask": "按渠道统计 GMV 和 ROI。",
        "expectedStatus": "done",
        "requiredToolCalls": ["search_schema", "query_database"],
        "toolExpectations": [
          {
            "toolName": "query_database",
            "status": "success",
            "caseSensitive": false,
            "argumentIncludes": ["select"],
            "resultIncludes": ["paid_search"]
          }
        ],
        "run": {
          "allowedTools": ["search_schema", "query_database"],
          "mode": "readonly",
          "maxIterations": 5
        }
      }
    ]
  }
}
```

安全边界：

- manifest 只能描述 suite、case 和安全的 case-level run override。
- manifest 不允许覆盖 `providerId`、`model`、`userMessage` 或 `signal`；这些由调用方、发布门禁或后续主进程服务控制。
- manifest 不承载 API key、数据库密码或连接串。
- parser 不读写文件、不依赖 Electron、不引入新依赖；文件发现和权限控制留给官方插件/工作区服务层。

## 工作区 Suite 加载

`loadWorkspaceAgentEvalSuiteManifests()` 提供工作区文件入口，默认扫描：

```text
.dbagent/evals/*.json
```

加载规则：

- 只接受工作区相对路径，复用 `resolveWorkspacePath()` 防止路径逃逸。
- 默认单个 manifest 最大 256KB，可由调用方配置。
- 只读取当前目录下 `.json` 文件，按文件名排序，忽略其他扩展名。
- 缺失 `.dbagent/evals` 目录时返回空列表。
- 返回 `relativePath`、raw `manifest` 和已解析的 `suite`。
- 拒绝重复 `suiteId`，错误信息包含冲突文件路径。

安全边界：

- loader 只读工作区文件，不运行 Agent、不调用 LLM、不连接数据库、不写报告。
- loader 不解析 API key、数据库密码或连接串；这些字段不属于 suite manifest 合同。
- 工作区是否启用 eval、是否允许运行真实 LLM/PG，仍由调用方或后续服务层控制。

## Eval Suite Catalog

`loadAgentEvalSuiteCatalog()` 是后续服务层读取验收 suite 的统一入口。它把官方插件 suite 和工作区 suite 合并为带来源信息的 catalog，但仍不执行 suite。

来源类型：

- `official`：来自官方插件 registry，记录 `pluginId`。
- `workspace`：来自工作区 `.dbagent/evals/*.json`，记录 `relativePath`。

加载规则：

- 默认只解析已启用官方插件；`official.agent-rag-eval` 仍然默认关闭，必须显式启用。
- 只有调用方传入 `workspace` 配置时才读取工作区文件。
- catalog entry 包含 `suiteId`、`suiteName`、`environment`、`source`、raw `manifest` 和 parsed `suite`。
- 合并后拒绝重复 `suiteId`，错误信息包含冲突来源。
- 返回值会 clone manifest 和 suite，调用方修改 catalog 不会污染后续加载。

安全边界：

- catalog 只做发现、解析、合并和去重。
- catalog 不调用 Agent、不调用 LLM、不连接 PostgreSQL、不写报告。
- 后续运行门禁、provider、数据库 fixture、报告目录和权限提示必须由服务层显式控制。

## Eval Suite Catalog Service

`AgentEvalSuiteCatalogService` 是 catalog 之上的查询服务层，用于后续主进程、typed IPC、插件市场和 release gate 查询可用评测套件。它不会执行 suite，只返回安全摘要或调用方显式请求的明细。

查询能力：

- `list(options)`：按 `suiteIds`、`sourceKinds`、`environments` 过滤 suite，并返回可用于列表页、配置页或发布门禁的摘要。
- `get(options)`：按单个 `suiteId` 查询 suite，未找到时返回 `undefined`。
- `includeManifest` / `includeSuite`：默认不返回完整 manifest 和 suite；只有调用方明确请求时才返回深拷贝明细。

摘要字段：

- `suiteId`、`suiteName`、`environment`、`source`、`sourceLabel`。
- `caseCount`、`caseIds`、`notes`。
- `declaredToolNames`、`requiredToolNames`、`allowedToolNames`、`runModes`、`readonlyOnly`。

服务边界：

- service 只组合 `loadAgentEvalSuiteCatalog()` 的结果，不调用 Agent、不调用 LLM、不连接 PostgreSQL、不写报告。
- service 不保存 provider、model、API key、数据库密码或连接串。
- service 返回值会 clone 关键对象，调用方修改结果不会污染后续查询。
- 未来 UI/IPC 只能通过该 service 查询 suite 元数据，真正运行 suite 仍需进入显式 release/test gate。

## 官方插件边界

`official.agent-rag-eval` 当前默认关闭，且不贡献 Agent tool。原因：

- Eval runner 是发布/验收能力，不应默认暴露给模型调用。
- 它可能触发真实 LLM、真实 PostgreSQL 或写报告文件，执行入口应由测试脚本、主进程服务或后续设置页显式触发。
- 真正进入插件市场后，插件可以声明 suite、报告目录、真实依赖门控和权限说明；core-tools 只保留稳定 runner 合同。

Manifest 信息：

- `category: eval`
- `capabilities: agent-eval-suite, tool-evidence-report, release-quality-gate`
- `permission: eval.report.write`
- `resourceScopes: agent.session, eval.report`
- `enabledByDefault: false`
- `evalSuites: official.agent-rag.business-readonly`

默认 suite 边界：

- 只读模式，默认允许 `search_schema` 和 `query_database`。
- 不包含 provider、model、API key、数据库密码或连接串。
- 仍不贡献 Agent tool；它是发布/验收能力，由测试脚本、服务层或后续设置页显式触发。
- registry 注册时会调用 `parseAgentEvalSuiteManifest()` 校验 suite manifest，避免官方插件声明和 runner 合同漂移。
- `resolveEvalSuites()` 默认不会返回 `official.agent-rag-eval`，调用方必须显式传入 `enabledPluginIds: ['official.agent-rag-eval']`；这是为了避免默认关闭的验收能力被隐式执行真实 LLM、真实 PostgreSQL 或写报告文件。

## 开源方案评估

可借鉴对象：

- OpenAI Evals：适合模型行为批量评测，但 runner 与 DBAgent 工具权限、脱敏报告、工作区路径和发布门禁不直接匹配。
- promptfoo：适合 prompt/provider 回归测试，但仍需 adapter 才能表达 DBAgent 的工具参数、工具结果和权限证据。
- LangSmith/LangChain eval：适合 tracing 和云端可视化，但当前 core 包不能依赖外部云服务，也不能把 tracing 类型暴露为稳定合同。
- JSON Schema / Zod：适合通用 manifest 校验，但本切片字段较小且不新增依赖可以降低打包和离线风险；后续 manifest 扩展到复杂插件市场字段时再评估引入 schema validator。

本切片选择自建轻量 runner，原因：

- 无新增依赖，降低打包和离线风险。
- 直接复用 `core-agent` 的脱敏报告合同。
- 可在默认测试、PostgreSQL 门控和 SiliconFlow live 门控中统一使用。

后续如果接入第三方 eval 框架，应放在官方插件 adapter 层，不进入 `packages/shared` 或核心 Agent 合同。

## 测试覆盖

- 成功套件：
  - Agent 被真实调用。
  - case-level run override 生效。
  - 工具参数、工具结果和最终回答被评估。
  - 报告写入本地 store。
  - 明文 API key 不进入报告。
- 默认业务夹具套件：
  - 使用 scripted provider、fake PostgreSQL driver 和真实 `ReactAgent` 调用路径。
  - 验证 `search_schema`、`query_database`、最终回答、实际 SQL 执行记录和临时 report store。
- PostgreSQL 套件：
  - `pnpm test:postgres` 会创建真实 PostgreSQL 业务表、抽取 catalog、索引 RAG，并通过 `runAgentBehaviorEvaluationSuite()` 执行 Agent 工具链。
  - 报告 run metadata 标记 `postgres: true`，并验证临时 report store 摘要。
- live 套件：
  - `scripts/run-agent-rag-live-tests.mjs` 设置 `DBAGENT_RUN_AGENT_RAG_LIVE=1` 后，真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` case 会通过 `runAgentBehaviorEvaluationSuite()` 执行。
  - live case 默认从 catalog 加载 `official.agent-rag.business-readonly`；可通过 `DBAGENT_AGENT_RAG_SUITE_ID` 选择 suite，通过 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE` 加载工作区 `.dbagent/evals/*.json`。
  - live 报告目录仍兼容旧入口：`tmp/agent-rag-live-report` 下写入 `manifest.json`、`results.json`、`report.md`、`reports.json` 和 `run.json`。
  - `manifest.json`、`results.json` 和 `report.md` 记录 `suiteSource`，用于区分官方 suite 与工作区 suite。
  - live SQL 参数断言对 SQL 关键字使用 `caseSensitive: false`，仍要求 `query_database` 成功执行并返回 `paid_search` 等业务结果。
- 失败套件：
  - `stopOnFirstFailure` 只运行第一个失败用例。
- 输入错误：
  - 空 suite 在调用 Agent 前失败。
- manifest parser：
  - 解析 JSON 文本和对象输入。
  - 拒绝重复 case id、空 suite、非法状态、非法迭代范围、非法工具调用次数范围。
  - 拒绝 manifest 覆盖 provider、model、userMessage 和 signal。
- 工作区 loader：
  - 从真实临时工作区读取 `.dbagent/evals/*.json`。
  - 覆盖缺失目录、路径逃逸、目录指向文件、非法 JSON、非法 manifest、重复 suite id、超大文件。
- catalog：
  - 合并显式启用的官方 suite 和真实临时工作区 suite。
  - 覆盖默认禁用官方 eval、仅工作区加载、跨来源重复 suite id、clone 防污染。
- 官方插件：
  - `official.agent-rag-eval` 携带默认 suite manifest。
  - registry 拒绝非 eval 插件声明 eval suite。
  - registry 只从启用插件解析 eval suite，支持按 `suiteIds` 过滤。
  - registry 拒绝解析阶段出现重复 suite id。
  - registry 返回 clone，调用方无法污染默认 suite manifest。

## 已知边界

- 当前 runner 串行执行 case，后续可增加并发，但要先处理 provider rate limit 和数据库 fixture 隔离。
- 当前只提供 suite manifest 解析，不负责扫描工作区文件或官方插件目录；这些应在服务层做路径、权限和来源控制后再调用 parser。
- 当前不内置 LLM judge；自然语言充分性仍依赖 case 中的确定性断言或后续人工/模型评审。
