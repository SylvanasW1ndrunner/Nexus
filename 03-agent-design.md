# 03 - Agent 设计（Agent Engine）

> 文档版本：v0.1
> 关联：[00-overview.md](./00-overview.md), [02-rag-design.md](./02-rag-design.md)

---

## 1. Agent 设计哲学

### 1.1 核心理念

> **Agent 不是"更智能的 Text2SQL"，而是能自主完成任务的工程师助手。**

参考 Claude Code 和 Codex，我们追求的不是"生成一条 SQL"，而是：
- **理解任务**（可能比用户表述的更深）
- **拆解步骤**（必要时拆成子任务并行）
- **调用工具**（SQL、MCP、Skill）
- **观察结果**（基于结果调整下一步）
- **汇报产出**（不只是数据，是结论）

### 1.2 设计原则

1. **工具优于参数**：能用 tool 完成的不要塞 prompt（如 schema 走 RAG tool 而非全量 prompt）
2. **可观测性优先**：每一步思考、调用、决策都暴露给用户
3. **用户掌控**：随时可中止、可纠正、可切换模式
4. **成本可控**：每个会话有 token 预算和迭代上限
5. **失败优雅**：工具失败、SQL 报错时自动重试 + 上下文修正
6. **模块可插拔**：策略层（ReAct/Plan）、工具层、模型层都可替换

---

## 2. 整体架构

### 2.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                          Agent Engine                             │
│                                                                   │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │                    Agent Orchestrator                     │   │
│   │  - 接收用户消息                                           │   │
│   │  - 选择执行策略（ReAct / Plan-Execute / 子 Agent）        │   │
│   │  - 协调 Session / Memory / Permission                     │   │
│   └──────────────┬─────────────────────────────┬─────────────┘   │
│                  │                             │                  │
│         ┌────────▼────────┐          ┌─────────▼────────┐         │
│         │ Strategy Layer  │          │ Sub-Agent Pool   │         │
│         │ - ReAct         │          │ - 并行执行        │         │
│         │ - Plan&Execute  │          │ - 结果汇总        │         │
│         │ - Reflexion     │          │ - Token 隔离      │         │
│         └────────┬────────┘          └─────────┬────────┘         │
│                  │                             │                  │
│                  └──────────────┬──────────────┘                  │
│                                 │                                 │
│                ┌────────────────▼────────────────┐                │
│                │       Agent Loop (Core)         │                │
│                │   while not done:                │                │
│                │     thought = model.think(ctx)  │                │
│                │     action = model.act(thought) │                │
│                │     if needs_approval: ask_user │                │
│                │     observation = execute(act)  │                │
│                │     ctx.append(observation)     │                │
│                └────────────────┬────────────────┘                │
│                                 │                                 │
│      ┌──────────────┬──────────┼──────────┬──────────────┐        │
│      ▼              ▼          ▼          ▼              ▼        │
│  ┌────────┐   ┌──────────┐ ┌──────┐ ┌──────────┐  ┌──────────┐   │
│  │ LLM    │   │ Tool     │ │ RAG  │ │ Permission│  │ Session  │   │
│  │ Router │   │ Registry │ │ Svc  │ │ Manager  │  │ / Memory │   │
│  └────────┘   └────┬─────┘ └──────┘ └──────────┘  └──────────┘   │
│                    │                                              │
│         ┌──────────┼──────────┬─────────────┐                     │
│         ▼          ▼          ▼             ▼                     │
│      Built-in   User MCP   Market MCP    Skills                  │
│      Tools     Servers    Servers                                │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 模块清单

| 模块 | 职责 | 文件位置（建议） |
|---|---|---|
| Agent Orchestrator | 入口，决定执行策略 | `src/main/agent/orchestrator.ts` |
| Strategy Layer | 各种 agent 执行模式 | `src/main/agent/strategies/` |
| Agent Loop | 核心 ReAct 循环 | `src/main/agent/loop.ts` |
| LLM Router | 模型选择与调用 | `src/main/llm/router.ts` |
| Tool Registry | 工具注册中心 | `src/main/tools/registry.ts` |
| Permission Manager | 询问/审批 | `src/main/agent/permission.ts` |
| Session Manager | 会话状态、消息历史 | `src/main/agent/session.ts` |
| Memory | 短期/长期记忆 | `src/main/agent/memory.ts` |
| Sub-Agent Pool | 并行子 agent | `src/main/agent/subagent.ts` |
| Skill Registry | Skill 系统 | `src/main/agent/skills.ts` |
| Usage Tracker | 用量记录与配额检查 | `packages/core-usage/` (详见 [10](./10-usage-and-subscription.md)) |

> **重要**：Agent Loop 在每轮开始时**必须**调用 `usageTracker.startConversationRound()`，并在结束时记录用量；订阅模式下还需先 `getCurrentQuota()` 检查是否超额。详见 [10 §6.2](./10-usage-and-subscription.md)。

---

## 3. Agent Loop（核心循环）

### 3.1 ReAct 范式

我们的核心循环基于 **ReAct (Reason + Act)** 范式，结合 tool calling：

```
┌─────────────────────────────────────────────────┐
│  User Message                                    │
└────────────────────┬─────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  Build Context         │
        │  - System prompt       │
        │  - History             │
        │  - Tool definitions    │
        │  - RAG snippet         │
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  LLM Generate          │  ← 流式输出
        │  - thinking text       │
        │  - tool_calls?         │
        └────────────┬───────────┘
                     │
              has tool_calls?
                ┌────┴────┐
              No│         │Yes
                │         ▼
                │   ┌──────────────────┐
                │   │ For each call:   │
                │   │  Permission?     │  ← 询问模式拦截
                │   │  Execute tool    │
                │   │  Append result   │
                │   └────────┬─────────┘
                │            │
                │            └─────────┐
                │                      │
                ▼                      │
        ┌────────────────┐             │
        │ Output to user │             │
        └────────┬───────┘             │
                 │                     │
                 │   ◄─────────────────┘
                 ▼
              [Done]
```

### 3.2 核心循环代码示意

```typescript
// src/main/agent/loop.ts

export async function runAgentLoop(
  session: Session,
  userMessage: string,
  options: AgentOptions
): Promise<AgentResult> {
  session.appendUserMessage(userMessage);

  let iteration = 0;
  const maxIterations = options.maxIterations ?? 25;

  while (iteration++ < maxIterations) {
    // 1. 构造上下文
    const context = await buildContext(session, options);

    // 2. 调用 LLM（流式）
    const response = await llmRouter.stream({
      model: options.model,
      messages: context.messages,
      tools: context.tools,
      onTextDelta: (delta) => session.streamText(delta),
      onToolCallStart: (call) => session.streamToolCallStart(call),
    });

    // 3. 没有 tool 调用 → 收尾
    if (!response.toolCalls || response.toolCalls.length === 0) {
      session.appendAssistantMessage(response.text);
      return { status: 'done', message: response.text };
    }

    // 4. 处理 tool 调用（可能并行）
    const toolResults = await Promise.all(
      response.toolCalls.map(async (call) => {
        // 4.1 权限检查
        const permission = await permissionManager.check(call, session);
        if (permission.status === 'denied') {
          return { call, result: { error: 'denied by user' } };
        }

        // 4.2 执行工具
        try {
          const result = await toolRegistry.execute(call, session.context);
          return { call, result };
        } catch (e) {
          return { call, result: { error: serializeError(e) } };
        }
      })
    );

    // 5. 把 tool 结果写入 context，继续循环
    session.appendToolResults(toolResults);

    // 6. 用户中止？
    if (session.isAborted()) {
      return { status: 'aborted' };
    }

    // 7. Token / 成本预算检查
    if (session.tokenUsage > options.tokenBudget) {
      return { status: 'budget_exceeded' };
    }
  }

  return { status: 'max_iterations_reached' };
}
```

### 3.3 关键决策点

#### 3.3.1 何时退出循环
- LLM 不再调用工具
- 用户中止（点击 Stop）
- 达到最大迭代次数（默认 25）
- Token 预算耗尽
- 严重错误（连续 3 次工具失败）

#### 3.3.2 工具并行
LLM 可以一次返回多个 tool_call，我们**并行执行**它们以提升效率。但：
- 写操作不并行（有副作用）
- 询问模式下，所有写操作仍然串行确认

#### 3.3.3 错误恢复
- 工具失败 → 错误信息回传给 LLM，让它决定怎么处理
- SQL 语法错误 → 自动调用 `explain_error` tool 帮助 LLM 理解
- 连续失败 3 次 → 主动中断，告诉用户"我无法完成，请人工介入"

---

## 4. 执行策略（Strategy Layer）

不同任务用不同策略。Strategy 是可插拔的。

### 4.1 策略对比

| 策略 | 适用场景 | 特点 |
|---|---|---|
| **ReAct (默认)** | 大部分查询 | 简单、低延迟 |
| **Plan & Execute** | 复杂分析任务 | 先出 plan，再执行 |
| **Reflexion** | 失败后重试 | 自我反思后再尝试 |
| **Sub-Agent Parallel** | 可并行的多任务 | 主 agent 拆分，子 agent 并行 |

### 4.2 策略选择机制

```typescript
class StrategySelector {
  select(userMessage: string, context: SessionContext): IStrategy {
    // 用户显式指定（slash command）
    if (userMessage.startsWith('/plan')) return new PlanExecuteStrategy();
    if (userMessage.startsWith('/parallel')) return new SubAgentStrategy();

    // 启发式判断
    if (looksLikeAnalysisTask(userMessage)) return new PlanExecuteStrategy();
    if (hasMultipleIndependentSubtasks(userMessage)) return new SubAgentStrategy();

    // 默认
    return new ReActStrategy();
  }
}
```

也可以让用户在设置中固定某种策略，或交给 LLM 自己判断（多一次 LLM 调用做 router）。

### 4.3 Plan & Execute 策略

```
┌────────────────────────────┐
│  阶段 1: Plan              │
│  LLM 生成结构化 plan：      │
│  [                          │
│    {step: 1, ...},         │
│    {step: 2, ...},         │
│  ]                          │
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│  阶段 2: Show Plan to User │   ← Plan 面板可视化
│  用户可以编辑/批准/拒绝     │
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│  阶段 3: Execute Loop      │
│  for each step in plan:     │
│    run ReAct loop on step   │
│    update plan progress     │
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│  阶段 4: Summarize         │
│  汇总所有结果，生成报告     │
└────────────────────────────┘
```

### 4.4 Sub-Agent 并行策略

**触发**：用户任务可以拆成 N 个独立子任务时（如"分析 GMV 下降原因"）

**流程**：
1. 主 Agent 调用 `spawn_subagents` tool 创建子 agent
2. 每个子 agent 有：独立的 token 预算、独立的 message history、共享的 RAG/工具
3. 子 agent 并行执行（默认最大 3 个并发，可配置）
4. 子 agent 通过结构化返回值给主 agent
5. 主 agent 汇总所有结果

```typescript
// 内置工具
{
  name: 'spawn_subagents',
  description: 'Run subtasks in parallel using sub-agents',
  parameters: {
    tasks: [
      { id: 'a', goal: '分析订单数变化', tools: ['query_database'] },
      { id: 'b', goal: '分析客单价变化', tools: ['query_database'] },
    ]
  }
}
```

**子 Agent 限制**：
- 不能再 spawn 子子 agent（防止递归爆炸）
- 不能修改父 session 的状态
- 失败不影响其他子 agent
- 必须返回结构化结果

---

## 5. 工具系统（Tool System）

### 5.1 工具来源四类

```
┌────────────────────────────────────────────┐
│             Tool Registry                   │
│  ┌──────────┬─────────┬──────────┬──────┐  │
│  │ Built-in │ User    │ Market   │Skill │  │
│  │ Tools    │ MCP     │ MCP      │ Tools│  │
│  └──────────┴─────────┴──────────┴──────┘  │
└────────────────────────────────────────────┘
```

| 来源 | 描述 | 例子 |
|---|---|---|
| **Built-in** | 应用内置 | `query_database`, `describe_table` |
| **User MCP** | 用户自部署 MCP server | 自家加解密工具 |
| **Market MCP** | 从 Smithery 等市场下载 | filesystem, github |
| **Skill** | 用户/团队自定义流程（含 prompt + tools） | "导出每日报表" |

### 5.2 内置工具清单（自带，开箱即用）

> **设计原则**：MVP 必须有一套"开箱即用"的内置工具。能用开源 MCP 适配的优先，性能/安全敏感的自写。

#### 5.2.1 数据库类（自写，与 core-db / core-rag 紧耦合）

| 工具 | 描述 | 危险等级 | 实现来源 |
|---|---|---|---|
| `search_schema` | RAG 检索 schema | safe | 自写（依赖 core-rag） |
| `describe_table` | 获取表详细 schema | safe | 自写 |
| `list_tables` | 列出表 | safe | 自写 |
| `list_schemas` | 列出 schema/database | safe | 自写 |
| `get_relations` | 获取表的外键关系 | safe | 自写 |
| `query_database` | 执行 SELECT | medium | 自写 |
| `execute_sql` | 执行任意 SQL（含写） | high | 自写（含 SQL 预审） |
| `explain_sql` | EXPLAIN 分析 | safe | 自写 |
| `dry_run_sql` | 预估影响行数 | safe | 自写 |
| `get_sample_rows` | 获取样本数据（脱敏） | safe | 自写 |
| `read_query_history` | 读取历史查询 | safe | 自写 |

#### 5.2.2 工作空间 / 文件类（自写，需要 workspace 沙箱）

| 工具 | 描述 | 危险等级 | 实现来源 |
|---|---|---|---|
| `read_workspace_file` | 读 workspace 内文件 | safe | 自写 |
| `write_workspace_file` | 写文件（含 diff 预览） | medium | 自写 |
| `edit_workspace_file` | 精确编辑（patch） | medium | 自写 |
| `list_workspace_dir` | 列目录 | safe | 自写 |
| `delete_workspace_file` | 删文件（5s 内可撤销） | medium | 自写 |
| `glob_workspace` | 文件名 glob 搜索 | safe | 自写（用 fast-glob） |
| `grep_workspace` | 内容搜索 | safe | 自写（用 ripgrep 子进程） |

> **说明**：理论上 `@modelcontextprotocol/server-filesystem` 可以替代这些，但内置版本：1) 自动锁定到当前 workspace 目录；2) 与 UI 的 diff 预览深度集成；3) 不需要起额外子进程，更轻量。

#### 5.2.3 脚本执行类（自写，依赖工作空间运行时）

| 工具 | 描述 | 危险等级 | 实现来源 |
|---|---|---|---|
| `run_python_script` | 执行 workspace/scripts/*.py | high | 自写（详见 [08 §4](./08-workspace-design.md)） |
| `python_repl` | 执行短 Python 代码片段（无需建文件） | high | 自写 |
| `install_python_deps` | 安装/更新 requirements.txt | high | 自写 |
| `run_shell_command` | 执行 shell 命令 | **high** | 自写（详见 §5.2.4） |

#### 5.2.4 Shell 工具的安全约束

`run_shell_command` 是高风险工具，**默认行为**：

- **询问模式下**：每次执行前必须用户确认，显示完整命令
- **自动模式下**：仅命令在白名单（`ls/cat/grep/find/git/python/node/...`）才自动执行
- **完全自动模式下**：黑名单匹配（`rm -rf / | sudo / curl ... | sh / dd / mkfs / shutdown ...`）一律拒绝
- **路径不限制**（用户决策）：可在 workspace 外执行，但有黑名单兜底
- **超时**：默认 60s，可配置
- **Capture**：stdout/stderr 限 100KB，超出截断
- **环境变量**：默认继承用户环境，敏感变量（`API_KEY` / `SECRET` / `PASSWORD`）默认 mask

```typescript
// 设置中可调
shell: {
  whitelist: ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'git', 'python', 'pip', 'uv', 'node', 'npm', 'pnpm', 'curl'],
  blacklist: ['rm -rf /', 'sudo', 'shutdown', 'mkfs', 'dd', '> /dev/'],
  timeoutSec: 60,
  maxOutputBytes: 100_000,
  maskEnvVars: ['*KEY*', '*SECRET*', '*PASSWORD*', '*TOKEN*'],
}
```

#### 5.2.5 元能力类（自写）

| 工具 | 描述 | 危险等级 | 实现来源 |
|---|---|---|---|
| `spawn_subagents` | 创建子 agent | medium | 自写 |
| `save_session_as_skill` | 当前会话→Skill yaml | safe | 自写 |
| `web_search` | 网页搜索（可选）| safe | 集成 Tavily / Bing API |
| `web_fetch` | 抓取 URL 文本 | safe | 集成现成 fetch MCP |

---

### 5.3 默认安装的 MCP Server（开箱即用）

> 应用首次启动时自动注册以下 MCP（可在设置中禁用）：

#### 5.3.1 不打包，按需启动（npx 拉取）

| MCP Server | 提供能力 | 包名 | 启动方式 |
|---|---|---|---|
| **memory** | Agent 跨会话记忆 | `@modelcontextprotocol/server-memory` | `npx -y @modelcontextprotocol/server-memory` |
| **time** | 时间/时区/日期计算 | `@modelcontextprotocol/server-time` | `npx -y @modelcontextprotocol/server-time` |
| **fetch** | HTTP 请求（带超时） | `@modelcontextprotocol/server-fetch` | `npx -y @modelcontextprotocol/server-fetch` |
| **everything**（开发期）| 测试 / debug 用，不发布 | `@modelcontextprotocol/server-everything` | 仅 dev 模式 |

#### 5.3.2 不集成 / 用户按需从 Market 安装

| MCP | 不内置原因 |
|---|---|
| `server-filesystem` | 已有内置等价工具（workspace 锁定） |
| `server-github` | 用户场景差异大（要 token），从 Market 装 |
| `server-postgres` | 我们的 core-db 自带能力，避免重复 |
| `server-puppeteer` | 体积大、用得少 |
| `server-slack` / `server-gdrive` | 业务场景，从 Market 装 |

#### 5.3.3 启动策略

```typescript
// 默认 mcp.json 预置
{
  "version": 1,
  "servers": [
    {
      "id": "builtin-memory",
      "name": "Memory",
      "source": "builtin",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true,
      "autoStart": false  // 按需启动，节省内存
    },
    {
      "id": "builtin-time",
      "name": "Time",
      "source": "builtin",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-time"],
      "enabled": true,
      "autoStart": false
    },
    {
      "id": "builtin-fetch",
      "name": "Fetch",
      "source": "builtin",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "enabled": true,
      "autoStart": false
    }
  ]
}
```

**首次调用时 npx 拉取**，本地缓存后续秒启。

#### 5.3.4 离线兜底

考虑到国内用户可能 npx 慢/被墙，提供：
- 设置中"使用国内镜像"开关（npm 镜像 → 淘宝/腾讯）
- 用户可手动指定本地路径（已 npm i 过的包）
- 失败时降级：禁用 MCP，仅用内置工具，提示用户

---

### 5.4 统一工具接口

无论来源，所有工具走同一接口：

```typescript
export interface ITool {
  name: string;
  description: string;
  parameters: JSONSchema;
  source: 'builtin' | 'user-mcp' | 'market-mcp' | 'skill';
  source_id?: string;            // MCP server 名 / skill ID
  danger_level: 'safe' | 'medium' | 'high';
  default_approval: 'auto' | 'ask';

  execute(args: any, ctx: ExecutionContext): Promise<ToolResult>;
}

export interface ExecutionContext {
  sessionId: string;
  connectionId?: string;
  userId: string;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface ToolResult {
  status: 'success' | 'error';
  data?: any;
  error?: string;
  meta?: {
    duration_ms: number;
    tokens_used?: number;
  };
}
```

### 5.5 MCP 集成

#### 5.5.1 MCP Client 架构

```
┌────────────────────────────────────────────┐
│           MCP Client Manager                │
│                                            │
│  ┌──────────────┬──────────────┐           │
│  │ Stdio Client │ HTTP/SSE Cli │           │
│  └──────┬───────┴──────┬───────┘           │
│         │              │                   │
│  ┌──────▼───────┐  ┌───▼──────────┐        │
│  │ User MCP #1  │  │ Market MCP #1│        │
│  │ (local proc) │  │ (remote URL) │        │
│  └──────────────┘  └──────────────┘        │
└────────────────────────────────────────────┘
```

#### 5.4.2 MCP 工具适配

每个 MCP server 启动后，list_tools 得到的工具被适配成 `ITool`：

```typescript
class MCPToolAdapter implements ITool {
  constructor(
    private serverId: string,
    private mcpTool: McpTool,
    private client: McpClient,
  ) {
    this.name = `${serverId}__${mcpTool.name}`;  // 命名空间避免冲突
    this.description = mcpTool.description;
    this.parameters = mcpTool.inputSchema;
    this.source = 'user-mcp';
    this.source_id = serverId;
    this.danger_level = inferDangerLevel(mcpTool);  // 启发式
    this.default_approval = this.danger_level === 'high' ? 'ask' : 'auto';
  }

  async execute(args, ctx) {
    return await this.client.callTool(this.mcpTool.name, args);
  }
}
```

#### 5.5.3 Smithery / mcp.so 市场对接

参考 [Smithery Registry API](https://smithery.ai)：
- `GET /servers` 拉取列表
- `GET /servers/:id` 详情
- 安装方式：根据配置启动本地进程或连接远程

我们封装一个 `MCPMarketClient`：

```typescript
interface IMcpMarket {
  list(filter?: MarketFilter): Promise<MarketEntry[]>;
  install(entryId: string): Promise<InstalledMcp>;
  uninstall(entryId: string): Promise<void>;
}
```

**安装流程**：
1. 从 registry 获取启动配置（command/args/env）
2. 用户填写必要凭证（如 GitHub token）
3. 写入 `~/.dbagent/mcp/installed.json`
4. 启动 MCP 进程，list_tools，注册到 ToolRegistry
5. 出现在 UI 的 Tools 面板

### 5.6 工具调用的安全控制

#### 5.6.1 工具白名单
每个 session / 模式有独立的工具白名单：
- 只读模式：只允许 `*_read`, `*_describe`, `query_database` (限 SELECT)
- 询问模式：所有工具可调，但 `danger_level >= medium` 必须用户确认
- 自动模式：所有工具自动执行，但 `danger_level == high` 仍要求确认

#### 5.6.2 工具调用配额
- 单 session 工具调用上限：默认 50 次
- 单 tool 调用超时：默认 60 秒
- MCP 进程内存限制：默认 512MB

#### 5.6.3 工具沙箱（未来）
MVP 阶段：MCP 作为子进程，依赖进程隔离
v1.1+：考虑 Docker / WASM 加强隔离

---

## 6. Skill 系统

### 6.1 Skill 是什么

**Skill = 命名好的、可复用的"任务流程"**。

它不是简单的 prompt template，而是一个完整的微 agent 配置：

```yaml
# skills/daily-gmv-report.yaml
name: daily_gmv_report
title: 每日 GMV 报表
description: 输出昨日 GMV 及环比、同比

# 用户怎么触发
trigger:
  command: /daily-gmv
  natural_language_keywords: ['昨日 GMV', '日报']

# 可用工具子集
allowed_tools:
  - query_database
  - describe_table

# 默认参数
parameters:
  date:
    type: string
    default: yesterday

# Prompt 注入
system_addition: |
  你是公司的数据分析师。GMV 计算口径：sum(orders.amount) where status='paid'.
  排除测试用户（test_users 表中的 user_id）。

# 步骤 (可选，如果留空就走默认 ReAct)
steps:
  - 'SELECT 昨日 GMV'
  - 'SELECT 前一日 GMV，计算环比'
  - 'SELECT 上周同日 GMV，计算同比'
  - '生成 markdown 报表'

# 输出 schema
output_format: markdown
```

### 6.2 Skill 的来源

- **内置**：随应用发布的常用 Skill
- **用户私有**：本机 `~/.dbagent/skills/`
- **团队共享**：（未来）从云同步
- **Skill Market**：（未来）公开 Skill 市场

### 6.3 Skill 的执行

调用 Skill 时：
1. 构造一个新的 mini-session，注入 system_addition
2. 限制可用工具为 allowed_tools
3. 如果有 steps，走 Plan & Execute 策略
4. 否则走默认 ReAct
5. 输出按 output_format 格式化

```typescript
async function runSkill(skill: Skill, args: any, parent: Session) {
  const subSession = parent.createChild({
    systemPromptAddition: skill.system_addition,
    allowedTools: skill.allowed_tools,
    inheritConnection: true,
  });

  const strategy = skill.steps
    ? new PlanExecuteStrategy(skill.steps)
    : new ReActStrategy();

  return await strategy.run(subSession, renderTemplate(skill, args));
}
```

### 6.4 内置 Skill 清单（开箱即用）

> 应用自带 4 个核心 Skill，覆盖数据工程师最高频的场景。**全部以 yaml 文件随应用打包**，可被用户复制改写为模板。
>
> **特别强调 `data_analysis`**：让 Agent 写 Python 脚本做数据分析是我们的核心差异化（详见 [08 §1.3](./08-workspace-design.md)），必须开箱即用，不依赖用户每次自己写 prompt 引导。

#### 6.4.1 `generate_schema_doc` — 生成 Schema 文档

```yaml
name: generate_schema_doc
title: 生成 Schema 文档
description: 扫描当前数据库的所有表，输出结构化的 Markdown 文档到 docs/schema.md

trigger:
  command: /schema-doc
  natural_language_keywords: ['生成 schema 文档', '导出表结构', 'schema documentation']

allowed_tools:
  - list_tables
  - describe_table
  - get_relations
  - get_sample_rows
  - write_workspace_file

parameters:
  scope:
    type: string
    description: schema 名（留空则全部）
    default: null
  include_samples:
    type: boolean
    default: false
  output_path:
    type: string
    default: 'docs/schema.md'

system_addition: |
  你是技术文档专家，输出标准、可读、对中文用户友好的 Schema 文档。
  - 每张表一节，含：用途、字段表、关键索引、关联关系
  - 字段表用 Markdown table，列：字段名 / 类型 / 是否空 / 默认值 / 描述
  - 加密字段在描述中明确标注（如 ⚠ AES 加密）
  - 关联关系用列表展示（1:N → other_table）

steps:
  - 用 list_tables 列出 {scope} 范围的所有表
  - 对每张表用 describe_table 获取详细信息
  - 用 get_relations 获取关联关系
  - 组装 Markdown，调用 write_workspace_file 写入 {output_path}
  - 返回写入路径和表数

output_format: markdown
```

#### 6.4.2 `generate_er_diagram` — 生成 ER 图

```yaml
name: generate_er_diagram
title: 生成 ER 图（mermaid）
description: 基于外键自动生成 mermaid erDiagram 文本

trigger:
  command: /er-diagram
  natural_language_keywords: ['生成 ER 图', '画关系图', 'entity relationship']

allowed_tools:
  - list_tables
  - describe_table
  - get_relations
  - write_workspace_file

parameters:
  tables:
    type: array
    description: 指定表名列表（留空则全部）
    default: null
  output_path:
    type: string
    default: 'docs/er-diagram.mermaid'
  max_columns_per_table:
    type: integer
    description: 每个表最多显示的字段数（避免图太复杂）
    default: 10

system_addition: |
  你输出标准的 mermaid erDiagram 语法。
  - 表节点显示主键 PK、外键 FK 标记
  - 关系箭头用 ||--o{ 表示 1:N，||--|| 表示 1:1
  - 标注关系名（约束名）
  - 仅显示前 {max_columns_per_table} 个字段

steps:
  - 收集表和外键
  - 生成 erDiagram 文本
  - write_workspace_file 写入 {output_path}
  - 返回 mermaid 文本（UI 直接渲染）

output_format: mermaid
```

#### 6.4.3 `optimize_sql` — SQL 优化建议

```yaml
name: optimize_sql
title: SQL 优化建议
description: 对一条 SQL 跑 EXPLAIN ANALYZE，分析瓶颈并给出优化建议

trigger:
  command: /optimize
  natural_language_keywords: ['SQL 优化', 'explain', '为什么慢', '优化查询']
  context_aware: true   # 在 SQL 编辑器中选中 SQL 时显示菜单

allowed_tools:
  - explain_sql
  - describe_table
  - search_schema

parameters:
  sql:
    type: string
    description: 要优化的 SQL（必填）
    required: true

system_addition: |
  你是资深 DBA。基于 EXPLAIN ANALYZE 输出，给出可执行的优化建议。
  分析维度：
  1. 索引使用：是否走了合适的索引？是否需要新建？
  2. JOIN 顺序：是否最优？
  3. 子查询/CTE：是否能改写为更高效的形式？
  4. 行数估算：planner 估算与实际差异大吗？（可能要 ANALYZE）
  5. 数据类型：是否有隐式转换？

  输出格式：
  - 性能瓶颈（最多 3 条，按影响排序）
  - 建议（每条含：改动 / 预期收益 / 实施 SQL 或 DDL）
  - 重写后的 SQL（如适用）

steps:
  - 用 explain_sql 跑 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  - 解析输出找出高耗时节点
  - 必要时用 describe_table 确认相关表的索引
  - 输出结构化分析

output_format: markdown
```

#### 6.4.4 `data_analysis` — Python 数据分析（核心 Skill）

> **这是 DBAgent 区别于普通 Text2SQL 工具的核心 Skill**。它指导 Agent 用 Python 脚本完成 SQL 单独无法完成的任务：复杂统计、可视化、机器学习、深度学习、强化学习、特征工程、加解密、跨表 ETL、报告生成等。
>
> **不是模板化、不是只会画图**：真正的数据科学家会用 scikit-learn / PyTorch / TensorFlow / Optuna / Stable-Baselines3 等高级库。本 Skill 给 Agent 的是**约定与边界**，不是"必须长什么样"的死模板。

```yaml
name: data_analysis
title: Python 数据分析与建模
description: 让 Agent 用 Python 脚本完成 SQL 之外的所有数据任务，从简单 EDA 到深度学习训练，自动生成可复用、可组合的脚本

trigger:
  command: /analyze
  natural_language_keywords:
    # 描述/EDA
    - '分布', '统计', '画图', 'EDA', '探索性'
    # 处理/ETL
    - '处理', '清洗', '导出', '解密', '跨表'
    # 建模
    - '训练', '模型', '预测', '分类', '回归', '聚类'
    - '深度学习', '神经网络', '强化学习', 'NLP', '推荐'
    # 报告
    - '报告', '汇总', '分析原因'
  # 当 Agent 自主判断需要 Python 时，自动加载本 Skill 的 system_addition 作为引导
  auto_inject_when:
    - 'sql_alone_insufficient'      # SQL 表达力不足
    - 'requires_visualization'       # 需要画图
    - 'requires_decryption'          # 涉及加密字段
    - 'requires_iteration'           # 需要逐行/迭代处理
    - 'requires_modeling'            # 需要 ML/DL 建模
    - 'requires_multi_step_pipeline' # 需要多脚本组合的 pipeline

allowed_tools:
  # 数据库
  - search_schema
  - describe_table
  - query_database
  # 工作空间文件
  - read_workspace_file
  - write_workspace_file
  - edit_workspace_file
  - list_workspace_dir
  - glob_workspace
  - grep_workspace
  # Python 执行
  - run_python_script
  - python_repl
  - install_python_deps

parameters:
  task:
    type: string
    description: 用户的分析/建模需求描述
    required: true
  output_dir:
    type: string
    default: 'outputs'
  script_dir:
    type: string
    default: 'scripts'
  reuse_existing:
    type: boolean
    description: 优先复用 scripts/ 中已有的相似脚本与函数
    default: true

system_addition: |
  你是一个全栈数据科学助手，可以用 Python 完成从 EDA 到深度学习的任意任务。
  你不是只会跑 pandas+matplotlib 的初级脚本工 —— 当任务需要时，主动用 scikit-learn、
  PyTorch、Stable-Baselines3、Optuna、NetworkX、statsmodels、HuggingFace 等专业库。

  ## 工作流程（自主决策，不必僵化遵循）

  1. **理解任务的真实复杂度**
     - 用 search_schema / describe_table 弄清楚数据
     - 任务是 EDA 还是要建模？需要 GPU 吗？数据量多大？
     - 不确定的业务口径先问用户

  2. **盘点工作空间已有资产**
     - list_workspace_dir scripts/ 看现有脚本
     - grep_workspace 搜关键词（如 "decrypt_phone", "load_orders"）
     - **能复用就复用，能调用就调用**：组合优于重写

  3. **决定脚本架构**
     根据任务复杂度选择：

     - **单文件脚本**（简单任务）：一次性 EDA、报表、小转换
     - **多文件 pipeline**（复杂任务）：拆成可复用模块
       例如训练任务可拆：
         scripts/data/load_orders.py       # 数据加载
         scripts/features/build_features.py # 特征工程
         scripts/models/train_lgb.py        # 训练
         scripts/models/evaluate.py         # 评估
         scripts/run_pipeline.py            # 编排（调用上面所有）

  ## 脚本编写约定（不是模板，是边界）

  以下是**必须遵守的约定**，但函数怎么写、用什么库由你判断：

  ### A. 必用 dbagent SDK 做受控操作

  ```python
  from dbagent import db, save, load, workspace

  df = db.query("SELECT ...")          # 数据库查询（凭证自动注入）
  save("outputs/result.parquet", df)   # 写文件（路径锁定在 workspace）
  cfg = load("config/model.yaml")      # 读文件（同样锁定）
  workspace.print("✓ 进度信息")         # 流式输出到 chat
  ```

  **不要绕过**：不要用裸 `psycopg.connect()` / `open()` / `print()` 替代上面这些。
  这些 SDK 函数提供了凭证注入、路径沙箱、流式日志，**绕过会破坏安全保证**。

  ### B. 脚本间互相调用（关键能力）

  脚本不是孤立的。同一个 workspace 内的脚本可以**互相 import**：

  ```python
  # scripts/models/train_lgb.py
  from scripts.data.load_orders import load_recent_orders   # 直接 import
  from scripts.features.build_features import build_features

  df = load_recent_orders(days=30)
  X, y = build_features(df)
  model = train(X, y)
  save("outputs/models/lgb_v1.pkl", model)
  ```

  也可以把脚本注册为 **workspace tool**（其他 Agent / 脚本可调用）：

  ```python
  # scripts/decrypt_phone.py
  """
  @tool decrypt_phone
  @param encrypted: bytes
  @returns: str
  对 AES 加密的手机号解密。
  """
  def main(encrypted: bytes) -> str:
      ...
  ```

  注册后，**任何其他脚本**都能调用：

  ```python
  from dbagent import workspace
  phone = workspace.call_tool("decrypt_phone", encrypted=row['phone_enc'])
  ```

  这样**复用 + 组合**会让工作空间逐渐沉淀成一个领域工具库。

  ### C. 模块化原则

  - 每个文件单一职责（加载 / 特征 / 训练 / 评估 / 编排分开）
  - 公开函数有 type hints + 简短 docstring
  - 主入口用 `if __name__ == '__main__': main()`，便于命令行单跑
  - 重型计算（训练、推理）放函数里，不要写在 module 顶层（避免被 import 时执行）
  - 共享配置放 `config/*.yaml`，不要硬编码在脚本里

  ### D. 库的选择 —— 按任务量级用对工具

  | 任务 | 推荐 |
  |---|---|
  | EDA / 简单画图 | pandas + matplotlib / seaborn |
  | 大数据量 (>10M 行) | polars / duckdb |
  | 经典 ML | scikit-learn / lightgbm / xgboost |
  | 调参 | optuna |
  | 深度学习 | pytorch（首选）/ tensorflow |
  | NLP / LLM | transformers / sentence-transformers |
  | 强化学习 | stable-baselines3 / cleanrl |
  | 时序 | statsmodels / prophet / darts |
  | 图算法 | networkx / pyg |
  | 交互可视化 | plotly / altair |

  默认环境**没有这些重型库**，用前先 `install_python_deps`。
  深度学习库装机器需要 1-5 分钟，建议 install 后**用 python_repl 验一下 import 成功** 再写大段代码。

  ### E. 大数据 / 长任务的处理

  - 拉数大于 100 万行时用 `chunksize` 或 `LIMIT + 分页`
  - 训练时用 `workspace.print` 输出进度（loss、epoch 等）
  - 长任务（> 5 分钟）拆成阶段：每阶段保存中间产物到 outputs/checkpoints/，
    崩溃后能从 checkpoint 续跑
  - GPU 任务前先用 python_repl 跑 `torch.cuda.is_available()` 探测

  ## 执行循环

  - run_python_script → 看 stdout/stderr
  - 失败：分析错误 → edit_workspace_file 修脚本 → 重跑（最多 3 次）
  - 长任务：用户可中断，保留中间产物
  - 完成：用 chat 内嵌渲染图片 / 表格

  ## 解读与产出

  - **不要只说"完成了"**：给业务结论 + 数字 + 建议
  - 模型训练完，给指标（accuracy / AUC / RMSE）+ 业务含义
  - 长任务给执行摘要：耗时、产物、关键中间结果路径

  ## 沉淀

  - 用户说"以后还要这么做" → 建议 save_session_as_skill
  - 高复用脚本 → 在 docstring 加 @tool 标记，注册为 workspace tool
  - 复杂 pipeline → 建议拆成多脚本 + 一个编排脚本

  ## 安全红线（不可越过）

  - 加密字段：优先调用 workspace 已注册的解密 tool，不要自己实现密钥逻辑
  - SQL 写操作：不要在 Python 里直接 INSERT/UPDATE/DELETE，回到 chat 让用户走 SQL 路径确认
  - 不要 `import os; os.system(...)` / `subprocess.run(...)` 逃逸沙箱
  - 不要 `open()` 任意路径，统一走 `save()` / `load()`
  - 模型文件 / 训练数据若包含敏感信息，保存到 workspace 内即可（不要 push 到外部）

  ## 输出风格

  - 中文回复，技术术语保留原文（如 "AUC"、"epoch"、"PPO"）
  - 关键步骤简短说明
  - 文件路径用相对路径
  - 不要把脚本全文贴回 chat（用户能在 Tab 里看），只总结关键改动

output_format: markdown
```

**关键设计点**：

1. **不是模板，是约定**
   不强制 Agent "必须长什么样"，给的是边界（必用 SDK / 必用相对路径 / 不许 os.system）。脚本结构由 Agent 根据任务复杂度判断。

2. **支持深度学习 / 强化学习 / NLP**
   明确告诉 Agent 任务到了那一层，就用 PyTorch / SB3 / transformers，不要硬塞 pandas+matplotlib。库不在默认 venv 里，用前 `install_python_deps`。

3. **`auto_inject_when` 扩展**
   新增 `requires_modeling` / `requires_multi_step_pipeline` 触发条件，Agent 主动判断"这事 SQL 干不了"时自动加载本 Skill。

4. **脚本互相调用是一等公民**
   - **import**：同 workspace 内 `from scripts.data.load_orders import load_recent_orders`
   - **call_tool**：通过 `workspace.call_tool(name, ...)` 调用注册了 `@tool` docstring 的脚本
   - **目录约定**：`scripts/data/`, `scripts/features/`, `scripts/models/` 等子目录鼓励模块化

5. **大型/长任务的工程化指导**
   - chunksize / 分页 / checkpoint
   - 进度流式输出
   - GPU 探测
   - 崩溃续跑

6. **dbagent-sdk 扩展**
   原来只有 `db / save / workspace`，新增 `load`（读 yaml/json/csv 配置文件）。需要在 [08 §4.6.5](./08-workspace-design.md) 的 SDK 设计中同步。

7. **明确的安全红线**
   - 写 DB 走 chat（避免 Agent 在 Python 里偷偷写库）
   - 加密走已注册 tool（不让 Agent hallucinate 解密逻辑）
   - 不许逃逸沙箱

8. **不复制脚本到 chat**
   引导 Agent 简短汇报，不要把整个脚本回贴 —— 用户能在 Python Tab 里看，避免污染对话上下文。

#### 6.4.5 加载与注册

```typescript
// 内置 Skill 加载逻辑
const BUILTIN_SKILLS_DIR = path.join(app.getAppPath(), 'resources', 'skills');

async function loadBuiltinSkills(): Promise<Skill[]> {
  const files = await fs.readdir(BUILTIN_SKILLS_DIR);
  return Promise.all(
    files
      .filter(f => f.endsWith('.yaml'))
      .map(f => loadSkillFromYaml(path.join(BUILTIN_SKILLS_DIR, f)))
  );
}
```

加载顺序：内置 → 用户级（`~/.dbagent/skills/`）→ 工作空间级（覆盖前者）。用户可通过 `命令面板 → 复制内置 Skill 到工作空间` 一键派生改写。

#### 6.4.6 不进 MVP 的 Skill

以下后续版本再加，避免膨胀：

- ❌ `data_quality_check`（空值/重复/异常值检查）
- ❌ `daily_report`（每日报表，需要调度系统）
- ❌ `migrate_schema`（schema 迁移辅助）
- ❌ `seed_test_data`（生成测试数据）

---

## 7. Permission Manager（询问执行）

### 7.1 模式与权限矩阵

| 操作类别 | 询问模式 | 自动模式 | 完全自动 | 只读模式 |
|---|---|---|---|---|
| SELECT 查询 | 自动 | 自动 | 自动 | 自动 |
| EXPLAIN / describe | 自动 | 自动 | 自动 | 自动 |
| INSERT/UPDATE/DELETE | 询问 | 询问 | 自动 | ❌ 拒绝 |
| DDL (CREATE/DROP/ALTER) | 询问 | 询问 | 自动* | ❌ 拒绝 |
| 调用 user MCP (high) | 询问 | 询问 | 自动 | 询问 |
| 调用 user MCP (safe) | 自动 | 自动 | 自动 | 自动 |
| 调用 market MCP | 询问 | 询问 | 自动 | 询问 |
| spawn_subagents | 询问 | 自动 | 自动 | 自动 |
| 涉及行数 > 阈值 | 询问 | 询问 | 询问* | ❌ |

*\* 完全自动模式下，仍有"硬危险操作清单"强制询问，例如 `DROP DATABASE`*

### 7.2 询问 UI 集成

```typescript
class PermissionManager {
  async check(toolCall: ToolCall, session: Session): Promise<PermissionResult> {
    const tool = toolRegistry.get(toolCall.name);
    const mode = session.agentMode;

    const decision = decideApproval(tool, toolCall.args, mode, session);

    if (decision === 'auto-allow') return { status: 'allowed' };
    if (decision === 'auto-deny') return { status: 'denied', reason: '...' };

    // 需要询问用户
    const userDecision = await session.ui.askApproval({
      tool: tool.name,
      description: tool.description,
      args: toolCall.args,
      preview: await tool.preview?.(toolCall.args),  // 例如 SQL 的影响行数
      dangerLevel: tool.danger_level,
    });

    if (userDecision.approved) {
      // 是否记住此决定？
      if (userDecision.rememberFor === 'session') {
        session.allowList.add(tool.name);
      } else if (userDecision.rememberFor === 'always') {
        await settings.allowAlways(tool.name);
      }
      return { status: 'allowed' };
    }

    return { status: 'denied', reason: userDecision.reason };
  }
}
```

### 7.3 SQL 预审（特殊处理）

`execute_sql` 调用前的额外预审：
1. 解析 SQL（用 `node-sql-parser` 或 PG 自带的 `EXPLAIN`）
2. 判断操作类型（SELECT/INSERT/UPDATE/DELETE/DDL）
3. EXPLAIN 估算影响行数
4. 检查是否在"危险操作清单"
5. 综合给出风险评级

```typescript
interface SqlAuditResult {
  type: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'unknown';
  estimatedRows: number | null;
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical';
  warnings: string[];          // ['DELETE without WHERE', 'in production']
  affectedTables: string[];
}
```

---

## 8. Session 管理

### 8.1 Session 数据模型

```typescript
export interface Session {
  id: string;
  title: string;                 // 自动从首条消息生成
  createdAt: Date;
  updatedAt: Date;

  // 配置
  connectionId?: string;
  modelId: string;               // LLM provider + model
  agentMode: 'ask' | 'auto' | 'full-auto' | 'readonly';
  strategy: 'react' | 'plan-execute' | 'auto';

  // 状态
  messages: Message[];
  toolCallHistory: ToolCallRecord[];
  plan?: Plan;                   // 当前 plan（如果用 Plan&Execute）
  subSessions: SubSessionInfo[];

  // 资源
  tokenUsage: { prompt: number; completion: number; total: number };
  costEstimate: number;          // 估算金额

  // 用户白名单（本会话允许的工具）
  allowList: Set<string>;
}

export type Message =
  | { role: 'user'; content: string; timestamp: Date }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; timestamp: Date }
  | { role: 'tool'; toolCallId: string; content: any; timestamp: Date }
  | { role: 'system'; content: string; timestamp: Date };
```

### 8.2 Session 持久化

- **存储**：SQLite 单库（`~/.dbagent/sessions.db`）
- **表设计**：`sessions`（元信息）+ `messages`（消息流）+ `tool_calls`（工具调用记录）
- **加载策略**：会话切换时延迟加载消息历史
- **导出**：支持 JSON / Markdown 格式导出

### 8.3 Session 操作

```typescript
interface ISessionManager {
  create(config: SessionConfig): Promise<Session>;
  load(id: string): Promise<Session>;
  list(filter?: SessionFilter): Promise<SessionSummary[]>;
  update(id: string, patch: Partial<Session>): Promise<void>;
  delete(id: string): Promise<void>;

  fork(id: string, fromMessageIndex: number): Promise<Session>;
  archive(id: string): Promise<void>;
  export(id: string, format: 'json' | 'md'): Promise<string>;
}
```

---

## 9. Memory（短期 + 长期）

### 9.1 短期记忆（Session 内）

- 完整消息历史（在 token 预算内）
- 工具调用结果（可压缩）
- 当前 plan / 子 agent 状态

### 9.2 上下文压缩策略

#### 9.2.1 阈值与触发

每个 session 维护实时 token 计数，按预算（默认 40k）有三档触发：

| 占比 | 状态 | 行为 |
|---|---|---|
| < 60% | 健康 | 不做任何动作 |
| 60-80% | 警告 | UI 状态栏黄色，建议用户"考虑新开会话" |
| 80-95% | 主动压缩 | **后台自动压缩**（用户可见，可撤销） |
| > 95% | 强制压缩 | 必须压缩，否则下一轮会失败；压缩前提示用户 |

#### 9.2.2 压缩策略（按优先级从轻到重）

**Level 1：折叠已完成子 agent 日志**
- 子 agent 的中间 tool calls / thoughts 全部折叠成一句话总结："子 Agent A 完成了订单数分析，结论 X"
- 保留主 agent 看到的 final result，丢弃过程

**Level 2：去重 schema 注入**
- 同一个表的 schema 在 context 中只保留最近一次完整版
- 早期出现的同表 schema 替换成 `[schema of users (see above)]`

**Level 3：工具结果摘要化**
- 大型 tool result（如 `query_database` 返回 100 行）→ 用小模型（如 deepseek-chat）写 50 字摘要 + 行数
- 原始数据落盘到 `~/.dbagent/sessions/{id}/tool_results/`，UI 上仍可点击查看完整版
- LLM 看到的是摘要

**Level 4：早期消息归档**
- 保留：system prompt + 最近 K 轮（默认 8 轮）+ 中间一段 summary
- 中间被归档的消息用一段 LLM 生成的"前情提要"替代
- 用户在 UI 上能看到"📜 已归档 12 条消息 [展开查看]"

#### 9.2.3 用户感知与撤销

```
顶部状态栏：
[Token: ████████████░░░░ 32k/40k (80%) ⚠]
              ↑ 点击展开

点击后弹出小面板：
┌─ Token 使用情况 ───────────────────────┐
│ 当前 32,123 / 40,000 (80%)             │
│                                        │
│ 占用分布：                               │
│  System Prompt    1.2k                 │
│  Tool 定义        2.1k                 │
│  消息历史         24.5k  ← 主要         │
│  最近 RAG 结果    4.3k                  │
│                                        │
│ [🗜 立即压缩]  [📤 新开会话]  [⚙ 调整预算] │
│                                        │
│ ☑ 自动压缩（80% 触发）                  │
└────────────────────────────────────────┘
```

压缩后：
```
┌─ ✓ 已压缩 ─────────────────────────────┐
│ 释放了 18.2k tokens                     │
│ 归档了 12 条早期消息 + 3 个 tool result  │
│ [↶ 撤销压缩]   [👁 查看归档内容]         │
└────────────────────────────────────────┘
```

**撤销窗口**：5 分钟内可撤销（归档内容暂存内存）。

#### 9.2.4 压缩成本

- Level 1-2：纯本地操作，0 成本
- Level 3-4：需要调用 LLM 写摘要，**用最便宜的模型**（如 `deepseek-chat`），不用主对话模型
- 压缩本身的 token 消耗也计入 usage 但单独标记类型 `'compression'`，不计入用户配额（订阅模式下我们承担）

#### 9.2.5 实现要点

```typescript
class ContextManager {
  async checkAndCompress(session: Session): Promise<void> {
    const usage = session.estimateTokens();
    const ratio = usage / session.tokenBudget;

    if (ratio < 0.6) return;
    if (ratio < 0.8) return this.warnUser(session, ratio);
    if (ratio < 0.95) return this.softCompress(session);
    return this.hardCompress(session);
  }

  async softCompress(session: Session) {
    // 静默走 Level 1-2
    await this.foldSubAgentLogs(session);
    await this.dedupSchemaInjection(session);

    // 仍超过 80% → 走 Level 3
    if (session.estimateTokens() / session.tokenBudget > 0.8) {
      await this.summarizeToolResults(session);
    }

    session.appendCompressionEvent({ canUndo: true, ttlMs: 5 * 60_000 });
    emit('agent:compressed', session.id);
  }

  async hardCompress(session: Session) {
    // 用户提示
    const ok = await session.ui.confirmCompression();
    if (!ok) throw new BudgetExceededError();

    await this.foldSubAgentLogs(session);
    await this.dedupSchemaInjection(session);
    await this.summarizeToolResults(session);
    await this.archiveEarlyMessages(session, { keepRecent: 8 });
  }
}
```

`session.estimateTokens()` 用 `tiktoken` / `js-tiktoken` 估算（不同模型用不同 encoder）。

### 9.3 长期记忆（跨 Session）

MVP 阶段不做完整长期记忆，但保留接口：

```typescript
interface ILongTermMemory {
  remember(key: string, value: any, scope: 'global' | 'connection' | 'user'): Promise<void>;
  recall(key: string, scope: string): Promise<any>;
  search(query: string, scope?: string): Promise<MemoryItem[]>;
}
```

未来可扩展：
- **指标定义记忆**：用户教过一次"GMV 怎么算"，永远记住
- **失败修复记忆**：记住"上次 SQL 报错的修复方案"
- **数据库特征记忆**：累积"orders 表数据量大，建议加 LIMIT"等经验

---

## 10. LLM Router

### 10.1 多 Provider 支持

```typescript
interface ILlmProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  models: ModelInfo[];

  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  embeddings(req: EmbeddingRequest): Promise<EmbeddingResponse>;

  isAvailable(): Promise<boolean>;
  estimateCost(req: ChatRequest): number;
}
```

实现：
- `OpenAICompatibleProvider`（覆盖 OpenAI / DeepSeek / 智谱 / Moonshot / Ollama / vLLM 等）
- `AnthropicProvider`
- 其他按需扩展

### 10.2 模型选择

每个 session 配置：
- 主对话模型（默认 DeepSeek-V3）
- 工具调用模型（可选，可与主模型不同）
- Embedding 模型（独立配置）

### 10.3 失败回退

- 主模型失败 → 提示用户切换 / 自动尝试备用模型（可配置）
- Rate limit → 退避重试
- 超时 → 中止本次调用，返回错误给 agent loop

详细见 [04-config-design.md](./04-config-design.md)。

---

## 11. 错误处理与重试

### 11.1 错误分类

| 类型 | 示例 | 处理 |
|---|---|---|
| 工具临时错误 | 网络抖动、DB 连接断开 | 自动重试 1 次 |
| SQL 语法错误 | typo | 错误信息回传 LLM，让它修正 |
| 权限错误 | DB 用户无权 | 直接告知用户，不重试 |
| LLM API 错误 | 429 / 5xx | 退避重试，超过则切换模型或中止 |
| 工具执行超时 | MCP 卡死 | kill + 重启 server，错误回传 LLM |
| 用户拒绝 | 询问被否 | 终止该路径，让 LLM 重新规划 |

### 11.2 SQL 修复循环

```
1. LLM 生成 SQL
2. 执行 → 报错 "column foo doesn't exist"
3. 不直接返回失败，而是把错误 + 相关 schema 重新注入
4. LLM 看到错误后重新生成
5. 最多重试 3 次，仍失败 → 上报用户
```

---

## 12. 可观测性

### 12.1 用户可见的观测

- **Plan 面板**：实时显示 agent 在做什么
- **思考流**：流式展示 LLM 的 thought
- **工具调用日志**：每次调用的参数、结果、耗时
- **Token / 成本计数**：实时显示

### 12.2 内部日志

每个 agent loop 写入日志：
```json
{
  "session_id": "...",
  "iteration": 3,
  "phase": "tool_call",
  "tool": "query_database",
  "args": "...",
  "duration_ms": 234,
  "result_size": 1024,
  "tokens": { "prompt": 1234, "completion": 89 }
}
```

存储在 `~/.dbagent/logs/agent-{date}.jsonl`，用户可在设置中查看 / 导出。

### 12.3 可选遥测（隐私优先）

- **完全关闭**：默认（隐私优先）
- **匿名错误上报**：用户主动开启（帮助产品改进）
- **用户从不发送**：SQL 内容、数据库内容、API key

---

## 13. 系统 Prompt 模板

### 13.1 主 Agent 系统 Prompt 框架

```
你是 DBAgent，一个数据库智能助手。你的目标是帮助用户高效地完成数据查询、分析和操作任务。

## 当前环境
- 数据库类型: {dialect}
- 连接名称: {connection_name}
- Agent 模式: {agent_mode}
- 当前时间: {now}

## 工作原则
1. **理解优先**：不确定用户意图时主动询问
2. **小步前进**：复杂任务先拆解，逐步执行
3. **使用工具**：用 search_schema 检索表结构，不要凭空猜
4. **安全意识**：写操作前确认；大表查询加 LIMIT；生产库谨慎
5. **解释清楚**：不只给结果，给解读和建议

## 可用工具
{tool_descriptions}

## 当前会话的额外上下文
{session_specific_context}

## 输出风格
- 中文回复（除非用户用英文）
- SQL 用代码块包裹
- 关键数字加粗
- 必要时用表格

开始吧。
```

### 13.2 子 Agent 系统 Prompt

精简版，去掉策略部分，加上"你是 X 的子 agent"等定位。

---

## 14. 性能与成本目标

| 指标 | 目标 |
|---|---|
| 简单查询（"列出所有表"）端到端 | < 3 秒 |
| 复杂查询（含 RAG + 1 次 SQL）| < 8 秒 |
| 多步分析（5+ 工具调用）| < 30 秒 |
| 单次会话 token 上限 | 默认 40k，可配置 |
| 单次会话成本 | DeepSeek 默认 < ¥0.05 |
| MCP 工具调用超时 | 60 秒 |

---

## 15. 安全总结

| 安全维度 | 措施 |
|---|---|
| 数据不出本机 | LLM 只看 schema 和必要数据，不传输用户表内容；可启用本地模型 |
| 凭证保护 | OS keychain + 加密存储 |
| 写操作管控 | 询问模式 + 危险操作清单 + 影响行数预估 |
| 只读模式 | DB 用户级别限制 + agent 工具白名单双重保障 |
| 审计日志 | 所有 SQL 执行可追溯 |
| 工具沙箱 | MCP 子进程隔离 + 资源限制 |
| 中止机制 | 用户可随时中止任何 agent 行为 |

---

## 16. 模块化与扩展点

| 扩展点 | 接口 | 用途 |
|---|---|---|
| 新数据库适配 | `IDatabaseExtractor`, SQL 工具 | 加 MySQL/Oracle |
| 新 LLM 提供商 | `ILlmProvider` | 加新模型 |
| 新 Agent 策略 | `IStrategy` | 加 Reflexion / Tree of Thoughts |
| 新工具来源 | `ITool` | 自定义工具来源 |
| 新 Skill 模板 | YAML schema | 团队定制 Skill |
| 检索器替换 | `IRetriever` | 实验新 RAG 方案 |

---

## 17. 待定与未来

- [ ] **多模态**：让 agent 理解 ER 图截图 / Excel 截图
- [ ] **自主写代码**：agent 能写 Python 处理脚本（沙箱执行）
- [ ] **实时数据流**：订阅数据库变更，做增量分析
- [ ] **Agent 训练数据**：从用户反馈构建训练集，未来微调小模型
- [ ] **多 Agent 协作（CrewAI 风格）**：DBA agent + Analyst agent + Reporter agent
- [ ] **跨数据库 Agent**：同时操作多个数据库
