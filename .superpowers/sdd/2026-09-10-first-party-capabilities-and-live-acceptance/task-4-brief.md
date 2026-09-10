## Task 4: 实现 Containers 与 Language Intelligence

**Files:**

- Add: `packages/first-party-capabilities/src/container-capability.ts`
- Add: `packages/first-party-capabilities/src/language-capability.ts`
- Modify: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/container-capability.test.ts`
- Add: `packages/first-party-capabilities/test/language-capability.test.ts`

**Requirements:**

1. Capability 不提供 SchemaNaut 内部配置、项目 JSON 或自动安装器；Containers 从 PATH 探测 `docker` 或 `podman`，两者同时存在时要求 Runtime 的外部上下文选择，probe 不触碰 daemon/socket。
2. 实现 `container_list`、`container_inspect`、`container_logs`、`container_exec` 和 `container_compose`。所有容器调用均在静态 permission facts 中标记 daemon/socket 高权限边界；`exec` 与 `compose` 为高风险非幂等执行，Capability 不声称外层 Sandbox 可以约束已经获得宿主机控制权的 daemon/socket。
3. Language 模块从项目标记与 PATH 发现 `tsc`、`pyright`、`ruff`、`cargo`、`go` 和 `ctags` 等已安装工具；按当前可靠子能力报告 available/degraded/unavailable，并为缺失条件返回可行动诊断。父 PATH 或环境变化后必须重启 Host 才能继承。
4. 实现 `language_diagnostics`、`language_symbols` 和 `language_format`。diagnostics/symbols 默认只读；format 仅作用于明确工作区路径并声明写权限。每个 backend 逐项声明风险：cargo check 可能执行 build script，format 会改写文件，不能笼统声称只读；v1 不启动常驻 LSP 或自有语言服务器管理器。
5. 命令型 Capability 仅通过 Host Port 以 `executable + argv[]` 调用，不拼接 shell 字符串。prepare 固定可执行文件、参数、cwd、路径、主机、网络、写入、破坏性、管理员与未知风险等静态操作事实；execute 复核已准备目标、全局权限 revision、取消与 deadline。
6. 静态权限 facts 不含 `credentials`，也不从参数、输出或第三方内容推断 Secret/credential。输出使用普通有界 spool、Runtime retention 与大小/生命周期合同；CLI JSON/稳定格式解析失败返回普通有界 typed external failure，不对认证响应作特殊识别、隐藏或脱敏。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- container-capability.test.ts language-capability.test.ts`
