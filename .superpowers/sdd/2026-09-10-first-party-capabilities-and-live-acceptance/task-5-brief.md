## Task 5: 实现 BrowserSession Host Port、Documents 与 Data & Notebook

**Files:**

- Add: `packages/first-party-capabilities/src/browser-session-port.ts`
- Add: `packages/first-party-capabilities/src/browser-connector.ts`
- Add: `packages/first-party-capabilities/src/browser-capability.ts`
- Add: `packages/first-party-capabilities/src/document-capability.ts`
- Add: `packages/first-party-capabilities/src/data-notebook-capability.ts`
- Modify: `packages/first-party-capabilities/src/index.ts`
- Add: `packages/first-party-capabilities/test/browser-session-port.test.ts`
- Add: `packages/first-party-capabilities/test/browser-connector.test.ts`
- Add: `packages/first-party-capabilities/test/browser-capability.test.ts`
- Add: `packages/first-party-capabilities/test/document-capability.test.ts`
- Add: `packages/first-party-capabilities/test/data-notebook-capability.test.ts`

**Requirements:**

1. 本轮实现 BrowserSession Host Port 与外部浏览器连接器。v1 连接用户在 SchemaNaut 外启动并登录的本机 Chrome/Edge CDP 会话以复用登录态；以后可替换为 extension 或 native bridge。CDP 地址是 Host 所拥有的外部状态，不是 Tool 参数或 Agent 可提交的值。
2. Agent 只获得不透明的 browser session/page 引用，以及 `browser_navigate`、`browser_read`、`browser_click`、`browser_type_or_interact`、`browser_screenshot` 和 `browser_test`；允许完成这些操作所需的页面交互。连接器不提供通用 Cookie 或 Storage 读取方法。
3. Cookie、API Header 和 Authorization 不进入 Agent schema；Cookie/Set-Cookie 不进入 prepared intent、结果或 Journal。CLI 不内嵌 Chromium；外部 Playwright 仅作无登录截图/测试回退或用户维护的测试配置，不承担登录态共享。`browser_pdf` 仅为可选导出，不是核心登录会话接口。
4. 浏览器访问声明联网，输出文件声明写入；`browser_test` 只运行工作区内明确测试文件，是高风险非幂等代码执行。不存在可证明浏览器隔离时，不得称其处于 Sandbox，也不得把 Playwright 或 notebook 的影响假称为仅限声明路径。
5. Documents 按操作发现 `pandoc`、`pdftotext`、`pdfinfo`，允许 degraded 且不自动安装。实现 `document_metadata`、`document_extract`、`document_convert`：输入、输出必须是 prepare 后固定的文件路径；读取不写文件；转换只写明确目标，未经确认不得覆盖已有文件；外部 CLI 输出遵守普通有界长结果/retention 合同。
6. Data & Notebook 的内置 TypeScript backend 实现 `data_profile`、`notebook_inspect` 和 `notebook_run`。profile/inspect 只读，并限制行数、字节、列数和嵌套深度；`notebook_run` 只接受工作区输入/输出路径，是任意代码执行及非幂等高风险操作，批准前不得创建输出。仅在运行时探测 PATH 中的 `jupyter`；缺失时返回可行动诊断，不影响前两个 Tool。
7. 所有文件操作 prepare canonical target，拒绝越界、symlink 替换、隐式覆盖和无界输入/输出。Capability 不增加内部配置、项目 JSON 或自动安装器；静态权限 facts 不从参数、页面、Cookie、Storage、输出或第三方内容推断 Secret/credential。普通解析/外部失败使用有界 typed external failure，不做内容扫描、认证响应特殊识别、隐藏或脱敏。

**Verification:**

- `pnpm --filter @dbagent/first-party-capabilities typecheck`
- `pnpm --filter @dbagent/first-party-capabilities test -- browser-session-port.test.ts browser-connector.test.ts browser-capability.test.ts document-capability.test.ts data-notebook-capability.test.ts`
- BrowserSession 合同测试覆盖本机外部登录态 CDP 复用、不透明 session/page 引用、没有 Cookie/Storage 读取 API、Cookie API 隔离、页面交互与 Playwright 回退不充当登录连接器。
