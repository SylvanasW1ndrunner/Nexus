# server、CLI 与参考 WebUI 模块

## 代码入口

- `apps/server/src/server.ts`：本地 HTTP Server、REST 路由、输入校验和错误映射。
- `apps/server/src/cli.ts`：`dbagent-server` CLI 启动入口。
- `apps/server/src/web-ui.ts`：无构建链的单页参考 WebUI。
- `apps/server/src/index.ts`：可编程启动接口。

## 组合边界

`@dbagent/server` 是 `@dbagent/sdk` 的薄适配层。路由不重复实现数据库、RAG、Prompt、安全或执行逻辑；它只负责：

- 把 OpenAI-compatible 和 PostgreSQL 配置组装为 Runtime adapter。
- 将 HTTP JSON 映射为 SDK 方法调用。
- 将稳定 SDK 错误码映射为 HTTP 状态码。
- 托管一个用于试用与排错的静态单页。

SDK 是真实产品能力，WebUI 是参考客户端。未来 MCP、Python SDK 和其他插件必须复用同一个 Runtime，不复制业务状态机。

## REST 路由

- `GET /health`
- `GET /v1/capabilities`
- `GET /v1/status`
- `POST /v1/setup`
- `POST /v1/schema/index`
- `GET /v1/schema/status`
- `POST /v1/query/generate`
- `POST /v1/query/execute`
- `GET /v1/runs/{runId}`

请求体最大 1 MB，支持带 `Content-Length` 和 HTTP chunked body。响应对 `bigint`、`Date` 和 `Buffer` 做稳定 JSON 序列化。

## 安全边界

- MVP 只允许绑定 `127.0.0.1`、`::1` 或 `localhost`，拒绝 `0.0.0.0` 和远程地址。
- API Key 与数据库密码只保存在当前进程内存，不落盘、不回显。
- `/v1/setup` 响应只返回脱敏 Provider 摘要与连接元数据。
- Server 设置基础浏览器安全 header，页面不加载第三方脚本。
- `/v1/query/execute` 只接受 run id，不接受 SQL 文本。

这个本地 Server 尚未提供认证和 TLS，因此不能直接暴露到局域网或公网。团队服务、反向代理、SSO 和集中 Secret 属于 H4。

## WebUI 原则

参考页面使用原生 HTML/CSS/JavaScript，不引入 React、Monaco、路由器或状态框架。它只覆盖模型与数据库配置、Schema 索引、提问、SQL/证据/风险审阅、显式执行和结果表。

页面通过文本节点和 DOM API 渲染动态值，不把模型或数据库返回值作为任意 HTML 插入。Secret 输入在配置成功后清空。

## 测试覆盖

`apps/server/test/server.test.ts` 覆盖：

- 静态页与健康接口。
- 配置、索引、生成、执行和 run 查询完整路由。
- Secret 不进入响应。
- 无效 JSON、缺失 run 和未知路由错误。
- chunked JSON 请求体。
- 非 loopback 地址拒绝。

编译后还需启动 `apps/server/dist/cli.js`，检查页面与 `/health`，避免只验证测试内的可编程启动。

## 后续扩展

- OpenAPI 与生成客户端。
- SSE 运行事件、取消与 request id。
- 可配置 CORS、认证和团队部署模式。
- MCP Server adapter。
- 容器镜像与私有化部署样例。
