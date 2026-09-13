# 验证策略与报告边界

验证以可观察合同为单位。工程报告记录实际命令、结果和未运行原因；不能把局部运行称为完整验收。

## 验证重点

- Tool 的静态操作事实与全局 default、auto、full-access 及企业规则一致。
- require_sandbox 只作为全局企业执行规则；Host 如实报告可证明的进程和隔离事实。
- 命令输出使用普通有界 spool、取消和生命周期约束，不实现内容敏感性识别、脱敏、凭据参数拦截或
  第三方可信度判断。
- Capability、MCP、Skill 和外部 Provider 的输入/输出敏感性由用户负责。
- 真实环境验收验证功能后置条件，不作为产品安全输出治理或泄漏回归。

## 报告

报告可以包含实际运行所产生的普通结果。不要把真实凭据提交到 Git 是仓库卫生要求，而不是 Runtime
的产品保护承诺。

## 2026-09-12 Alpha 发布收口验证

本节取代 2026-09-11 的中间计数。验证在 Windows x64、Node.js v24.18.1、npm 11.16.0、
TypeScript 5.9.3 上执行；仓库命令通过 Corepack 使用锁定的 pnpm 9.15.4。CI 继续固定 Node.js 22.13.0
与 pnpm 9.15.4，用于覆盖公开的最低 Node.js 运行边界。

### 确定性门禁

- `corepack pnpm typecheck`：25/25 Turbo task 通过。
- `corepack pnpm lint`：13/13 workspace package 通过。
- `corepack pnpm test`：26/26 Turbo task 通过，共 1,828 项通过、25 项按环境合同跳过。主要包包括
  Core Agent 704 项、Core Tools 173 项、Core LLM 395 项、Core DB 211 项、第一方 Capability 40 项、
  Database Capability 26 项、Agent Host 58 项和 Terminal 21 项。
- `corepack pnpm test:script-contracts`：43/43 项通过；其中 10k Capability/Tool Registry 合同仍保持
  当前 14 个基础 Tool 的规模与时限。
- `corepack pnpm test:capability-runtime`：8 个文件、106 项通过。
- `corepack pnpm test:agent-acceptance`：1 个统一验收入口通过，覆盖 12 条场景路径，包括基础 Tool、
  Capability 动态激活、权限、Journal、Artifact、进程与工作区后置条件。
- `corepack pnpm test:npm-package:contracts`：11/11 项通过；合同覆盖公开文档存在性、复制计划与相对 Markdown 链接
  传递闭包、第一方 Capability 打包闭包、全部 Runtime workspace 外部依赖闭包、内部导入重写与发布文件边界。

### 本地 npm 候选

`corepack pnpm release:local` 通过。流程完成 clean build、公共文档快照、tarball 合同、SHA256 与
provenance 校验，并在全新临时目录中安装候选后验证 `--help`、`init`、`skills`、`sessions` 和交互退出。
候选仍是 CLI-only 的 `@nwlworkshop/schemanaut@0.1.0-alpha.2`，未执行远程 npm 发布。

产物位于 `release/SchemaNaut-v0.1.0-alpha.2/`：tarball、`SHA256SUMS.txt` 和 `PROVENANCE.json`。
校验和不复制到本文，以免文档内容改变后形成自引用；以同目录的 `SHA256SUMS.txt` 为准。

### 真实环境证据与未关闭项

- 本机真实 PostgreSQL + 确定性 Agent 已验证 Database Capability 可从外部 `DATABASE_URL` 动态发现与激活；
  `sql_execute` 查询 300 行、约 628 KB 的结果，并产生 `resultRefs` 与可交付 `evidenceRefs`。
- SiliconFlow `deepseek-ai/DeepSeek-V4-Flash` 的代码修复与 Git 动态 Capability 场景此前通过。Database
  长结果复验在 360 秒测试级超时处结束，超时后没有保留足够 Journal 证据，因此不能记录为通过，也不能断言
  根因是 SQL、长结果或模型循环。
- 电商经营 SQL、SaaS 流失 SQL + Python 分类、支付风险多轮调查已有 Fixture、Oracle、工具链与报告合同，
  见[真实模型数据分析验收](./real-model-data-analysis-acceptance.md)；三项尚未全部取得真实模型通过证据。
- 需要外部 PostgreSQL、浏览器进程、容器、Forge 登录或真实模型的测试按各自环境合同运行或跳过；确定性全仓
  通过不代表这些外部系统已经在每台执行机上验收。
- Browser 复用用户自行启动的专用浏览器 Profile 登录态；Agent schema 不接收 Cookie、`Set-Cookie`、
  API Header 或 Authorization 参数。该边界不是通用内容扫描或 DLP。

## 2026-09-13 Alpha 3 发布收口验证

本节记录本次发布收口新产生的确定性证据，并在存在差异时取代上节的旧状态；不重复付费真实模型测试。
CLI-only 的 `@nwlworkshop/schemanaut@0.1.0-alpha.3` 候选已经从干净提交生成，并在全新临时目录中完成安装
与 CLI 冒烟。候选文件位于 `release/SchemaNaut-v0.1.0-alpha.3/schemanaut-v0.1.0-alpha.3.tgz`；确切提交、
SHA-256 和 `dirty=false` 状态由同目录 `PROVENANCE.json` 记录。尚未发布到 npm Registry。

### 确定性门禁

- `corepack pnpm typecheck`：25/25 Turbo task 通过。
- `corepack pnpm lint`：13/13 workspace package 通过。
- 强制未缓存的 `corepack pnpm exec turbo test --concurrency=1 --force`：26/26 Turbo task 通过，共 1,829 项通过、25 项按环境合同跳过。
- 全局企业权限规则边界：128 条配置通过，129 条在 Schema 校验阶段拒绝，与 Runtime 上限一致。
- `corepack pnpm test:script-contracts`：45/45 项通过。
- `corepack pnpm test:capability-runtime`：106/106 项通过。
- `corepack pnpm test:npm-package:contracts`：12/12 项通过。
- 本地完整 `corepack pnpm run ci` 的类型检查、Lint、全部工作区测试、脚本合同以及前三组性能门禁通过；
  资源状态性能门禁在当前 Windows 主机降频期间超时。相同源码和基准在该主机此前为 1.15 秒，本次为
  6.14–8.71 秒，同时整段 JavaScript 观测吞吐下降约 4–7 倍，因此未改代码或放宽阈值，最终性能结论交由
  受控的 GitHub Actions 环境复验。
- 隔离安装 smoke 成功验证 `--help`、`init`、`skills`、`sessions` 和交互退出。

### 真实环境证据与未重跑项

- GitHub Actions Windows（Node.js 22.13.0、pnpm 9.15.4）于 2026-09-13 暴露 Skill 磁盘发现回归：
  Node 22 在 Windows 上可为同一文件分别报告 `lstat().dev === 0` 与 `FileHandle.stat().dev !== 0`。
  Registry 仍以相同 `ino`、mtime、size、路径和内容摘要验证稳定性；修复仅在 win32 且任一 `dev` 为
  0 时不把该字段作为身份判据，不放宽不同 `ino` 的替换检测。
- 既有真实模型证据显示：代码修复、动态 Git、电商数据库分析和长结果数据库分析已通过；churn-ML 失败，因为
  Run 是 `interrupted`。
- 付费模型、外部 PostgreSQL、浏览器、容器和 Forge 均未在本次发布收口中重跑。
- 前六次 GitHub Actions 发布复验（runs `34757899868`、`34761714006`、`34763736333`、`34764907067`、
  `34767085788`、`34768751691`）
  先后暴露发布环境合同
  缺口：Windows Node 22 文件设备号差异、Linux 缺少系统 `rg`、PostgreSQL 报告依赖已删除的旧占位测试、
  确定性测试夹具依赖 Windows 短路径与 `.cmd`、慢速 Windows 文件 I/O 下的测试同步与预算不足，以及 Linux
  启动横幅中的 `config.toml` 路径被误判为配置写命令。当前候选已分别改为 Windows 稳定文件身份判定、随 npm
  包分发搜索运行时、由三组真实 PostgreSQL 集成测试生成并校验同次运行报告、跨平台受控 CLI 夹具、按条件等待
  后台租约心跳并为真实文件 I/O 留出测试预算、只禁止遗留配置写入口，以及正确识别并回收 Windows 上被信号
  终止的测试子进程。第五次运行进一步确认两处测试夹具边界：256 次真实 SQLite 提交会超过低层夹具的 60 秒
  Run Lease，而真实 Artifact 保留链路无法在通用夹具的 1 秒 Tool deadline 内完成。生产围栏和超时分类保持不变；
  数量边界用例改用覆盖其工作量的专用租约，结果保留用例同步放宽测试 Tool 的执行 deadline，并在删除临时目录前
  等待 Artifact Store 排空。第六次运行确认真实进程崩溃夹具又把用于快速制造旧 Owner 过期的 2 秒 Lease 同时
  用作恢复 Worker 的活动预算；当前候选保留旧 Owner 的短租约，但让恢复 Worker 使用独立的生产型租约预算，
  不更改 Runtime 的租约续期、围栏或接管语义；最终状态以最新 Actions 运行结果为准。
