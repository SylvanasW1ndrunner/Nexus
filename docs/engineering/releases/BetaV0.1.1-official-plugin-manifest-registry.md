# BetaV0.1.1 官方插件能力 Manifest Registry

## 范围

本切片新增后端纯合同：官方插件能力 manifest registry。它服务未来插件市场和官方插件治理，不涉及前端 UI，不启动 MCP，不访问网络，不新增依赖。

## 变更

- 新增 `packages/core-tools/src/official-plugin-registry.ts`。
- `@dbagent/core-tools` 导出官方插件 manifest 类型和默认 registry。
- 默认官方插件：
  - `official.database-postgres`
  - `official.schema-rag`
  - `official.workspace-files`
  - `official.workspace-python`
  - `official.mcp-client`
- Manifest 权限现在声明 resource scope、approval policy、network access、process access、secret kind 和 audit level。
- Registry 支持 enabled/disabled、readonly、permission allow list、max danger level 过滤。
- Registry 拒绝重复插件、重复工具、跨插件静态工具冲突和未知权限引用。

## 验证记录

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/mcp-tool-registration-manager.test.ts packages/core-tools/test/db-tools.test.ts`：3 个测试文件通过，18 个用例通过。

## 参考

- [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

## 已知边界

- 当前是官方能力目录，不是完整第三方插件运行时。
- 当前不处理下载、签名、版本升级、沙箱、安装器和 UI。
- 动态工具仍由 MCP runtime 和 workspace script discovery 在运行时注册。
