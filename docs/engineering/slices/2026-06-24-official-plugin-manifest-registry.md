# 2026-06-24 官方插件能力 Manifest Registry 切片

## 目标

把现有内置能力先抽象成“官方插件能力清单”，为后续插件市场、官方插件、第三方插件和设置页打基础。当前切片只做 manifest/registry 合同，不做真实第三方插件运行时、市场下载、签名、安装或 UI。

## 实现范围

- `core-tools`
  - 新增 `official-plugin-registry.ts`。
  - 导出 `OfficialPluginManifest`、`OfficialPluginPermission`、`OfficialPluginToolContribution`、`OfficialPluginRegistry` 和默认官方插件清单。
  - 默认声明 PostgreSQL DB、Schema RAG、工作区文件、工作区 Python、MCP Client 五类官方能力。
  - 支持启用/禁用过滤、只读过滤、权限过滤和最大危险级别过滤。
  - 拒绝重复 plugin id、重复 tool、跨插件静态 tool 重名和未知 permission 引用。

## 安全边界

- Manifest 是能力目录，不是运行时执行表。
- 不注册 handler，不启动 MCP，不发现 Python 脚本，不访问网络，不持久化配置。
- 动态工具只通过 `workspace_script:*` / `mcp:*` 表达来源。
- 权限声明必须包含 resource scope、approval policy、network access、process access、secret kind 和 audit level。
- 官方能力不特殊放权，仍必须经过 `ToolRegistry`、Agent `allowedTools`、权限模式和 approval provenance。

## 开源/优秀项目借鉴

- [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)：借鉴其声明式 manifest、publisher、version、category 和 contribution points 思路。
- [Model Context Protocol Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)：借鉴 tool name、input/output schema、annotations、用户确认、超时和审计原则。

本轮没有新增依赖。原因是当前只需要静态合同和纯内存 registry；真实市场、签名、扩展宿主和沙箱会在后续切片单独评估。

## 测试

- 默认官方插件清单和静态/动态工具贡献。
- 插件禁用、只读模式、权限 allow list 和危险级别过滤。
- `enabledByDefault: false` 插件需要显式启用。
- 重复 plugin id、单 manifest 重复 tool、跨插件静态 tool 冲突和未知 permission 引用。
- manifest clone 防止调用方修改 registry 内部状态。

## 后续

- 把 manifest 与 MCP config store / Skill registry / 设置页 API 接起来。
- 为第三方插件定义独立 manifest 来源、签名、安装目录、生命周期和 sandbox。
- 增加 output schema/result schema，但不污染当前 `ToolRegistry` 稳定合同。
