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

### 5.2 内置工具清单

| 工具 | 描述 | 危险等级 |
|---|---|---|
| `search_schema` | RAG 检索 schema | 安全 |
| `describe_table` | 获取表详细 schema | 安全 |
| `list_tables` | 列出表 | 安全 |
| `query_database` | 执行 SELECT | 中（影响行数） |
| `execute_sql` | 执行任意 SQL（含写） | 高（写操作） |
| `explain_sql` | EXPLAIN 分析 | 安全 |
| `dry_run_sql` | 预估影响行数 | 安全 |
| `get_sample_rows` | 获取样本数据 | 安全（脱敏） |
| `read_query_history` | 读取历史查询 | 安全 |
| `spawn_subagents` | 创建子 agent | 中 |
| `web_search` | 网页搜索（可选） | 安全 |

### 5.3 统一工具接口

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

### 5.4 MCP 集成

#### 5.4.1 MCP Client 架构

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

#### 5.4.3 Smithery / mcp.so 市场对接

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

### 5.5 工具调用的安全控制

#### 5.5.1 工具白名单
每个 session / 模式有独立的工具白名单：
- 只读模式：只允许 `*_read`, `*_describe`, `query_database` (限 SELECT)
- 询问模式：所有工具可调，但 `danger_level >= medium` 必须用户确认
- 自动模式：所有工具自动执行，但 `danger_level == high` 仍要求确认

#### 5.5.2 工具调用配额
- 单 session 工具调用上限：默认 50 次
- 单 tool 调用超时：默认 60 秒
- MCP 进程内存限制：默认 512MB

#### 5.5.3 工具沙箱（未来）
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

当 token 接近上限时：

```
策略优先级（从轻到重）：
1. 折叠"已完成"的子 agent 详细日志
2. 压缩重复的 schema 注入（已检索过的不重复）
3. 工具结果摘要化（用 LLM 写 summary 替代原始数据）
4. 早期消息归档（保留 system + 最近 N 轮 + summary）
```

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
