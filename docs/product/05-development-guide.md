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

### 5.0 开源组件与现有能力优先原则

正式开发阶段默认遵循“优先复用成熟能力，再决定自研”的原则：

- 前端界面、IDE 交互、表格、编辑器、终端、图标、弹窗、拖拽、虚拟列表、代码高亮等通用能力，优先评估成熟开源库或现有组件。
- 数据库驱动、连接池、SQL 解析、结果表格、文件树、Python 环境探测、打包安装器等基础能力，优先使用社区验证充分、维护活跃、许可证清晰的方案。
- 只有在安全边界、性能瓶颈、产品核心差异化、许可证不兼容或现有库无法满足业务约束时，才自研实现。
- 引入新依赖前必须记录用途、许可证、打包影响、离线安装影响、Windows/Linux 兼容性和替代方案。
- UI 视觉素材、图标和组件应优先复用现有设计系统或开源资源，并保持 DBAgent 自身的信息架构与品牌风格，不做简单照搬。
- 测试中要覆盖第三方组件的关键集成路径，避免“库可用但产品链路不可用”。

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

### 6.1 核心原则

> **不用 LLM Mock。Agent 和 RAG 的测试必须用真实 API key + 真实数据库。**

**为什么不 mock**：
- LLM 行为非确定，mock 测的是"我们假设 LLM 会怎么响应"，不是"LLM 真的怎么响应"
- Agent loop 的真正风险来自**真实 LLM 的不稳定**：tool calling 失败、参数格式偏差、思维跳跃 —— 这些 mock 都测不出来
- RAG 检索质量依赖真实 embedding 模型 + 真实 schema，mock 检索结果毫无意义
- 我们是单干 + AI 编码代理，没必要为了"测试速度"维护两套 LLM 行为定义

**真实测试的代价我们能承担**：
- 每次 CI 跑一遍 agent E2E ≈ 几毛钱（DeepSeek 价格）
- 时间慢一点（10-30 秒/case）但每天就跑几十次，能接受
- 跨地域 / 网络波动是 CI 配置问题，不是不测的理由

### 6.2 测试层次

| 层 | 工具 | 覆盖目标 | 是否真实依赖 |
|---|---|---|---|
| 单元测试 | Vitest | 纯函数、算法、数据转换 | 否 |
| 集成测试 | Vitest + Docker PG | RAG 索引、SQL 执行、连接池 | **真实 PG** |
| RAG 检索测试 | Vitest + 真实 embedding | 检索质量、排序、图扩展 | **真实 embedding API** |
| Agent 行为测试 | Vitest + 真实 LLM | tool calling、多轮决策、错误恢复 | **真实 LLM API** |
| E2E | Playwright (Electron) | 用户旅程、UI 交互 | **真实 LLM + PG** |

### 6.3 测试用 LLM 与 Embedding 配置

#### 6.3.1 多模型矩阵测试

每个 Agent 和 RAG 测试都对 **多个模型**跑一遍：

| 用途 | 主测模型 | 兼容性测试模型 |
|---|---|---|
| Agent 主对话 | DeepSeek-V3（默认推荐） | Claude Sonnet 4、GPT-4o-mini |
| Embedding | BGE-M3（本地） | OpenAI text-embedding-3-small |

**理由**：
- DeepSeek 是默认推荐，必须重点保证
- Claude / GPT 跑通保证我们的 prompt 不锁死某个模型
- 不同模型的 tool calling 表现差异大，必须真测

#### 6.3.2 测试环境的 API key 管理

```bash
# .env.test （不入版本控制）
TEST_DEEPSEEK_API_KEY=sk-xxx
TEST_OPENAI_API_KEY=sk-xxx
TEST_ANTHROPIC_API_KEY=sk-ant-xxx
TEST_OLLAMA_ENDPOINT=http://localhost:11434/v1   # 可选：本地模型对照
```

**CI 环境**：用 GitHub Secrets 注入，限制：
- 仅 `main` 分支和受信任的 PR 跑（防止 fork PR 偷 key）
- 单次 PR 测试预算上限 ¥10（超过就告警）
- 用专门的低额度测试 key（限速 / 月配额）

### 6.4 测试数据集

#### 6.4.1 标准测试数据库

`scripts/test-fixtures/` 提供可重复构造的测试 PG：

```
test-fixtures/
├── 00-schema.sql              # DDL（10-20 张表，覆盖典型业务模式）
├── 01-seed-small.sql          # 1 万行小数据集（CI 用）
├── 02-seed-large.sql          # 100 万行大数据集（性能测试用）
├── 03-comments.sql            # 字段注释（含中文）
└── README.md                  # schema 说明
```

业务模式覆盖：
- 用户 / 订单 / 商品（电商核心三表 + 多对多）
- 含**加密字段**（phone_enc BYTEA + 注释标注）
- 含**软删除**（deleted_at）
- 含 **JSON 字段**（user_metadata JSONB）
- 含**枚举**和**外键级联**
- 一张**故意写得糟糕**的表（无主键、列名缩写）测 RAG/Agent 的鲁棒性

#### 6.4.2 任务清单（manual-cases.md）

`tests/manual-cases.md` 维护一份**真实任务清单**，每条对应一次 Agent 行为测试：

```markdown
## TC-001: 简单查询
**Prompt**: 列出 users 表前 10 条记录
**期望**:
  - 调用 search_schema 或 describe_table（任一）
  - 生成 SELECT * FROM users LIMIT 10
  - 询问模式下出现确认弹窗
**通过模型**: deepseek-v3 ✓ / claude-sonnet ✓ / gpt-4o-mini ✓

## TC-002: 复杂 JOIN
**Prompt**: 上周下单超过 3 次的用户的邮箱
**期望**:
  - 至少检索 users + orders 两表
  - 生成含 GROUP BY + HAVING 的 SQL
  - 时间过滤正确

## TC-003: 加密字段
**Prompt**: 按城市统计用户注册数（city 在加密的 phone_enc 里）
**期望**:
  - 识别 phone_enc 是加密字段
  - 主动询问用户是否有 decrypt_phone 工具 / Skill
  - 不要硬编码假设解密逻辑

## TC-004: 危险操作
**Prompt**: 把 status='inactive' 的用户全删了
**期望**:
  - 询问模式下绝不直接执行
  - SQL 卡片显示影响行数预估
  - 危险等级 high

... (30-50 条覆盖各种场景)
```

#### 6.4.3 这份清单既是测试也是产品规范

- 自动化部分进 `tests/agent-e2e/` 跑 CI
- 手动验收部分作为 release 前 checklist
- 用户报 bug 时新增 case，避免回归

### 6.5 RAG 检索质量测试

```typescript
// tests/rag-quality.test.ts
import { describe, it, expect } from 'vitest';

describe('RAG retrieval quality', () => {
  beforeAll(async () => {
    await buildRagIndex(testConnectionId);  // 用真实 embedding
  });

  const cases = [
    { query: '订单', mustInclude: ['orders', 'order_items'] },
    { query: '用户邮箱',  mustInclude: ['users.email'] },
    { query: '退款',  mustInclude: ['refunds', 'orders.refund_status'] },
    { query: '上周销量', mustInclude: ['orders', 'products', 'order_items'] },
  ];

  for (const c of cases) {
    it(`retrieves correct tables for "${c.query}"`, async () => {
      const result = await retriever.retrieve({ text: c.query, topK: 10 });
      const ids = result.tables.map(t => t.id).concat(result.columns.map(c => c.id));
      for (const must of c.mustInclude) {
        expect(ids.some(id => id.includes(must))).toBe(true);
      }
    });
  }
});
```

**评估指标**（手动观察，不卡死阈值）：
- 必含项命中率（must include hit rate）
- 噪声项（不相关的表占比）
- 排序合理性（关键表是否在前 5）

### 6.6 Agent 行为测试

```typescript
// tests/agent-behavior.test.ts
import { describe, it, expect } from 'vitest';

const MODELS_TO_TEST = ['deepseek:deepseek-chat', 'anthropic:claude-sonnet-4'];

describe.each(MODELS_TO_TEST)('Agent behavior with %s', (modelRef) => {
  it('TC-001: simple query generates SELECT with LIMIT', async () => {
    const session = await createTestSession({ modelRef, mode: 'auto' });
    const result = await runAgent(session, '列出 users 表前 10 条记录');

    // 检查行为而非具体文本
    expect(result.toolCalls).toContainEqual(
      expect.objectContaining({ name: expect.stringMatching(/search_schema|describe_table|query_database/) })
    );

    const sqlCall = result.toolCalls.find(c => c.name === 'query_database');
    expect(sqlCall.args.sql.toUpperCase()).toMatch(/SELECT.*FROM\s+USERS/);
    expect(sqlCall.args.sql.toUpperCase()).toMatch(/LIMIT\s+10/);
  });

  it('TC-004: danger operation blocked in ask mode', async () => {
    const session = await createTestSession({ modelRef, mode: 'ask' });

    let approvalCalled = false;
    session.onApprovalNeeded = (req) => {
      approvalCalled = true;
      return { approved: false };  // 拒绝
    };

    const result = await runAgent(session, "DELETE FROM users WHERE status = 'inactive'");
    expect(approvalCalled).toBe(true);
    expect(result.executedWrites).toEqual([]);  // 没真执行
  });
});
```

**断言原则**：
- **断言行为，不断言文字**：检查"是否调了 search_schema"，不检查"agent 说了什么"
- **断言结构，不断言精确 SQL**：用正则匹配关键模式，不写死 SQL 字符串
- **接受多种合理路径**：模型 A 可能先 `search_schema`，模型 B 直接 `query_database`，都可
- **明确"不应该做什么"**：TC-004 这种侧重"没有越权"

### 6.7 测试预算与频率

| 测试类型 | 何时跑 | 单次预算 | 时长 |
|---|---|---|---|
| 单元测试 | 每次提交 / pre-commit | ¥0 | < 10s |
| 集成测试（Docker PG） | 每次 PR | ¥0 | < 1min |
| RAG 检索测试 | 每次 PR（限主分支或 trigger 标签）| ~¥0.5 | < 2min |
| Agent E2E（DeepSeek 单模型）| 每次 PR | ~¥1 | 3-5min |
| Agent E2E（多模型矩阵）| 每天 nightly | ~¥10 | 10-20min |
| Playwright UI E2E | 每次 PR | ~¥1 | 5min |
| 完整发布前 checklist | release 候选 | ~¥30 | 30min |

> CI 上配置预算监控，超额自动暂停。

### 6.8 covering 与不 covering

#### 6.8.1 必测

- 所有内置工具的真实调用（query_database 真连 PG、search_schema 真用 RAG）
- Agent loop 的关键决策路径（TC-001 ~ TC-050）
- 询问/自动/只读三种模式的权限边界
- SQL 预审（DELETE/DROP 必须被拦截）
- 多模型兼容性（每个推荐模型至少跑核心 5 个 case）

#### 6.8.2 不测

- ❌ LLM 输出的具体文字
- ❌ 不同模型谁更"聪明"
- ❌ Token 用量精确数值（只测"是否记录了" / "是否在合理量级"）
- ❌ MCP server 内部实现（信任协议）
- ❌ Electron 自身（信任框架）

### 6.9 覆盖率目标

- core-* 包（纯逻辑）：≥ 70% line coverage
- Agent / RAG：以**任务清单覆盖率**为准（不追求 line coverage）
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

- [ ] `packages/core-rag/extractors/postgres.ts`：schema 提取（支持 skeleton-only 模式）
- [ ] sqlite-vec 集成（packages/core-rag/storage）
- [ ] embedding provider 抽象 + OpenAI 兼容实现
- [ ] BGE-M3 本地推理集成（@huggingface/transformers）
- [ ] **渐进式 indexer（详见 [02 §5.5](./02-rag-design.md)）**：
  - [ ] Stage 1：仅表名 + 注释 + FTS（5-30 秒）
  - [ ] Stage 2：top 100 热表（按 pg_stat_user_tables 排序）+ 向量
  - [ ] Stage 3：长尾后台索引（让出 CPU、用户活跃时延迟）
  - [ ] On-demand 索引：用户引用未索引表时即时索引
- [ ] retriever：向量 + FTS + RRF 融合（各阶段表现不同）
- [ ] context builder：组装 prompt 友好的上下文
- [ ] **断开连接清除 RAG**（详见 [02 §5.7](./02-rag-design.md)）
- [ ] IPC：`rag:rebuild / rag:status / rag:search` + `rag:stage-progress`（流式）
- [ ] UI：Schema 树（右侧栏）+ 三阶段索引进度
- [ ] UI：底部 RAG 状态指示器（详见 [01 §2.4.1](./01-ui-design.md)）
- [ ] 简陋对话：直接把 RAG 结果 + 用户问题塞 LLM 出答案（还不是完整 agent）

### 11.5 M3 任务清单

#### Agent 核心
- [ ] `packages/core-agent/loop.ts`：核心 ReAct loop
- [ ] `packages/core-agent/permission.ts`：询问/审批
- [ ] `packages/core-agent/strategies/react.ts`
- [ ] **`packages/core-agent/context-manager.ts`：Token 计数 + 渐进压缩**（详见 [03 §9.2](./03-agent-design.md)）
  - [ ] tiktoken / js-tiktoken 集成做 token 估算
  - [ ] Level 1-4 压缩策略实现
  - [ ] 撤销窗口（5 分钟）
  - [ ] 压缩用便宜模型（不计入用户配额）
- [ ] SQL 预审（解析 + EXPLAIN + 危险等级）
- [ ] IPC：`agent:run / agent:abort / agent:event`（流式）+ `agent:compressed`

#### 内置工具（详见 [03 §5.2](./03-agent-design.md#52-内置工具清单开箱即用)）
- [ ] `packages/core-tools/builtin/db/`：search_schema, describe_table, list_tables, list_schemas, get_relations, query_database, execute_sql, explain_sql, dry_run_sql, get_sample_rows, read_query_history
- [ ] `packages/core-tools/builtin/workspace/`：read/write/edit/delete/list/glob/grep（依赖 workspace 模块，M3 可先做基础）
- [ ] `packages/core-tools/builtin/shell/`：run_shell_command（含白/黑名单 + 询问拦截）
- [ ] `packages/core-tools/builtin/web/`：web_fetch（基础）

#### UI
- [ ] 对话窗 + 流式渲染 + SQL 卡片 + 工具卡片 + 询问对话框
- [ ] Agent 模式切换（顶部栏）
- [ ] 会话管理（新建/切换/重命名/删除）
- [ ] Shell 命令的"展开预览"卡片
- [ ] **底部 Token 占比指示器**（详见 [01 §2.4.2](./01-ui-design.md)）：彩色条 + 占用分布弹窗 + 立即压缩 / 撤销 / 调整预算

### 11.6 M4 任务清单

#### MCP Client
- [ ] MCP Client（@modelcontextprotocol/sdk）
- [ ] MCP Server 进程管理（启动/重启/停止）
- [ ] MCP 工具适配为 ITool 注册到 ToolRegistry
- [ ] mcp.json 持久化
- [ ] IPC：`mcp:list / mcp:install / mcp:start / mcp:stop`

#### 默认内置 MCP（详见 [03 §5.3](./03-agent-design.md#53-默认安装的-mcp-server开箱即用)）
- [ ] 默认 mcp.json 预置 builtin-memory / builtin-time / builtin-fetch（按需启动）
- [ ] npx 拉取首次启动 + 国内镜像开关
- [ ] 失败兜底：禁用 MCP 仍可用基础工具

#### Market
- [ ] Smithery API 对接（IMcpMarket）
- [ ] UI：Tools 面板（右侧栏）
- [ ] UI：MCP Market 浏览 + 安装流程

### 11.7 M5 任务清单

#### Agent 高级策略
- [ ] `packages/core-agent/strategies/plan-execute.ts`
- [ ] `packages/core-agent/subagent.ts`：spawn_subagents 工具实现
- [ ] Plan 数据模型 + 持久化
- [ ] UI：Plan 面板（右侧栏）+ 子 agent 状态

#### Skill 系统
- [ ] `packages/core-skills/`：Skill yaml schema + loader + executor
- [ ] 内置 Skill 四件套（详见 [03 §6.4](./03-agent-design.md#64-内置-skill-清单开箱即用)）：
  - [ ] `resources/skills/generate-schema-doc.yaml`
  - [ ] `resources/skills/generate-er-diagram.yaml`
  - [ ] `resources/skills/optimize-sql.yaml`
  - [ ] `resources/skills/data-analysis.yaml` ★ 核心：指导 Agent 写 Python 脚本
- [ ] Skill `auto_inject_when` 机制（让 data_analysis 在合适场景自动激活）
- [ ] save_session_as_skill 工具
- [ ] UI：Skills 设置页 + 触发方式（slash command + 命令面板）

#### 工作空间 + Python
- [ ] `packages/core-workspace/`：workspace 创建/打开/切换
- [ ] **多连接管理**（详见 [08 §2.6](./08-workspace-design.md)）：
  - [ ] WorkspaceConnection 数据模型（关联多连接）
  - [ ] 三状态（disconnected / connecting / active）
  - [ ] 激活 / 断开 / 取消关联三种操作
  - [ ] 断开时自动清除该连接 RAG（呼应 M2）
  - [ ] UI：左侧连接面板支持多连接 + 状态颜色点
  - [ ] SQL 编辑器顶部连接选择器（支持临时切到其他已激活连接）
- [ ] **SQL 库**（详见 [08 §2.3](./08-workspace-design.md) sql/ 目录）：
  - [ ] SQL 文件 frontmatter 注释解析（@name / @description / @params / @tags / @connection）
  - [ ] 命令面板搜索 SQL（按 name/tags）
  - [ ] `:param` 参数化执行（运行时弹窗输入）
  - [ ] `_drafts/` 不进 RAG / Agent 上下文
- [ ] Python Runtime 检测 + venv 管理（uv 优先）
- [ ] 工作空间模板：minimal / standard / full / ml / dl / rl（详见 [08 §4.6.4](./08-workspace-design.md)）
- [ ] `dbagent-sdk` Python 包（详见 [08 §4.6.5](./08-workspace-design.md)）
  - [ ] `db.query / query_stream / engine / connection`
  - [ ] `save / load`（按扩展名分发：csv/parquet/json/yaml/pkl/pt/png/...）
  - [ ] `workspace.print / show_image / show_dataframe / show_markdown / progress / ask_user`
  - [ ] `workspace.call_tool / list_tools`
  - [ ] sys.path 自动注入 workspace 根，支持 `from scripts.xxx import yyy`
- [ ] 内置工具：run_python_script, python_repl, install_python_deps
- [ ] 工作空间脚本注册为 Tool 的机制（解析 `@tool` docstring）
- [ ] UI：工作空间侧栏 + Python 编辑器 Tab + 运行输出（含图片/表格/进度条渲染）

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
