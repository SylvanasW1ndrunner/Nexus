# BetaV0.1.1 认证验证码策略收紧

## 背景

登录、注册、忘记密码已经具备本地 PostgreSQL 仓储和 IPC 接入，但验证码签发策略还需要更贴近正式产品：

- 注册验证码不应继续发给已存在账号。
- 登录和重置密码验证码不应发给不存在账号。
- 手机号允许用户输入空格或短横线，但存储、登录和验证码校验必须使用同一规范化形式。

## 本次实现

- `AuthService.requestCode` 在签发验证码前检查账号存在性：
  - `register`：账号已存在则拒绝。
  - `login` / `reset-password`：账号不存在则拒绝。
- 手机号规范化：
  - 邮箱继续使用 trim + lowercase。
  - 手机号去除空格和短横线，例如 `+86 138-0000-0000` 会保存并匹配为 `+8613800000000`。
  - 账密登录同样支持带空格或短横线的手机号输入。
- 保持 PostgreSQL 仓储接口不变，规则集中在 `AuthService`，方便后续切换云端认证服务时复用业务契约。

## 测试覆盖

- 邮箱注册后会话持久化。
- 手机号带空格/短横线注册、账密登录、验证码登录。
- 登录/重置密码验证码对不存在账号拒绝签发。
- 注册验证码对已存在账号拒绝签发。
- legacy sha256 密码登录后自动升级为 PBKDF2。

## 验证

- `vitest run packages/core-auth/test/auth-service.test.ts`
- `tsc -p packages/core-auth/test/tsconfig.json --noEmit`
- `eslint packages/core-auth/src/auth-service.ts packages/core-auth/test/auth-service.test.ts`
