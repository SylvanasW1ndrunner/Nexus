# 开发过程 Skills

## 模块职责

本模块记录 `skills/` 下用于 DBAgent 后端优先开发流程的项目级 skill。它们不是产品运行时功能，而是开发代理在阅读 `docs/product/` 后执行任务时的操作规范。

当前开发策略是先完成除最终前端 UI 外的核心能力，再统一重建界面。因此这些 skill 默认要求：

- 不重建旧 renderer UI。
- 优先实现 `packages/core-*`、主进程服务、preload、IPC 和测试入口。
- 所有新增文档先使用中文。
- 每个切片都要有可验证的用户场景、测试和提交记录。

## Skill 清单

### `dbagent-backend-slice-execution`

用于把产品文档拆成一个后端功能切片并执行。它规定了切片边界、实现顺序、测试和提交标准，是当前阶段的默认开发入口。

### `dbagent-contract-ipc-development`

用于设计或修改 shared types、IPC channel、preload API、主进程服务适配器和未来 UI/Agent 可消费的公开合同。

### `dbagent-real-integration-testing`

用于 PostgreSQL、终端/进程、Python、文件系统、打包和 LLM/Embedding 门控测试。它强调真实依赖验证，同时要求默认测试不依赖密钥。

### `dbagent-docs-sync-development`

用于同步产品、工程、接口、测试和发布文档。任何影响模块行为、公开合同或验收方式的代码变更都应触发该 skill。

### `dbagent-dependency-packaging-review`

用于评审新增或升级依赖，重点覆盖许可证、闭源商业分发兼容、包体积、原生模块、离线安装、Windows/Linux/macOS 兼容和替代方案。

在 Agent、Schema RAG、MCP、SQL parser、embedding、向量存储、终端进程、Python runtime、插件市场和打包链路中，它不是可选补充，而是编码前的准入步骤。即使最终选择自研，也要记录评估过哪些成熟开源方案、为什么没有复用，以及后续是否保留 adapter 接入空间。

### `dbagent-release-version-discipline`

用于版本级提交、版本分支、release 文件夹、打包产物和验收记录。它固化了“先 main 提交，再按版本名建分支”的发布规则。

## 推荐组合

- 新功能开发：`dbagent-backend-slice-execution` + 对应模块 skill + `dbagent-docs-sync-development` + `dbagent-quality-gate-testing`
- IPC 或 preload 变化：`dbagent-contract-ipc-development` + `dbagent-quality-gate-testing`
- 涉及 PostgreSQL/进程/Python/LLM：`dbagent-real-integration-testing` + 对应模块 skill
- 新依赖：`dbagent-dependency-packaging-review` + 对应模块 skill
- 发版本：`dbagent-release-version-discipline` + `dbagent-quality-gate-testing`

## 校验方式

使用 skill-creator 的结构校验脚本检查每个目录：

```powershell
$env:PYTHONUTF8='1'
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\Users\cdnzx\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\dbagent-backend-slice-execution
```

Windows 默认 GBK 读取中文文件可能导致校验脚本报编码错误，需设置 `PYTHONUTF8=1`。
