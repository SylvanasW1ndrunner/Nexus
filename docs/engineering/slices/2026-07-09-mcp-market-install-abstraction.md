# 2026-07-09 MCP Market 安装抽象

## 范围

本切片实现 MCP Market 的后端 provider 抽象和 desktop 安装编排服务。

本次不实现网络 market API，不做 UI，不新增依赖。

## 变更

- core-tools 新增 `mcp-market.ts`。
- core-tools 新增默认静态 MCP catalog。
- shared 新增 `mcp:market-search` / `mcp:market-install` IPC DTO。
- desktop 新增 `DesktopMcpMarketService`。
- desktop main 接入默认静态 market provider 和 IPC handlers。
- 补 core 和 desktop 服务测试。

## 验收

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -b apps/desktop/tsconfig.json --pretty false`
- `vitest run packages/core-tools/test/mcp-market.test.ts apps/desktop/src/main/mcp-market-service.test.ts apps/desktop/src/main/mcp-service.test.ts --passWithNoTests`

## 风险

- 当前默认 market 是静态目录，不代表真实 Smithery/mcp.so 网络接入已完成。
- `npx -y` 安装/启动行为依赖用户本机 Node/npm 网络环境，后续打包阶段需要做离线和依赖策略。
- 市场 provider 的签名验证、评分可信度、publisher 认证仍是后续能力。
