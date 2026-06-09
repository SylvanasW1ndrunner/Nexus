# BetaV0.1.1 认证数据库未配置提示

## 背景

账号模块按产品要求使用 PostgreSQL 存储本地账号数据。测试版用户首次启动时可能尚未配置 `DBAGENT_AUTH_DATABASE_URL`，此时注册、登录、验证码请求不应只返回普通校验错误，而应明确说明账号功能依赖 PostgreSQL 认证数据库。

## 本次实现

- 新增共享错误码 `AUTH_DATABASE_UNAVAILABLE`。
- `UnavailableAuthRepository` 改为抛出 `AuthDatabaseUnavailableError`，让主进程能够识别认证数据库未配置状态。
- 主进程 `safeResult` 将该错误映射为 `AUTH_DATABASE_UNAVAILABLE`。
- 渲染端 `formatAppError` 对该错误码展示可操作提示：配置 `DBAGENT_AUTH_DATABASE_URL` 并重启应用。

## 用户体验约束

- 未配置认证数据库时，账号页仍可打开，但注册、登录、验证码请求会给出明确配置提示。
- 该提示不应和账号不存在、验证码错误、密码错误混为一类。
- 后续云端认证上线后，可以保留同一错误码用于区分本地/云端认证服务不可用。

## 测试覆盖

- `auth-service.test.ts` 覆盖不可用 PostgreSQL 认证仓库会抛出 typed error。
- `diagnostics.test.ts` 覆盖前端格式化结果包含 `DBAGENT_AUTH_DATABASE_URL` 配置指引。
