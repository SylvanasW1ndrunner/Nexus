# core-tools MCP Market 抽象

## 范围

`packages/core-tools/src/mcp-market.ts` 提供 MCP Market 的后端抽象。它不绑定 Smithery、mcp.so 或任何网络 API，也不新增依赖；当前目标是让后续多个市场来源可以接入同一套搜索、安装模板和 secret 处理合同。

## 开源方案判断

当前调研结论：
- Smithery 适合作为后续 provider adapter，但其 API、托管连接和安装返回结构不应写死到核心模型。
- Model Context Protocol 官方生态已经形成 registry 和 server 包模式；DBAgent 应先抽象 provider，再接入具体市场。
- 当前阶段优先实现本地静态 provider 和安装合同，保证 UI、测试和后续网络 provider 都复用相同接口。

## 代码入口

- `McpMarketProvider`
- `McpMarketEntry`
- `McpMarketInstallTemplate`
- `StaticMcpMarketProvider`
- `buildMcpServerInputFromMarketTemplate()`
- `createDefaultStaticMcpMarketProvider()`

## 行为合同

Market provider 只负责：
- 搜索条目。
- 返回安装模板。
- 声明必需 env。
- 声明 env 是否必须作为 secret。

安装流程不直接写文件，不启动进程，不接触 keychain。写配置、保存 secret、启动 MCP server 由 desktop `DesktopMcpMarketService` 编排。

## 安全边界

`buildMcpServerInputFromMarketTemplate()` 会检查：
- 必需 env 是否提供。
- secret env 不能通过 plain env 写入。
- market 安装的 server source 固定为 `market`。
- install 后的 `marketEntryId` 保留，用于后续审计和卸载。

## 当前默认静态目录

当前内置静态目录只作为无网络的官方 bootstrap：
- `modelcontextprotocol-memory`
- `modelcontextprotocol-fetch`

它们使用 stdio + `npx -y` 启动模式。真正的网络市场 provider 后续应作为 adapter 接入，不替换这套合同。

## 测试覆盖

`packages/core-tools/test/mcp-market.test.ts` 覆盖：
- query/category/limit 搜索。
- install template clone。
- market template 转换为安全 `McpServerInput`。
- required secret env 校验。
- duplicate entry 拒绝。
