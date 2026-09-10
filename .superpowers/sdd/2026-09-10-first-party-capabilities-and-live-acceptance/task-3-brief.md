## Task 3: 建立第一方 Capability 公共骨架并实现 Git 与 Forge

**Files:**

- Add: `packages/first-party-capabilities/package.json`
- Add: `packages/first-party-capabilities/tsconfig.json`
- Add: `packages/first-party-capabilities/test/tsconfig.json`
- Add: `packages/first-party-capabilities/src/types.ts`
- Add: `packages/first-party-capabilities/src/command-module.ts`
- Add: `packages/first-party-capabilities/src/git-capability.ts`
- Add: `packages/first-party-capabilities/src/forge-capability.ts`
- Add: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/command-module.test.ts`
- Add: `packages/first-party-capabilities/test/git-capability.test.ts`
- Add: `packages/first-party-capabilities/test/forge-capability.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Requirements:**

1. 创建 first-party-capabilities workspace 包，同步根 workspace 与 pnpm-lock.yaml；包声明所需 runtime dependency，并以 tsconfig project reference 引用其直接内部依赖。
2. 公共骨架实现 bounded probe、available/degraded/unavailable、外部 provider choice、immutable generation、刷新、关闭和可行动诊断。
3. 实现设计文档中 Git 的六个 Tool 与 Forge 的七个 Tool；所有 argv 由白名单 enum、长度限制和路径参数构造。
4. Git remote 行为不混入 Git Capability；Forge 只复用 CLI 已有认证，不读取或返回 token。
5. 所有 Tool 的 access、recoveryClass、danger、network/externalWrite/destructive/admin/unknownRisk 与实际调用一致；这些是静态操作事实，不从参数内容推断凭据或 Secret。
6. Tool 输出优先使用 CLI JSON/稳定格式；解析失败返回普通有界 typed external failure，不对认证响应作特殊识别或隐藏。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- git-capability.test.ts forge-capability.test.ts command-module.test.ts`
