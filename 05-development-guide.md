# 05 - 开发指南（Development Guide）

> 文档版本：v0.1
> 关联：[00-overview.md](./00-overview.md) ~ [04-config-design.md](./04-config-design.md)

---

## 1. 项目结构

### 1.1 仓库布局（Monorepo）

```
dbagent/
├── package.json                # 根，pnpm workspace
├── pnpm-workspace.yaml
├── turbo.json                  # Turborepo 配置（可选）
├── tsconfig.base.json
├── .editorconfig
├── .eslintrc.cjs
├── .prettierrc
│
├── apps/
│   └── desktop/                # Electron 主应用
│       ├── package.json
│       ├── electron-builder.yml
│       ├── src/
│       │   ├── main/           # 主进程（Node.js）
│       │   ├── preload/        # 预加载脚本
│       │   └── renderer/       # 渲染进程（React）
│       └── build/
│
├── packages/
│   ├── shared/                 # 主进程/渲染进程共享类型
│   │   └── src/
│   │       ├── ipc-contract.ts
│   │       ├── types/
│   │       └── constants.ts
│   │
│   ├── core-agent/             # Agent 引擎核心
│   │   └── src/
│   │       ├── orchestrator.ts
│   │       ├── strategies/
│   │       ├── loop.ts
│   │       ├── permission.ts
│   │       └── memory.ts
│   │
│   ├── core-llm/               # LLM Router & Providers
│   │   └── src/
│   │       ├── router.ts
│   │       └── providers/
│   │
│   ├── core-rag/               # RAG Engine
│   │   └── src/
│   │       ├── extractors/
│   │       ├── indexer.ts
│   │       ├── retriever.ts
│   │       └── storage/
│   │
│   ├── core-db/                # DB 驱动抽象
│   │   └── src/
│   │       ├── types.ts
│   │       └── postgres/
│   │
│   ├── core-tools/             # 工具系统
│   │   └── src/
│   │       ├── registry.ts
│   │       ├── builtin/
│   │       └── mcp/
│   │
│   ├── core-skills/            # Skill 系统
│   │
│   └── ui-kit/                 # 共享 React 组件库
│       └── src/
│           ├── components/
│           └── hooks/
│
├── docs/                       # 设计文档（本目录）
└── scripts/                    # 构建/打包/工具脚本
```

### 1.2 模块职责

| 模块 | 进程 | 职责 |
|---|---|---|
| `apps/desktop/main` | 主进程 | Electron 启动、IPC handler 注册、依赖注入 |
| `apps/desktop/preload` | 预加载 | 暴露 typed IPC API 给 renderer |
| `apps/desktop/renderer` | 渲染 | React UI、状态管理 |
| `packages/shared` | 共享 | 类型、常量、IPC 契约 |
| `packages/core-*` | 主进程 | 各引擎核心逻辑（**不依赖 Electron**，便于单测） |
| `packages/ui-kit` | 渲染 | 复用组件 |

> **关键原则**：core-* 包不直接依赖 Electron API，通过 DI 接收 logger / fs 等。这样可以在 Node 单测中跑全部逻辑。

---

## 2. 技术栈与版本

| 类别 | 选型 | 版本要求 |
|---|---|---|
| 运行时 | Node.js | ≥ 20.10 LTS |
| 包管理 | pnpm | ≥ 9 |
| 构建 | Turbo (可选) + tsc + Vite | - |
| 桌面框架 | Electron | ≥ 30 |
| 前端 | React + TypeScript | React 18, TS 5.4+ |
| UI | Tailwind CSS + Radix UI | latest |
| 状态 | Zustand | latest |
| 路由 | React Router | v6 |
| 表格 | TanStack Table v8 + react-virtualized | - |
| 编辑器 | Monaco Editor | latest |
| Markdown | react-markdown + remark | - |
| Agent SDK | Vercel AI SDK | latest |
| MCP SDK | @modelcontextprotocol/sdk | latest |
| DB Driver | pg | ≥ 8.11 |
| SQLite | better-sqlite3 | latest |
| sqlite-vec | sqlite-vec | latest |
| Embedding | @huggingface/transformers (BGE-M3) | latest |
| Keychain | keytar | latest |
| 测试 | Vitest + Playwright | latest |
| Lint | ESLint + Prettier | latest |
| Git Hooks | lefthook 或 husky + lint-staged | latest |

---

## 3. 开发环境搭建

### 3.1 前置依赖

- macOS / Windows / Linux 任一
- Node.js 20.10+
- pnpm 9+
- Git
- 可选：Docker（用于本地起 PostgreSQL 测试）
- 可选：Ollama（本地模型测试）

### 3.2 初始化命令

```bash
# 克隆仓库
git clone <repo>
cd dbagent

# 安装依赖
pnpm install

# 配置环境变量（开发用）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY 等

# 启动开发模式（同时跑 main + renderer）
pnpm dev

# 单独跑某个 package 的测试
pnpm --filter core-agent test

# 类型检查
pnpm typecheck

# Lint
pnpm lint

# 打包（当前平台）
pnpm package

# 打包全平台
pnpm package:all
```

### 3.3 本地测试数据库

提供一份 docker-compose 启动测试 PG：

```yaml
# scripts/dev-db/docker-compose.yml
version: '3'
services:
  postgres:
    image: postgres:16
    ports: ['5432:5432']
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: dbagent_test
    volumes:
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
```

`init.sql` 包含示例 schema（users / orders / order_items）+ 1 万条样本数据，用于功能测试。

---

## 4. 编码规范

### 4.1 TypeScript

- `strict: true` 全开
- 禁用 `any`（除非必要并加注释）
- 偏好 `interface` 描述对象，`type` 描述联合/函数
- 文件命名：`kebab-case.ts`，类型定义文件 `*.types.ts`
- 公开 API 必须有 JSDoc

### 4.2 命名约定

| 范畴 | 风格 | 例 |
|---|---|---|
| 文件名 | kebab-case | `agent-loop.ts` |
| 类 | PascalCase | `AgentOrchestrator` |
| 接口 | PascalCase + I 前缀（仅核心抽象） | `ILlmProvider` |
| 函数/变量 | camelCase | `runAgentLoop` |
| 常量 | UPPER_SNAKE_CASE | `MAX_ITERATIONS` |
| React 组件 | PascalCase | `ChatWindow` |
| Hook | camelCase + use 前缀 | `useSession` |
| IPC channel | kebab + colon | `'agent:run'` |

### 4.3 错误处理

- **不吞错**：所有 catch 必须有日志或重抛
- **错误对象有 code**：定义 `class AppError extends Error { code: string }` 便于上层判断
- **用户面向错误友好化**：底层错误用 `toUserMessage()` 转成中文

```typescript
class DbConnectionError extends AppError {
  code = 'db.connection_failed';
  constructor(public dbName: string, cause: Error) {
    super(`Failed to connect to database: ${dbName}`, { cause });
  }
}
```

### 4.4 日志

统一用 [pino](https://github.com/pinojs/pino)：

```typescript
import { logger } from '@dbagent/shared/logger';
const log = logger.child({ module: 'agent-loop' });

log.info({ sessionId, iteration }, 'Starting iteration');
log.error({ err }, 'Tool execution failed');
```

日志写入 `~/.dbagent/logs/`，按日期切分。

### 4.5 注释原则

- 注释解释 **why**，不解释 **what**
- 复杂算法标注引用来源
- TODO 必须带名字和日期：`// TODO(name, 2026-06-01): ...`

---

## 5. 核心抽象与依赖注入

### 5.1 DI 容器

不引入重型 IoC 框架，用简单的 service registry：

```typescript
// packages/shared/src/registry.ts
class ServiceRegistry {
  private services = new Map<symbol, any>();

  register<T>(token: symbol, instance: T) {
    this.services.set(token, instance);
  }

  get<T>(token: symbol): T {
    const s = this.services.get(token);
    if (!s) throw new Error(`Service not registered: ${token.toString()}`);
    return s;
  }
}

// 使用
export const TOKENS = {
  Logger: Symbol('Logger'),
  LlmRouter: Symbol('LlmRouter'),
  ToolRegistry: Symbol('ToolRegistry'),
  RagService: Symbol('RagService'),
  SessionManager: Symbol('SessionManager'),
  PermissionManager: Symbol('PermissionManager'),
  ConnectionPool: Symbol('ConnectionPool'),
};
```

### 5.2 启动序列

```typescript
// apps/desktop/src/main/bootstrap.ts
async function bootstrap() {
  const registry = new ServiceRegistry();

  // 1. 基础设施
  const logger = createLogger(...);
  registry.register(TOKENS.Logger, logger);

  // 2. 配置层
  const settings = await loadSettings();
  const connections = await loadConnections();

  // 3. 核心服务
  registry.register(TOKENS.LlmRouter, new LlmRouter(settings));
  registry.register(TOKENS.ToolRegistry, new ToolRegistry());
  registry.register(TOKENS.RagService, new RagService(...));
  // ...

  // 4. 注册内置工具
  registerBuiltinTools(registry.get(TOKENS.ToolRegistry));

  // 5. 启动 auto-start MCP servers
  await mcpManager.startAutoStart();

  // 6. 注册 IPC handlers
  registerIpcHandlers(registry);

  // 7. 创建主窗口
  await createMainWindow();
}
```

---

## 6. 测试策略

### 6.1 测试层次

| 层 | 工具 | 覆盖目标 |
|---|---|---|
| 单元测试 | Vitest | core-* 包逻辑（核心算法、纯函数） |
| 集成测试 | Vitest + 真实 PG (docker) | RAG 索引、SQL 执行 |
| Agent 行为测试 | Vitest + LLM mock | 各种 prompt → tool call 路径 |
| E2E | Playwright (Electron) | 用户旅程 |

### 6.2 LLM Mock

测试 agent 行为时，不调真实 LLM：

```typescript
class MockLlmProvider implements ILlmProvider {
  scripted: ChatChunk[][];

  async *chatStream(req) {
    const next = this.scripted.shift();
    for (const chunk of next) yield chunk;
  }
}

// 在测试中编排：
const mock = new MockLlmProvider();
mock.scripted = [
  [{type: 'tool-call', data: { name: 'search_schema', args: { q: 'orders' } }}],
  [{type: 'text-delta', data: '上周销量最高的是...'}],
];
```

### 6.3 覆盖率目标

- core-* 包：≥ 70% line coverage
- UI：关键流程 E2E 覆盖即可
- IPC handlers：每个 channel 至少一个测试

---

## 7. IPC 设计

### 7.1 类型安全 IPC

定义契约 → 自动生成 wrapper：

```typescript
// packages/shared/src/ipc-contract.ts
export interface IpcContract {
  'settings:get': { req: void; res: UserSettings };
  'settings:update': { req: Partial<UserSettings>; res: UserSettings };
  // ...
}
```

主进程实现：
```typescript
ipcMain.handle('settings:get', async () => settings.getAll());
```

预加载暴露：
```typescript
contextBridge.exposeInMainWorld('api', {
  invoke: <K extends keyof IpcContract>(channel: K, req: IpcContract[K]['req']) =>
    ipcRenderer.invoke(channel, req) as Promise<IpcContract[K]['res']>,
});
```

渲染进程使用：
```typescript
const settings = await window.api.invoke('settings:get');
```

### 7.2 流式 IPC（Agent 输出）

Agent 输出通过 `ipcMain.send` 推送：

```typescript
// main → renderer
mainWindow.webContents.send('agent:event', { sessionId, event });
```

renderer 用 `ipcRenderer.on('agent:event', ...)` 订阅，写入 store。

---

## 8. 状态管理（Renderer）

### 8.1 Zustand Store 划分

```typescript
// apps/desktop/src/renderer/stores/

useSettingsStore       // 全局设置
useConnectionsStore    // 连接列表 + 当前连接
useSessionsStore       // 会话列表 + 当前会话
useChatStore           // 当前会话的消息流
useToolsStore          // 工具列表
usePlanStore           // 当前 plan 状态
useUiStore             // UI 状态（侧栏开合、主题等）
```

### 8.2 数据流

```
用户操作
  ↓
React 组件 → store action
  ↓
store action → window.api.invoke(...)
  ↓
主进程 IPC handler → 业务逻辑
  ↓
返回结果 → store 更新
  ↓
组件重渲染
```

流式数据：
```
主进程 service emit
  ↓
mainWindow.webContents.send('agent:event', ...)
  ↓
renderer ipcRenderer.on → useChatStore.appendDelta(...)
  ↓
组件订阅 store → 实时刷新
```

---

## 9. 安全实现要点

### 9.1 Electron 安全配置

```typescript
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,        // 必须
    nodeIntegration: false,        // 必须
    sandbox: true,                 // 推荐
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

### 9.2 CSP

主窗口 HTML 加严格 CSP：
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';">
```

LLM API 调用全部走主进程，不在 renderer 直接发请求。

### 9.3 密钥永不进 renderer

API key、DB 密码只在主进程内存中使用，renderer 只能通过 IPC 间接触发"使用"。

---

## 10. 打包与发布

### 10.1 electron-builder 配置

```yaml
appId: com.dbagent.app
productName: DBAgent
directories:
  output: dist
mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  notarize: true                # 上线前需 Apple ID
win:
  target: nsis
linux:
  target: AppImage
publish:
  provider: github              # 或自部署 update server
asar: true
files:
  - 'dist/**/*'
  - 'node_modules/**/*'
  - 'package.json'
extraResources:
  - from: 'resources/'
    to: 'resources/'
```

### 10.2 自动更新

- 用 `electron-updater`
- 通过 GitHub Releases 或自建 update server
- 每次启动检查 → 后台下载 → 用户确认重启

### 10.3 代码签名

- macOS：Apple Developer ID + Notarization（首次发布前申请）
- Windows：EV Code Signing Certificate（避免 SmartScreen 警告）
- Linux：可选 GPG 签名

### 10.4 平台支持矩阵

| 平台 | 最低版本 | 架构 |
|---|---|---|
| macOS | 11+ | Intel / Apple Silicon (universal) |
| Windows | 10+ | x64 |
| Linux | Ubuntu 20.04+ / 同等 | x64 |

---

## 11. 里程碑与任务清单

### 11.1 里程碑总览

> 每个里程碑都是**垂直切片**，端到端可运行，可 demo。

| 里程碑 | 主要交付 | 入口验收 |
|---|---|---|
| **M0** | 设计文档 + 仓库脚手架 | 文档齐备、`pnpm dev` 能起空窗口 |
| **M1** | PG 连接 + SQL 执行 + 结果展示 | 用户能连 PG 跑 SQL 看结果 |
| **M2** | RAG 索引 + 检索 + 简陋对话 | 用户能问 schema 问题 |
| **M3** | Agent loop + 内置工具 + 询问执行 | Demo 1 跑通（自然语言查数） |
| **M4** | MCP Client + Market 浏览/安装 | Demo 2 跑通（自定义工具调用） |
| **M5** | 子 Agent + Plan 视图 + Skill | Demo 3 跑通（多步分析） |
| **M6** | 多 LLM Provider + 配置面板完善 | Ollama / DeepSeek 切换 |
| **M7** | 打包 + 自动更新 + Beta 发布 | 安装包发给内测用户 |

### 11.2 M0 任务清单（可丢给 AI 编码代理执行）

- [ ] 初始化 monorepo（pnpm workspace + turbo）
- [ ] 配置 TS / ESLint / Prettier / EditorConfig
- [ ] 创建 `apps/desktop` 骨架（Electron + Vite + React）
- [ ] 创建 `packages/shared`，定义 IPC 契约空壳
- [ ] 创建 `packages/core-*` 各包骨架（package.json + 空 types）
- [ ] `pnpm dev` 能启动一个 Electron 空窗口，UI 显示 "Hello DBAgent"
- [ ] CI：GitHub Actions 跑 `pnpm typecheck && pnpm lint && pnpm test`

### 11.3 M1 任务清单

#### 后端（core-db + main）
- [ ] `packages/core-db/types.ts`：`IDatabaseDriver` 接口
- [ ] `packages/core-db/postgres/`：PG 实现（用 pg）
- [ ] 连接池管理（每个连接 pool，限制 maxClients）
- [ ] 连接 CRUD 持久化（写 connections.json + keychain）
- [ ] IPC：`connection:test/create/connect/disconnect/list`
- [ ] IPC：`db:execute-query`（执行任意 SQL，流式返回）

#### 用量与订阅骨架（详见 [10](./10-usage-and-subscription.md)）
- [ ] `packages/core-auth/`：登录/JWT/keychain 管理
- [ ] `packages/core-usage/`：本地用量记录器（SQLite）
- [ ] `packages/core-llm/router.ts`：BYOK / Subscription 双分支
- [ ] IPC：`auth:login / auth:logout / auth:status`
- [ ] IPC：`usage:current-quota / usage:history`

#### 后端服务（M1 最小版）
- [ ] Auth Service：注册、登录、邮箱验证、JWT 签发
- [ ] LLM Gateway 最小版：JWT 验证 + 转发 + 用量记录
- [ ] PostgreSQL：users / subscriptions / conversation_rounds 表

#### 前端
- [ ] 基础三栏布局
- [ ] 连接列表 + 新建连接对话框
- [ ] 简陋的 SQL 编辑器（Monaco）+ 执行按钮
- [ ] 结果表格（TanStack Table）
- [ ] 启动屏 + 登录界面 + BYOK 直接进入选项
- [ ] 顶部用量指示器（订阅模式显示配额，BYOK 显示 token 累计）

#### 测试
- [ ] core-db PG 集成测试（用 docker-compose 起 PG）
- [ ] E2E：连接 + 查询 + 结果显示
- [ ] E2E：登录 + LLM 调用 + 用量记录

### 11.4 M2 任务清单

- [ ] `packages/core-rag/extractors/postgres.ts`：schema 提取
- [ ] sqlite-vec 集成（packages/core-rag/storage）
- [ ] embedding provider 抽象 + OpenAI 兼容实现
- [ ] BGE-M3 本地推理集成（@huggingface/transformers）
- [ ] indexer：批量构建索引
- [ ] retriever：向量 + FTS + RRF 融合
- [ ] context builder：组装 prompt 友好的上下文
- [ ] IPC：`rag:rebuild / rag:status / rag:search`
- [ ] UI：Schema 树（右侧栏）+ 索引进度
- [ ] 简陋对话：直接把 RAG 结果 + 用户问题塞 LLM 出答案（还不是完整 agent）

### 11.5 M3 任务清单

- [ ] `packages/core-agent/loop.ts`：核心 ReAct loop
- [ ] `packages/core-agent/permission.ts`：询问/审批
- [ ] `packages/core-agent/strategies/react.ts`
- [ ] `packages/core-tools/builtin/`：query_database, search_schema, describe_table, explain_sql
- [ ] SQL 预审（解析 + EXPLAIN + 危险等级）
- [ ] IPC：`agent:run / agent:abort / agent:event`（流式）
- [ ] UI：对话窗 + 流式渲染 + SQL 卡片 + 工具卡片 + 询问对话框
- [ ] UI：Agent 模式切换（顶部栏）
- [ ] UI：会话管理（新建/切换/重命名/删除）

### 11.6 M4 任务清单

- [ ] MCP Client（@modelcontextprotocol/sdk）
- [ ] MCP Server 进程管理（启动/重启/停止）
- [ ] MCP 工具适配为 ITool 注册到 ToolRegistry
- [ ] mcp.json 持久化
- [ ] IPC：`mcp:list / mcp:install / mcp:start / mcp:stop`
- [ ] UI：Tools 面板（右侧栏）
- [ ] Smithery API 对接（IMcpMarket）
- [ ] UI：MCP Market 浏览 + 安装流程

### 11.7 M5 任务清单

- [ ] `packages/core-agent/strategies/plan-execute.ts`
- [ ] `packages/core-agent/subagent.ts`：spawn_subagents 工具实现
- [ ] Plan 数据模型 + 持久化
- [ ] UI：Plan 面板（右侧栏）+ 子 agent 状态
- [ ] `packages/core-skills/`：Skill yaml schema + loader + executor
- [ ] UI：Skills 设置页 + 触发方式（slash command）

### 11.8 M6 任务清单

- [ ] LLM Provider 抽象完善（已在 M3 部分实现）
- [ ] 各 Provider 适配（OpenAI / Anthropic / 智谱 / Moonshot / Ollama / vLLM）
- [ ] Provider 模板预置 + 自定义添加
- [ ] Ollama 模型自动检测
- [ ] 完整设置面板（按 04-config-design §5.2）
- [ ] 配置导入/导出
- [ ] 凭证 keychain 完整迁移

### 11.9 M7 任务清单

- [ ] electron-builder 配置
- [ ] 代码签名（macOS / Windows）
- [ ] 自动更新（electron-updater）
- [ ] 崩溃报告（可选 Sentry）
- [ ] 用户引导（onboarding tour）
- [ ] 文档 site（docs.dbagent.com）
- [ ] 内测招募 + 反馈收集

---

## 12. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Vercel AI SDK 对国产模型 tool calling 兼容差 | 中 | 高 | 提前用 DeepSeek 跑通示例，必要时自实现 OpenAI 兼容 adapter |
| sqlite-vec Electron 打包问题 | 中 | 中 | 调研 prebuild，准备 LanceDB 备选 |
| 本地 BGE-M3 性能（CPU 慢） | 高 | 中 | 默认提供 OpenAI 兼容云端 embedding 选项；GPU 检测自动启用 |
| MCP server 启动失败导致 UI 卡 | 中 | 中 | 异步启动 + 超时 + 状态展示 |
| AI 编码团队无法理解大型架构 | 中 | 高 | 把每个模块 PR 拆小，单 PR ≤ 500 行；先骨架后填充 |
| 单干维护负担 | 高 | 中 | 严格收敛功能；MVP 不做花里胡哨 |
| 国内模型质量不足以支撑 agent | 中 | 高 | 设计回退到 Claude/GPT；MVP 阶段以 DeepSeek 主推 + Claude 兜底 |

---

## 13. 性能基线

| 指标 | 目标 | 测量方法 |
|---|---|---|
| 应用冷启动 | < 3 秒 | electron-builder 构建后冷启 |
| 主窗口首屏 | < 1 秒 | 渲染完成时间 |
| SQL 执行（10 行结果） | < 500ms（不含 DB） | 工具内置计时 |
| RAG 检索（top-20） | < 100ms | benchmark 脚本 |
| Agent 简单查询端到端 | < 3 秒 | 开发期间手动 + 自动测量 |
| 内存占用（空闲） | < 400MB | 进程监控 |
| 内存占用（活跃 + RAG） | < 1GB | - |
| 安装包大小 | < 200MB | electron-builder 输出 |

---

## 14. 文档维护

- 所有架构变更需更新对应 `docs/0X-*.md`
- 重大决策记入 `docs/adr/NNNN-title.md`（[ADR](https://adr.github.io/) 格式）
- 每个里程碑结束 review 一次文档与代码偏差，必要时调整文档
- API 变更需在变更前更新 `IpcContract` 类型，触发全仓库类型错误，强制更新调用方

---

## 15. 协作流程（与 AI 编码代理）

### 15.1 任务粒度

- 每个 PR 单一职责，建议 < 500 行
- 复杂模块拆成"先骨架 PR + 多个填充 PR"
- 每个 PR 关联一个 GitHub Issue / Linear ticket

### 15.2 给 AI agent 的标准 Prompt 模板

```
## 任务
[简短描述]

## 上下文
- 关联设计文档：[链接]
- 关联代码：[路径]

## 输入
- [现状 / 已有代码片段]

## 输出要求
- 实现 / 修改文件：[列表]
- 必须通过的测试：[列表]
- 必须遵循的约定：[规范文档链接]

## 验收
- [ ] 类型检查通过
- [ ] 单元测试通过
- [ ] Lint 通过
- [ ] 关键边界情况已处理
```

### 15.3 代码审查 checklist

不论是 AI 还是人类提交的代码，合并前 review：

- [ ] 类型 strict，没有 `any`（或有合理注释）
- [ ] 无 `console.log` 残留（用 logger）
- [ ] 错误处理完整（catch 不吞错）
- [ ] 异步代码无未处理的 promise
- [ ] IPC 契约更新（如涉及）
- [ ] 文档同步更新（如涉及架构）
- [ ] 测试覆盖关键路径
- [ ] 无明显性能问题（如 N+1 query）
- [ ] 安全：无敏感数据落 renderer

---

## 16. 词汇表

| 术语 | 含义 |
|---|---|
| Agent | 能自主决策与执行的智能体 |
| Agent Loop | ReAct 循环，思考-行动-观察 |
| Tool | Agent 可调用的能力单元 |
| Skill | 命名好的、可复用的任务流程 |
| MCP | Model Context Protocol，Anthropic 提出的工具协议 |
| RAG | Retrieval-Augmented Generation，检索增强生成 |
| Schema RAG | 针对数据库 schema 的结构化 RAG |
| Session | 单次对话上下文 |
| Sub-Agent | 主 Agent spawn 出的子 Agent，并行执行子任务 |
| Provider | LLM/Embedding 的提供者抽象 |
| 询问模式 | 默认 Agent 模式，所有写操作和高危工具调用前确认 |
| 自动模式 | SELECT 自动执行，写操作仍需确认 |
| 完全自动 | 所有操作自动执行（除"硬危险清单"） |
| 只读模式 | 仅允许 SELECT，禁止写操作 |

---

## 17. 后续工作

设计阶段（M0）完成后，推荐顺序：

1. 搭建 monorepo 脚手架（M0 任务清单）
2. 跑通 M1 端到端 demo（连 PG + 跑 SQL）
3. 在真实 PG（含一定数据量）上跑 M2 RAG，验证检索质量
4. 提前用 DeepSeek 验证 tool calling 在我们的 schema 下表现
5. M3 上线前跑通 Demo 1，邀请 5-10 个真实数据工程师试用
6. 根据反馈调整后续里程碑优先级

---

## 附录 A：关键文件路径速查

```
~/.dbagent/                          # 用户数据
├── settings.json                    # 全局设置
├── connections.json                 # DB 连接元信息
├── mcp.json                         # MCP server 配置
├── account.json                     # 登录账号
├── sessions.db                      # 会话历史
├── rag/{connectionId}.db            # 每连接的 RAG
├── skills/{name}.yaml               # 用户 Skills
├── logs/agent-{date}.jsonl          # 审计日志
└── backups/                         # 配置备份

OS Keychain                          # 敏感凭证
├── com.dbagent.app:conn:{id}:password
├── com.dbagent.app:llm:{id}:api_key
└── com.dbagent.app:mcp:{id}:env:{var}
```

## 附录 B：常用命令

```bash
# 开发
pnpm dev                             # 启动开发模式
pnpm dev:main                        # 仅主进程
pnpm dev:renderer                    # 仅渲染进程

# 测试
pnpm test                            # 全部测试
pnpm test:unit                       # 单元测试
pnpm test:e2e                        # E2E
pnpm test:watch                      # 监听模式

# 质量
pnpm typecheck                       # TS 类型检查
pnpm lint                            # ESLint
pnpm lint:fix                        # 自动修复
pnpm format                          # Prettier

# 构建
pnpm build                           # 构建所有包
pnpm package                         # 打包当前平台
pnpm package:mac                     # macOS
pnpm package:win                     # Windows
pnpm package:linux                   # Linux

# 工具
pnpm db:up                           # 起测试 PG
pnpm db:down                         # 关测试 PG
pnpm clean                           # 清理 dist / node_modules
```
