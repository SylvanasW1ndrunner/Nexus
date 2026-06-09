# BetaV0.1.1 账号 PostgreSQL 集成测试

## 背景

登录、注册、验证码登录和重置密码最终需要使用 PostgreSQL 存储账号数据。此前 `AuthService` 已覆盖内存仓储，桌面端也要求配置 `DBAGENT_AUTH_DATABASE_URL`，但缺少真实 PostgreSQL 仓储的集成测试入口。

## 本次实现

- 新增 `packages/core-auth/test/postgres.integration.test.ts`。
- 覆盖邮箱注册、账密登录、验证码登录、忘记密码重置。
- 覆盖手机号注册、验证码一次性消费和验证码登录。
- `pnpm test:postgres` 现在同时运行 core-db 和 core-auth 的真实 PostgreSQL 集成测试。
- 默认复用 `DBAGENT_TEST_PG_*` 连接变量，账号模块可用 `DBAGENT_TEST_AUTH_DATABASE_URL` 单独覆盖。

## 运行方式

```powershell
pnpm db:up
pnpm test:postgres
pnpm db:down
```

如果连接远程 PostgreSQL，可以设置：

```powershell
$env:DBAGENT_TEST_AUTH_DATABASE_URL="postgres://user:password@host:5432/dbagent_demo"
pnpm test:postgres
```
