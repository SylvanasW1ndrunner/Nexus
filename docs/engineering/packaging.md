# 打包策略

DBAgent 是桌面端产品，因此依赖选择必须服务于稳定、可验证的 Electron 打包。

## 基本规则

- 运行时依赖要少而明确。
- 测试、lint、构建、Docker 专用依赖放在 `devDependencies`。
- 不把后端服务打进桌面应用。
- 原生模块隔离在 package 边界内，让打包问题局部化。
- RAG embedding、MCP server、Python 等重能力后续必须 lazy load。
- 以打包后的 Electron 应用作为发布物。Vite、Vitest 或 renderer 浏览器里能跑，不代表最终应用能启动。

## 当前运行时依赖

- Electron 和 React：桌面壳与界面。
- `pg`：PostgreSQL 访问。
- Zustand：后续 renderer 状态变复杂时使用的轻量状态管理。

## Electron 依赖风险

- Electron、preload 脚本和主进程模块在打包后处于不同的解析路径和文件布局。任何依赖源码路径、workspace symlink 或未构建包的 import，都必须在发布前发现。
- 原生或 optional dependency 必须在目标平台的打包产物中验证。如果依赖需要 rebuild，该步骤必须属于桌面打包流水线，而不是应用启动流程。
- PostgreSQL 相关代码应收敛在数据库 package 边界内，桌面应用只导入稳定接口，避免驱动细节扩散到 main 和 renderer。
- Docker Compose、PostgreSQL 测试容器、fixture loader、CI helper 绝不能进入最终应用包。

## 最终包约束

- 包内只应包含编译后的应用代码、生产运行时依赖、静态 UI 资源和 Electron 元数据。
- 包内应排除仅供内部调试的 source map、集成测试 fixture、Docker 文件、coverage、local database、`.env` 文件，以及不参与应用启动的开发脚本。
- M0-M1.5 不打包数据库服务器、模型服务器、MCP server、Python runtime 或 embedding index。这些能力后续通过明确的用户流程安装或配置。
- 打包验证必须检查启动、IPC handler 注册、认证状态、用量状态，以及至少一次从打包产物发起的 PostgreSQL 连接测试。
- 密码存储当前使用 Electron `safeStorage`；发布 QA 必须分别验证 Windows、macOS、Linux 上的加密可用性。
- CSV 导出这类 renderer-only 功能优先使用浏览器原生能力，除非未来格式确实需要运行时依赖。
- 工作区恢复状态是 Electron `userData` 下的小 JSON 文件，不能进入 ASAR；安装/卸载 QA 应把它视作用户数据。

## 打包命令

```bash
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop package
```

当前 `electron-builder` 配置会把 `dist/**` 打进 ASAR，并在 `apps/desktop/release` 下输出平台安装包。

## 当前验证结果

Windows 上 `pnpm --filter @dbagent/desktop package` 已生成：

- `apps/desktop/release/DBAgent Setup 0.1.0.exe`
- 安装包大小：71.51 MB

这低于 M0-M1.5 基线阶段安装包小于 200 MB 的产品目标。
