# 第一版发布与产品表达收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可验证的优势表达、准确架构图、公开评测合同和可复现 npm 候选完成第一版产品收口。

**Architecture:** 用户 README 只表达产品价值、使用入口和真实边界；深入操作进入 guides，内部实现与发布证据进入 engineering。代码只修复文档定界后暴露的 npm Runtime workspace 缺口，并沿用既有打包、校验和、provenance 与隔离安装管线。

**Tech Stack:** Markdown、Mermaid、Node.js 22、TypeScript、pnpm、Node test runner、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-11-release-product-closure-design.md`

## Global Constraints

- 先完成全部文档修改，再修改发布代码。
- README 的核心是可由当前代码与测试证明的优势，不写未经测量的竞品优胜结论。
- Capability 是按任务激活的专业工具插件，不拥有产品内配置层。
- 当前准确数字为 14 个基础 Tool 和 8 类第一方 Capability。
- `config.toml` 只存在于全局路径；项目 settings 只保存 MCP 声明。
- 权限只有 `default`、`auto`、`full-access` 和全局企业规则。
- 按用户要求不采用测试驱动：先依据现有合同修改，全部修改完成后统一测试。
- 不添加兼容层，不提交、不推送、不远程发布。
- 最终名称未确认前保持 `@nwlworkshop/schemanaut@0.1.0-alpha.2`、CLI `schemanaut` 和 npm `next` tag。
- 当前共享工作区包含用户尚未提交的大量改动；只触碰本计划列出的文件，不清理或覆盖无关改动。

---

### Task 1: 重写用户文档并建立 Benchmark 合同

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/product/overview.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/guides/capabilities.md`
- Modify: `docs/guides/capabilities.zh-CN.md`
- Modify: `apps/terminal/README.md`
- Modify: `docs/engineering/README.md`
- Create: `docs/benchmarks/README.md`

**Interfaces:**
- Consumes: `BASE_TOOL_MANIFEST` 的 14 项顺序、bundled Host 的 8 类 Capability、结果生命周期和全局配置合同。
- Produces: 用户定位、三张 Mermaid 架构图、快速开始、文档职责边界和后续横向评测的公共合同。

- [x] **Step 1: 重写中英文根 README**

按设计文档第 5 节顺序重写。三张图使用设计文档第 4 节拓扑；图后分别解释上下文/试错成本、外部环境复用、
完整数据本地处理和统一执行边界。中英文内容保持语义一致，示例使用：

```toml
version = 1

[agent]
permission_mode = "default"

[[models.connections]]
name = "work"
endpoint = "https://api.siliconflow.cn/v1"
api_key_env = "SILICONFLOW_API_KEY"
```

在配置示例后分别给出 PowerShell 与 bash 的环境变量设置，并说明 `/config validate`、`/models` 和 `/doctor`
各自用于验证什么。Endpoint 旁链接硅基流动官方快速开始文档；不得嵌入真实 Key。

- [x] **Step 2: 同步用户文档边界**

将产品概览中“首批 Capability 正在开发”改为当前已内置事实；更新文档索引和路线图，加入 Benchmark 入口并删除
已经完成事项仍被描述为未来工作的文案。Capability 指南补充 14 个基础 Tool 与渐进加载的关系，但不加入内部
Control Plane 术语。

- [x] **Step 3: 新建公开 Benchmark 合同**

`docs/benchmarks/README.md` 必须分开“同模型消融”和“端到端 Agent 对比”，列出任务集、环境冻结、至少十项指标、
报告字段和禁止性结论。当前状态写为“方法已定义，横向结果尚未发布”。

- [x] **Step 4: 清理维护者文档冲突**

将 `apps/terminal/README.md` 的“本地发布已推迟/历史产物”改为当前本地 npm 候选流程；保留 CLI-only 和无公共 SDK
边界。将新的 spec、plan 和 Benchmark 合同加入 `docs/engineering/README.md`。

- [x] **Step 5: 文档静态核对**

运行：

```powershell
rg -n "正在本轮开发|in development for this round|release work is deferred|historical development artifact" README.md README.zh-CN.md docs/README.md docs/product docs/guides apps/terminal/README.md
rg -n "14 base|14 个基础|8 first-party|8 类第一方|```mermaid|same-model|同模型消融" README.md README.zh-CN.md docs
```

预期：第一条没有失效定位命中；第二条能找到中英文优势、图和评测合同。

### Task 2: 修复 npm Runtime workspace 闭包

**Files:**
- Modify: `scripts/lib/npm-package.mjs`
- Modify: `scripts/lib/public-documents.mjs`
- Modify: `scripts/tests/npm-package-contract.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `packages/agent-host/src/bundled-agent-runtime.ts` 对 `@dbagent/first-party-capabilities` 的运行期导入。
- Produces: 将 `packages/first-party-capabilities` 编译输出复制到 `dist/internal/first-party-capabilities`，并重写内部导入。

- [x] **Step 1: 把第一方 Capability 加入打包闭包**

在 `RUNTIME_WORKSPACES` 中将以下条目放在 database capability 与 agent host 之间：

```js
{
  path: 'packages/first-party-capabilities',
  packageName: '@dbagent/first-party-capabilities',
  target: 'internal/first-party-capabilities',
},
```

- [x] **Step 2: 强化发布合同测试**

合同必须断言 workspace 条目存在、目标目录准确，并要求 npm payload 包含
`dist/internal/first-party-capabilities/index.js`。测试继续验证产物中没有 `@dbagent/*` 残留导入。

**实现阶段测试约束：** 暂不执行测试。

- [x] **Step 3: 将本地候选加入 CI**

新增独立 `npm-package` job，依赖 `verify`，重复 checkout、pnpm 9.15.4、Node 22.13.0 和 frozen install，然后运行
`pnpm release:local`。成功后用固定 SHA 的 `actions/upload-artifact` 上传 `release/SchemaNaut-v*/`，
`if-no-files-found: error`，Artifact 名包含 run id 与 attempt。job 不运行 `npm publish`。

发布文档快照必须引用文档分层后的现行路径。面向贡献者的 Capability 编写指南只存在于
`docs/engineering/capability-authoring.md`，清单不得继续引用已迁移删除的 `docs/guides/capability-authoring.md`；
npm 合同应在启动耗时发布流程前检查每个文档清单项真实存在。

`PUBLIC_DOCUMENT_FILES` 还必须对仓库内相对 Markdown 链接形成完整闭包。合同测试应解析清单中每份文档的
本地 `.md` 链接，忽略 HTTP(S)、`mailto:`、纯 fragment 与非 Markdown 目标，按源文件目录解析并去掉 query/fragment，
随后断言目标规范化路径也存在于清单。该检查需要覆盖根 README 到 Benchmark、Capability、诊断指南、
`CONTRIBUTING.md` 的直接链接，以及新纳入文档继续产生的传递链接，避免 npm 页面或隔离安装后的文档导航断裂。
`copyPublicFiles` 必须直接遍历 `PUBLIC_DOCUMENT_FILES` 复制根目录和 `docs/` 下的 Markdown；LICENSE、NOTICE 与
第三方声明作为不参与文档导航闭包的固定法律/声明文件单独并入同一复制计划。生成公开 manifest 时的根文件入口，
以及 `verifyPackagePaths` 的 tarball 必需文件，也必须从同一计划派生；不得再为 README、SECURITY、CONTRIBUTING
或其他公开文档维护第二份清单。合同应证明 manifest 覆盖所有根公共文件，并证明任何公共文档从 tarball 缺失都会失败。

公开包的 `PUBLIC_RUNTIME_DEPENDENCIES` 必须精确覆盖 `RUNTIME_WORKSPACES` 中每个 workspace `package.json`
的非 `workspace:` 运行时 `dependencies` 并集，名称与版本范围均保持一致。npm 合同应从这些 manifest 动态推导闭包，
避免 Agent Host 等内部 workspace 新增外部库后，源码与全仓测试通过、隔离安装候选却在运行时缺包。本轮已知遗漏
`packages/agent-host` 使用的 `smol-toml@1.8.0`，应加入公开依赖清单。

**统一验证时点：** 遵循全局约束，把本任务的测试留到 Task 3 统一执行；只做代码与 YAML 静态复核，
确认没有更改包名、版本、CLI 或 tag。

### Task 3: 清理统一门禁发现的 Lint 与 Tool Registry 性能错误

**Files:**
- Modify: `packages/core-tools/src/node-workspace-mutation-primitive.ts`
- Modify: `packages/core-tools/src/workspace-mutation-adapter.ts`
- Modify: `packages/core-tools/src/result-file-tools.ts`
- Modify: `packages/core-tools/src/result-materialization-store.ts`
- Modify: `packages/core-tools/test/node-workspace-mutation-primitive.test.ts`
- Modify: `packages/core-tools/test/result-file-tools.test.ts`
- Modify: `packages/agent-host/src/agent-runtime.ts`
- Modify: `packages/agent-host/test/session-model-binding.test.ts`
- Modify: `packages/core-tools/test/tool-invocation-test-harness.ts`
- Modify: `packages/core-agent/src/tool-registry.ts`
- Modify: `packages/core-agent/test/tool-invocation-registry.test.ts`
- Modify: `scripts/run-capability-control-plane-benchmark.mjs`
- Modify: `scripts/tests/agent-runtime-benchmark-contract.test.mjs`
- Modify: `package.json`
- Modify: `packages/core-db/test/postgres-driver-runtime-errors.test.ts`
- Modify: `packages/core-tools/test/process-runtime.test.ts`
- Modify: `packages/core-tools/src/mcp-runtime-manager.ts`
- Modify: `packages/core-tools/test/mcp-runtime-manager.test.ts`
- Modify: `packages/core-agent/test/agent-kernel-architecture.test.ts`
- Modify: `packages/core-agent/test/agent-kernel-context-scale-boundaries.red.test.ts`
- Modify: `packages/core-agent/test/agent-kernel-factory-recovery.test.ts`

**Interfaces:**
- Consumes: 已完成的 workspace mutation 与 result materialize/save 行为合同。
- Produces: 语义不变且通过 ESLint 类型感知规则的流清理、Promise rejection 和测试 fixture。
- Produces: 独占临时文件创建失败时不删除其他进程或既有状态拥有的同名文件。
- Produces: 有界复用相同已验证 Schema 的 Tool Registry，以及以 14 个基础 Tool 为准的当前性能合同。

- [x] **Step 1: 消除 finally 覆盖错误的控制流**

`writeExclusiveStream` 捕获 operation error 和成功结果，在主 try/catch 之后依次执行 cancel、release、close、unlink；
最后按“原始错误、单个 cleanup 错误、原始错误加 cleanup errors 的 AggregateError”顺序抛出，不在 `finally` 中
执行 `throw` 或 `return`，并保持原错误为 AggregateError 第一项。

独占创建失败的清理由实际创建文件的一层负责：Node primitive 只能删除由本次成功 `wx` 打开后留下的临时文件；
adapter 不得在 `wx` 打开失败后无条件删除可能预先存在的同名路径。回归测试同时验证源流收到取消、原始错误保留，
以及预存临时文件内容不变。崩溃恢复同样不能把仅有 `prepared` Journal 当成临时文件所有权证明：该阶段只清理
Journal，外部随后创建的同名路径必须保留；只有进入 `temporary_ready` 后才能按现有恢复合同清理已创建临时文件。

- [x] **Step 2: 规范 Promise rejection reason**

两个有界 stream-read helper 在 Promise rejection 回调收到 `unknown` 时，只传递 `Error`；非 Error 值转换为带稳定
消息的 `Error`。不得改变 deadline、abort、reader lock 或 timeout 行为。

- [x] **Step 3: 删除无效类型断言并修正 fixture Promise**

依赖现有 TypeScript narrowing 删除 `opened!` 和不改变接收类型的 `as unknown as PortableValue`；测试 fixture 中没有
`await` 的 async 方法改成显式 `Promise.resolve`/`Promise.reject` 返回；执行 helper 使用公共
`ToolInvocationContribution` 类型，去掉重复 union constituent 与无效断言。只改类型表达，不改测试断言语义。

- [x] **Step 4: 运行聚焦 Lint**

运行：

```powershell
pnpm --filter @dbagent/core-tools lint
```

预期：零 error、零 warning。完整 typecheck 和测试仍由下一 Task 统一执行。

- [x] **Step 5: 有界缓存完全相同的已验证 Tool Schema**

在 `tool-registry.ts` 增加进程内 `Set<string>`，最大 1024 项。`validateSchema` 仍先执行 plain object、portable
snapshot、字节限制、`$async` 禁止和 output 私有 result-envelope 禁止；然后用 snapshot 的 JSON 文本查缓存。
未命中时用新的 Ajv compiler 编译，只有成功后才加入缓存；加入前若已达 1024 项则整体清空。名称、revision、
owner、handler、权限和 Tool descriptor 的其余验证不得缓存或跳过。

- [x] **Step 6: 增加缓存边界回归测试**

在 `tool-invocation-registry.test.ts` 先发布一个 input Schema，其 `description` 含
`schemanaut.agent-tool-result.v1`，再尝试把内容完全相同的 Schema 作为另一个 Tool 的 output；必须仍以私有 result
envelope 错误拒绝，证明缓存不能跨 input/output 边界绕过限制。

- [x] **Step 7: 同步 14 Tool 性能基线并运行聚焦合同**

把 Capability benchmark 的 `modelToolCount` 从历史 12 更新为当前 `BASE_TOOL_MANIFEST.length`，合同测试明确期待
14。先构建 `@dbagent/core-agent`，再运行：

```powershell
node --test --test-name-pattern "capability benchmark" scripts/tests/agent-runtime-benchmark-contract.test.mjs
```

预期：10k case 在 120 秒预算内完成，状态 `passed`，模型直载 Tool 数为 14。不得降低 10k 规模或放宽时间阈值。

统一测试若发现测试装配仍手工发布旧的基础 Tool 子集，同步该 fixture 使用当前 14 Tool 基线；产品 Runtime 的
基线仍以 manifest/Host 组合为唯一事实来源，不在测试中另造一套名称清单。

根级 Vitest 脚本必须排除 `.superpowers/**` 协调快照，避免计划技能保存的历史测试文件被当成当前源代码重复执行；
这只收紧测试发现范围，不删除协调文件，也不改变产品 Runtime。

根级完整工作区测试固定使用 `turbo test --concurrency=1`。结果存储、进程和 MCP 集成测试不与其他 workspace 的
SQLite/子进程负载争抢短预算；不得逐项放宽测试超时来掩盖并发调度噪声。CI 与本地发布验证共用该入口。

结果物化根目录逐层创建必须把并发创建造成的 `EEXIST` 视为重新 `lstat` 的信号，并继续原有防符号链接与目录
身份校验。用两个 Store 在同一全新项目根并发初始化作为确定性回归。若初始化确实失败，Agent Runtime 关闭应
直接保留初始化错误并跳过未初始化 Store 的 `cleanupAll()`，不得用次生 precondition 错误覆盖根因。

若统一测试中的 Driver 集成断言仍期待 SQLSTATE `42601` 为旧的 `QUERY_FAILED`，将该断言同步到分类器既有合同
`VALIDATION_ERROR`，并保留 `detail` 与 `retryable: false` 验证；不得为通过测试而改变 Driver 的 Result 边界。

Windows 原生树终止的测试必须先用有界 readiness 条件证明孙进程已经启动，再显式终止并验证 Runtime 返回
`external/unknown` 及后代仍存活的证据；不得用延长固定 sleep 或假定 shell 启动速度来掩盖测试竞态。

MCP candidate 必须在可能等待远端返回的 `listTools()` 之前订阅进程退出，避免发现期间退出被漏记并留下陈旧
generation。真实进程集成测试在正常启动完成后显式调用夹具的 crash Tool，再验证退出与工具移除；不得依赖固定
毫秒定时退出与 `startupComplete` 竞争。排队的退出操作必须携带触发事件的 client 身份，并在真正执行时再次校验
它仍是当前 generation；旧 client 的延迟退出不得移除已经替换成功的新 generation。

Windows 后代存活证据只能在 `terminate()` 返回 `external/unknown` 后产生：孙进程先报告 ready，再等待测试发出的
release 文件，收到 release 后才写 marker；测试用有界条件等待 marker，不用固定 sleep。

Core Agent 测试不得硬编码旧基线数量：模型请求工具应与当前捕获 Catalog 的 `llmTools()` 名称相等。上下文预留
用例把输入窗口调到能明确区分 session 输出预留与 route 输出预留的区间。长模型租约用 fake clock 和模型开始
readiness 确定性推进超过两个 TTL；readiness 必须与执行提前结束竞速，任何提前完成或失败都立即进入 `finally`
恢复真实时钟，不能等待外层测试超时。审批生命周期用例单独给其写工具 60 秒 prepared/execution deadline，避免测试
往返耗尽与该用例无关的 1 秒绝对期限。生产预算、租约与 Tool deadline 合同不得放宽。

### Task 4: 执行发布验证并记录真实结果

**Files:**
- Modify: `docs/engineering/verification.md`
- Generated locally, not committed by this plan: `release/SchemaNaut-v0.1.0-alpha.2/*`

**Interfaces:**
- Consumes: Task 1 的公共合同与 Task 2 的完整打包闭包。
- Produces: 当前工作区的类型、Lint、测试、npm 合同、tarball 和隔离安装证据，以及所有跳过/失败项。

- [x] **Step 1: 先执行低成本静态门禁**

依次运行：

```powershell
pnpm typecheck
pnpm lint
pnpm test:script-contracts
pnpm test:capability-runtime
pnpm test:agent-acceptance
pnpm test:npm-package:contracts
```

根级验收脚本不得在 npm script 内再次调用裸 `pnpm`；应直接从根工作区运行 Vitest 并传入目标测试文件。
这样门禁只依赖仓库锁定的包管理器入口，不会因执行机 PATH 上的另一 pnpm 版本在测试开始前尝试重建依赖目录。

记录每条命令的退出码和测试数量。失败时先定位是否属于本计划改动；无关的既有失败如实记录，不擅自扩大修改范围。

- [x] **Step 2: 执行全套测试**

运行：

```powershell
pnpm test
```

记录通过、跳过与失败。需要外部 PostgreSQL、浏览器或模型的测试不得伪装成本地通过。

- [x] **Step 3: 串行生成并验证本地 npm 候选**

共享 `dist` 清理会互相影响，因此以下命令不得并行：

```powershell
pnpm release:local
```

预期：完成 clean build、tarball 合同、SHA256/provenance 校验、全新临时目录离线安装，以及 `--help`、`init`、
`skills`、`sessions` 和交互退出 smoke；不执行 `npm publish`。

- [x] **Step 4: 更新验证记录**

在 `docs/engineering/verification.md` 增加带日期的发布收口小节，列出实际命令、结果、环境型跳过、仍未关闭的真实模型
场景和 npm 产物位置。不得把部分成功写成完整 live acceptance 成功。

### Task 5: 架构一致性终审

**Files:**
- Review only: all files touched by Tasks 1-3

**Interfaces:**
- Consumes: spec、用户文档、发布代码和验证证据。
- Produces: 对优势表达、文档分层、Capability 边界、结果生命周期和发布闭包的一致性结论。

- [x] **Step 1: 检查文案与代码事实**

逐项核对 README 的 14/8 数字、三张图、`tool_search` 激活语义、外部配置、权限模式、Browser CDP 边界和
`result_read/materialize/save` 语义。任何无法从代码或测试证明的“更快、更省、更安全”绝对结论必须删除或改为
待 Benchmark 验证的假设。

- [x] **Step 2: 检查发布闭包**

解包生成的 tarball，确认 first-party capability 文件存在，JavaScript 中不存在 `@dbagent/*`，manifest 仍为
CLI-only 且没有公开内部 exports。

- [x] **Step 3: 检查工作区边界**

运行 `git status --short`，确认没有提交、推送、远程发布、全仓重命名或无关文件清理，并报告仍属于用户的既有改动。
