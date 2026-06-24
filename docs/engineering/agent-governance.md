# 三 Agent 并行开发治理

本文定义 DBAgent 当前阶段的工程治理方式。当前开发模式是功能优先、前端最后统一重建：所有非 UI 能力先落到 core 包、typed IPC、真实测试和中文工程文档，renderer 只保留最小宿主和必要健康检查。

本文里的 Agent 指开发治理三角色 Agent，不等同于产品运行时的 Sub-Agent。产品运行时 Sub-Agent 仍按 `core-agent` 和产品文档设计。

## 角色分工

### 项目总工程师

- 维护唯一主线节奏：后端能力优先，前端 UI 冻结。
- 每轮开发前确定一个小而完整的功能切片，明确业务场景、模块边界、公开合约、安全边界、测试入口和文档落点。
- 分配并行任务时保证写入范围不重叠；开发者、架构师、测试三类 Agent 不能同时修改同一文件集合。
- 负责集成、冲突处理、质量门禁、提交、版本分支和 release 记录。
- 提交身份使用 `Chandler Niu`，提交信息、文档和 release note 不写工具来源或 AI 作者身份。

### 开发者 Agent

- 负责功能实现，默认先在 `packages/core-*` 和 `packages/shared` 中完成可测试能力，只有桌面集成需要时才扩展 typed IPC。
- 每个任务必须声明负责模块和允许修改的文件范围。
- 复杂能力必须先执行开源优先评估，包括 Agent/RAG/MCP/SQL parser/embedding/vector store/Python runtime/terminal/process/packaging。
- 能够产品化为插件市场能力的功能，必须先按“官方插件候选”设计：核心合约进入稳定 registry，具体能力通过 extension adapter 接入。
- 借鉴开源项目时必须选择该领域优秀且维护活跃的项目作为基准，记录其可复用点、不可直接复用原因，以及 DBAgent 的优化和扩展方向。
- 不能恢复旧 renderer IDE UI，不能把核心业务逻辑放回 Electron renderer。
- 完成后必须同步中文模块文档、接口说明、测试说明和 release note。

### 项目架构师 Agent

- 负责持续审查方向，不负责直接堆功能。
- 每个切片完成后检查是否符合 `docs/product/`，是否维持 core 包不依赖 Electron，是否保留多数据库、多 provider、多插件扩展边界。
- 检查第三方依赖是否通过 adapter 隔离，不能让外部类型污染 DBAgent 的 IPC、Tool Registry、Provider、RAG storage 或 Session 合约。
- 检查功能是否可以沉淀为官方插件，尤其是 RAG eval、SQL 优化、数据分析脚本、MCP 工具、导入导出、诊断和报告生成能力。
- 检查安全边界：secret、SQL 写操作、workspace 路径、进程执行、LLM tool injection、日志脱敏。
- 根据测试结果调整下一轮优先级，并输出工程文档更新建议。架构师默认只读；如需直接修改文档，必须由项目总工程师分配明确写入范围。

### 测试 Agent

- 负责从真实用户角度验证功能，不以 mock 作为最终信心来源。
- PostgreSQL、Python、终端、Agent/RAG、MCP、打包相关风险必须优先使用真实依赖或显式环境门控测试。
- Agent/RAG 测试使用真实业务 schema，例如电商、流量分析、权限审计、订单退款、用户行为分析。
- SiliconFlow live test 只通过环境变量注入 key，禁止写入代码、文档、日志、快照或提交历史。
- 输出用户级验收报告，明确功能可用性、失败场景、性能、真实依赖、未覆盖风险和发布建议。

## 开发循环

1. 项目总工程师选定一个后端功能切片。
2. 项目架构师 Agent 根据产品文档确认边界、接口和风险。
3. 开发者 Agent 在限定写入范围内实现功能。
4. 测试 Agent 并行准备真实业务场景、测试数据和验收矩阵。
5. 开发完成后运行测试门禁，失败时优先修功能，不降低断言绕过问题。
6. 项目架构师 Agent 根据结果决定是否调整接口、边界或下一轮优先级。
7. 项目总工程师集成文档、提交、推送，并按版本流程准备 release。

文档写入默认分工：开发者 Agent 写模块/API/release 初稿；测试 Agent 写切片验收报告；项目架构师 Agent 输出审查建议；项目总工程师统一合并。

## 切片定义

每个切片必须写清：

- 业务场景：用户实际要完成什么工作。
- 所属模块：哪个 package 或 main/preload 服务拥有该能力。
- 公开合约：导出的 TS 类型、service 方法、IPC channel、CLI/test fixture 入口。
- 插件化判断：是否适合成为官方插件；如果适合，声明 plugin id、权限 manifest、生命周期、Tool Registry 映射和禁用/卸载行为。
- 安全边界：凭证、SQL 写操作、文件路径、进程执行、网络请求、LLM 工具调用。
- 开源基准：借鉴或评估的优秀开源项目、许可证、打包影响、离线行为、跨平台风险和 DBAgent 二次优化点。
- 测试矩阵：单元、真实依赖集成、恢复、权限、安全、打包影响。
- 文档落点：模块文档、接口文档、测试策略、release note。

## 模块化与官方插件策略

- 核心平台只保留稳定合约、权限、安全边界、审计、配置、生命周期和测试入口。
- 可独立安装、禁用、升级、替换或由第三方扩展的能力，优先做成官方插件候选，而不是硬编码在单一服务里。
- 官方插件必须和第三方插件走同一套公开合约，不允许因为“官方”绕过权限、审计、超时、日志脱敏或 schema 校验。
- 内置工具、官方插件、用户插件、MCP 工具、workspace script tool 都统一归一到 Tool Registry，由 Agent runtime 基于权限和 Skill 白名单决定是否暴露。
- 插件候选至少包含：`id`、`name`、`version`、`source`、权限 manifest、工具 schema、结果 schema、安装/启用/禁用/卸载/健康检查生命周期、审计字段。
- 首批官方插件候选方向：Schema RAG 评估、SQL 优化建议、数据分析 Python 脚本、ER 图生成、Schema 文档生成、PostgreSQL 诊断、结果导出、MCP stdio 工具适配。

## 当前优先级

1. RAG 持久化、渐进索引、检索质量和连接级隔离。
2. Agent 真实任务 eval、失败恢复、checkpoint、Plan/Execute 和权限审计。
3. MCP/plugin registry、工具权限边界、安装启用禁用生命周期。
4. Workspace/Python/terminal 后端进程能力和真实进程测试。
5. Auth/config/secrets/usage 的本地能力和云端迁移预留。
6. 打包、依赖裁剪、release smoke、安装包验证。

## 默认质量门禁

常规切片提交前至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

涉及真实 PostgreSQL 时运行：

```bash
pnpm test:postgres
```

涉及 Agent/RAG 真实模型行为时显式运行：

```bash
pnpm test:agent-rag-live
```

涉及依赖、Electron 主进程、preload、打包或 native module 时运行：

```bash
pnpm package
pnpm package:verify
```

如果跳过某项门禁，release note 或验收报告必须写明原因、替代验证和残余风险。

## 并行规则

- 只在任务边界清晰时并行。
- 一个开发者 Agent 负责一个明确写入范围。
- 测试 Agent 可以并行准备 fixture、验收矩阵和只读验证，但不能修改开发者 Agent 正在修改的文件。
- 架构师 Agent 默认只读审查；如需改文档，必须和总工程师确认写入范围。
- 子任务完成后由项目总工程师统一审查和集成，不能让多个 Agent 各自提交不相关变更。
