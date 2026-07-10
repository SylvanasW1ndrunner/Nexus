# core-tools：数据库历史读取工具

## 模块职责

`read_query_history` 是数据库官方插件 `official.database-postgres` 下的只读 Agent 工具。它服务于 Agent 复查用户最近执行过的 SQL、失败原因、取消记录和回滚预览记录。

该工具不执行 SQL，不连接数据库，不读取凭证，只读取主进程注入的本地历史 reader。

## 注册方式

`registerDatabaseTools()` 新增可选依赖：

```ts
history?: {
  list(options?: QueryHistoryListOptions): Promise<QueryHistoryItem[]>;
}
```

如果调用方没有传入 `history`，则不注册 `read_query_history`。桌面主进程通过 `registerDesktopAgentTools({ queryHistory: queryHistoryStore })` 接入真实历史 store。

## 输入参数

- `connectionId`
- `searchText`
- `status`
- `riskLevel`
- `statementKind`
- `limit`
- `offset`

`status` 只允许 `success`、`failed`、`blocked`、`cancelled`。`riskLevel` 只允许 `safe`、`caution`、`dangerous`、`blocked`。`offset` 允许从 `0` 开始。

## 官方插件声明

`official.database-postgres` 增加：

- capability：`sql-history`
- tool：`read_query_history`
- permission：复用 `database.query.read`
- dangerLevel：`safe`
- readonly：`true`

## 测试入口

- `packages/core-tools/test/db-tools.test.ts`
- `packages/core-tools/test/official-plugin-registry.test.ts`
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
