# 打包策略

DBAgent 当前有 Headless npm 包和历史 Electron 桌面包两条交付路径。依赖选择必须服务于稳定、可验证、可独立启动的发布物。

## 基本规则

- 运行时依赖要少而明确。
- 测试、lint、构建、Docker fixture 和调试 helper 放在 `devDependencies` 或仓库脚本中。
- 不把后端服务打进桌面应用。
- 原生模块隔离在 package 边界内，让打包问题局部化。
- RAG embedding、MCP server、Python runtime、模型服务和大型索引后续必须 lazy load。
- 以打包后的 Electron 应用作为发布物。Vite、Vitest 或 renderer 浏览器里能跑，不代表最终应用能启动。
- Headless MVP 以标准 npm tarball 作为发布物；试用者只需要 Node.js 自带的 npm/npx，不需要 pnpm、workspace 或源码。

## 当前运行时依赖

- Electron 和 React：桌面壳与界面。
- `pg`：PostgreSQL 访问，由 `@dbagent/core-db` 使用。
- Zustand：后续 renderer 状态变复杂时使用的轻量状态管理。

注意：`pg` 是客户端驱动，不是数据库服务器。测试中下载或启动的 PostgreSQL binary、Docker 容器和 fixture 数据只服务于开发验证，不能进入用户安装包。

## Electron 依赖风险

- Electron、preload 脚本和主进程模块在打包后处于不同的解析路径和文件布局。任何依赖源码路径、workspace symlink 或未构建包的 import，都必须在发布前发现。
- 原生或 optional dependency 必须在目标平台的打包产物中验证。如果依赖需要 rebuild，该步骤必须属于桌面打包流水线，而不是应用启动流程。
- PostgreSQL 相关代码应收敛在 `@dbagent/core-db` 边界内，桌面应用只导入稳定接口，避免驱动细节扩散到 main 和 renderer。
- 用户常见路径是本地桌面连接远程服务器数据库，因此连接超时、语句超时、TCP keepalive 和具体错误分类属于运行时能力，不依赖额外服务，也不应要求用户安装本地 PostgreSQL。
- Docker Compose、PostgreSQL 测试容器、fixture loader、CI helper 绝不能进入最终应用包。

## 最终包约束

- 包内只应包含编译后的应用代码、生产运行时依赖、静态 UI 资源和 Electron 元数据。
- 包内应排除仅供内部调试的 source map、集成测试 fixture、Docker 文件、coverage、local database、`.env` 文件，以及不参与应用启动的开发脚本。
- M0-M1.5 不打包数据库服务器、模型服务器、MCP server、Python runtime 或 embedding index。这些能力后续通过明确的用户流程安装或配置。
- 打包验证必须检查启动、IPC handler 注册、认证状态、用量状态；候选发布 QA 还应至少做一次从打包产物发起的远程或本地 PostgreSQL 连接测试。
- 密码存储当前使用 Electron `safeStorage`；发布 QA 必须分别验证 Windows、macOS、Linux 上的加密可用性和 fallback 行为。
- CSV 导出这类 renderer-only 功能优先使用浏览器原生能力，除非未来格式确实需要运行时依赖。
- 工作区恢复状态是 Electron `userData` 下的小 JSON 文件，不能进入 ASAR；安装/卸载 QA 应把它视作用户数据。

## Headless npm 包

执行：

```bash
pnpm package:mvp:npm
```

会先构建 `@dbagent/server`，再把 Server、SDK、数据库驱动和极简 WebUI bundle 为单个 Node ESM 可执行文件，最终在 `release/HeadlessMVP-v<version>/` 生成：

- `DBAgent-Headless-MVP-v<version>.tgz`：标准 npm tarball。
- `SHA256SUMS.txt`：下载校验值。

仓库内的构建包继续使用 `@dbagent/server`，对外 npm 包名固定为 `@nwlworkshop/dbagent`，CLI 命令为 `dbagent`。两者分离可以避免为了发布名称改动 workspace 依赖关系。

tarball 只允许包含 bundle、`package.json`、试用说明和第三方运行时许可证。不得包含 `.env`、源码、source map、测试、fixture、workspace symlink、数据库服务器、模型服务器或构建工具。包要求 Node.js 20.11 或更高版本，启动命令为 `npx --yes ./DBAgent-Headless-MVP-v<version>.tgz`。

构建使用 `esbuild` 0.25.x（MIT）作为开发依赖，将 workspace 运行时代码和 `pg` 依赖封装为一个跨平台 ESM 文件；它不会进入用户的运行时依赖树。相比发布带 `workspace:*` 的原始包或复制整套 `node_modules`，单文件 bundle 避免 pnpm symlink、平台路径和安装期联网问题。替代方案包括逐包发布、npm workspaces 重写和 `@vercel/ncc`，但对当前三人团队的 MVP 增加了版本协调或额外工具成本。发布前仍需在仓库外解包并启动，检查 `/health` 和首页。

## 打包命令

```bash
pnpm --filter @dbagent/desktop build
pnpm package:dir
pnpm package
pnpm package:win
pnpm package:mac
pnpm package:linux
pnpm package:all
pnpm package:verify
pnpm package:verify:asar
```

`package:dir` 生成未安装目录，适合快速检查文件布局和 ASAR 内容；`package` 生成平台安装包。根目录脚本会先执行 workspace build，再转发到 `@dbagent/desktop`，避免桌面包构建时依赖包产物缺失，也避免开发者在不同 package 目录下使用不同命令。
跨平台脚本是发布入口约定；是否能在当前机器上产出目标平台包，仍取决于 `electron-builder` 对该目标平台的支持、签名配置和系统工具链。

`package:verify` 会检查当前平台的 unpacked 产物、ASAR 必要入口文件、workspace 包源码/测试残留，并短时启动打包后的应用确认主进程能存活。它还会比较 `app.asar` 和当前构建输入的修改时间，防止开发者改完代码后误验证旧包；如果失败，应先重新运行 `pnpm package:dir` 或 `pnpm package`。`package:verify:asar` 只做文件、ASAR 和新鲜度检查，适合没有图形环境的 CI 或远程构建机。

当前 `electron-builder` 配置会把 `dist/**` 和必要运行时文件打进 ASAR，并在 `apps/desktop/release` 下输出平台产物。`afterPack` 使用 `scripts/prune-asar.cjs` 二次裁剪 `node_modules/@dbagent/*` 中的 `src`、`test`、`.turbo`、`tsconfig*`、source map 和测试构建产物，避免 workspace 包源码被带入最终 ASAR。

## 当前验证基线

发布候选至少运行：

```bash
pnpm run ci
pnpm package
pnpm package:verify
```

如需在真实 PostgreSQL 上验证连接路径，先启动 fixture：

```bash
pnpm db:up
pnpm test:postgres
pnpm db:down
```

Windows 上曾通过 `pnpm package` 生成 `apps/desktop/release/DBAgent Setup 0.1.0.exe`，安装包约 71.51 MB，低于 M0-M1.5 基线阶段小于 200 MB 的产品目标。该数值是历史验证结果，不应替代每次候选发布的重新打包和启动验证。

## 发布资产

每个正式测试版本都必须生成可交付给用户的 Release 包，不能只保留源码 tag。当前 Windows 发布至少包含：

- 安装包：由 `pnpm package` 生成的 NSIS 安装程序。
- 解压包：由 `apps/desktop/release/win-unpacked` 压缩得到，用户可解压后直接运行 `DBAgent.exe`。
- 校验文件：`SHA256SUMS.txt`，记录安装包和解压包的 SHA256。

Headless MVP 可独立发布 npm tarball 和对应校验文件，不受构建机操作系统限制。正式发布到 npm registry 前必须确认 `NWLworkshop` 账号拥有 `@nwlworkshop` scope 的发布权限、版本号正确，并明确选择公开或受限发布；本地 tarball 或 GitHub Release 附件不需要 registry 登录。

发布资产放在 `release/<version>/` 下，并上传到同名 GitHub Release。完整流程见 [发布流程](./release-process.md)。
