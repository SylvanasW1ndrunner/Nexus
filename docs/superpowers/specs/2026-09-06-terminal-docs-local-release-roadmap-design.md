# Terminal 文档、本地发布与路线图设计

## 目标

本轮将 SchemaNaut 的当前交付面收敛为一个可从本地 npm tarball 安装的 terminal-first 产品，并完成与真实代码一致的文档和后续开发路线报告。SchemaNaut 包不会上传 npm Registry；安装时第三方依赖仍可来自本机缓存或配置的 Registry。不会恢复 SDK、HTTP API 或 WebUI，也不会把内部 workspace 包变成公共 API。

## 产品与发布边界

- 用户入口只有 `schemanaut` 命令。
- 本地发行包沿用历史包名 `@nwlworkshop/schemanaut`，版本升级为 `0.1.0-alpha.2`。
- 发行包只提供 `bin.schemanaut`，不声明 `main` 或 `types`，并声明空的 `exports` 映射阻止包名子路径导入。
- `packages/agent-host`、`packages/core-*`、`packages/database-capability` 和 `packages/shared` 保持 `private: true`。
- 本地 tarball 包含编译后的内部实现，但不承诺这些内部路径的兼容性。
- 本轮只生成 tarball、SHA256 和本地来源记录；不执行 `npm publish`。

## 文档结构

根 README 负责产品定位、安装、五分钟首次对话、能力边界和文档导航。`docs/README.md` 按终端用户、架构读者和维护者组织入口。现有四篇架构文档继续保留，但统一说明 `agent-host` 是私有组合层，Capability 是平等模块，数据库只是首个内置能力。

控制台使用文档以 `docs/guides/terminal.zh-CN.md` 为中文主文档、`docs/guides/terminal.md` 为事实一致的英文版本。它覆盖本地包安装、源码运行、初始化、模型设置、交互命令、权限、Session/Run、Skills、MCP、诊断、退出和当前数据库限制。旧 `cli*.md` 路径删除，所有导航同步迁移。

`SECURITY.md` 删除已不存在的 Server 暴露说明，改为模型 Endpoint、项目配置、MCP 进程、工作区工具、数据库凭据和本地状态的安全边界。`apps/terminal/README.md` 与 `packages/agent-host/README.md` 分别说明维护者入口和私有 Host 边界。

## 本地 npm 发行结构

恢复旧发行脚本中经过验证的“复制编译产物并改写 workspace import”机制，但只适配当前 12 个运行时 workspace：11 个基础/Host 包和 `apps/terminal`。产物布局为：

```text
release/SchemaNaut-v0.1.0-alpha.2/
  schemanaut-v0.1.0-alpha.2.tgz
  SHA256SUMS.txt
  PROVENANCE.json
```

tarball 内部布局为：

```text
package/
  dist/terminal/cli.js
  dist/terminal/...
  dist/internal/agent-host/...
  dist/internal/<workspace>/...
  README.md
  README.zh-CN.md
  LICENSE
  NOTICE
  THIRD_PARTY_NOTICES.md
  docs/...
  package.json
```

构建脚本只复制 `.js`、`.json` 和必要运行时资源；不发布 `.d.ts`、source map、测试、状态数据库、缓存、`.env`、历史 SDK/Server 归档或源码。它把 `@dbagent/*` import 改写为发行目录中的相对路径，复制 core/database Skills，并验证所有改写目标存在。

`node scripts/release-local.mjs` 负责干净构建、生成 tarball、运行契约检查，并在临时目录安装 tarball后执行 `schemanaut --help`、`init`、`skills`、`sessions` 与默认 chat 后 `/exit`；`pnpm release:local` 是等价别名。流程不执行 Registry 发布；第三方依赖可以来自本机缓存或用户配置的 Registry。

## 路线报告

路线报告保存为 `docs/product/roadmap.md`，包含当前能力矩阵、架构差距、用户体验问题、优先级、五个里程碑、每个里程碑的用户场景和验收标准。近期优先级是：安全的首次配置体验，然后是 terminal Capability 状态与数据库垂直切片；不得先恢复 SDK/API。

## 验证策略

遵循当前项目约定：先完成静态开发，再统一验证，不以测试驱动。最终至少执行：文档链接/旧入口扫描、版本与发布清单检查、完整 terminal build、相关类型检查、脚本合同、terminal/agent-host 聚焦测试、本地 tarball 安装与 CLI 冒烟。真实模型和 PostgreSQL 测试保持 gated，不在缺少凭据时伪造通过。
