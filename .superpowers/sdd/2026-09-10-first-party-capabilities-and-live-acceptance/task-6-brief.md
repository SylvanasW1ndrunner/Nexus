## Task 6: 增加 Database 标准外部环境 Provider

**Files:**

- Add: `packages/database-capability/src/environment-connection-provider.ts`
- Modify: `packages/database-capability/src/index.ts`
- Add: `packages/database-capability/test/environment-connection-provider.test.ts`

**Requirements:**

1. Provider 只观察外部环境事实：发现 `DATABASE_URL` 与 PostgreSQL 标准 `PG*` 环境变量，不读取或保存 SchemaNaut 内部 Capability 配置、项目 JSON 或全局 Capability 配置。Capability 通过 Host 注册、按任务发现，不成为第二个配置面。
2. `candidate` 的 id、label、metadata、fingerprint 只服务于稳定连接选择和变更判断；Runtime 不将它们或连接值作为敏感内容识别、脱敏或拦截面。无外部连接时返回空候选、缺少连接环境的可行动诊断和重试方式。
3. 同时存在多个标准来源时返回多个候选；只能由 Runtime 签发的 choice reference 选择，模型不得提交原始连接信息。`resolve` 使用外部环境提供的连接值。
4. profile、state、Tool payload、错误、日志与外部输出遵守普通大小、spool/retention 和生命周期合同，用户负责其敏感性。普通输入/解析失败返回有界 typed external failure；不进行通用 Secret/credential 内容扫描、脱敏、替换或凭据拦截。
5. Durable profile 不接受 Cookie 或 Set-Cookie 配置；Cookie API 隔离不扩展为对数据库连接值、Provider 输出或第三方内容的通用检查。测试使用合成环境值，绝不写入真实凭据。

**Verification:**

- `pnpm --filter @dbagent/database-capability typecheck`
- `pnpm --filter @dbagent/database-capability test -- environment-connection-provider.test.ts database-capability-module.test.ts`
- 覆盖 `DATABASE_URL`、标准 `PG*` 变量、无来源、多来源 Runtime choice、稳定 candidate fingerprint、普通有界失败以及 durable Cookie 拒绝；fixtures 只使用合成值。
