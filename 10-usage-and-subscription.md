# 10 - 用量计量与订阅体系（Usage & Subscription）

> 文档版本：v0.1
> 关联：[03-agent-design.md](./03-agent-design.md), [04-config-design.md](./04-config-design.md)

---

## 1. 为什么必须从一开始就做

订阅制不能"上线后再加"，原因：

1. **渗透深**：用量计量贯穿 LLM Router、Agent Loop、Session、UI，事后插入需要改几乎所有模块
2. **用户期望**：付费用户对"额度可见性"要求极高，UI 必须早早设计好
3. **数据基础**：没有从第一天起记录用量数据，后期无法分析用户行为做定价
4. **接入合规**：注册/登录系统不是一周能搭好的，需要后端服务、邮件、风控等

**所以 M1 起就必须有**：本地用量记录 + 注册/登录后台 + 订阅验证骨架。

---

## 2. 商业模式总览

### 2.1 双路径：BYOK 与订阅并存

```
                    ┌──────────────┐
                    │ DBAgent App  │
                    └───────┬──────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
       ┌──────────────┐           ┌──────────────┐
       │  路径 A      │           │  路径 B       │
       │  BYOK        │           │  订阅         │
       │  (免费)      │           │  (付费)       │
       └──────┬───────┘           └──────┬───────┘
              │                          │
              ▼                          ▼
    ┌────────────────────┐    ┌─────────────────────┐
    │ 用户自己的         │    │ 我们的 API Gateway  │
    │ LLM endpoint       │    │  (登录后访问)       │
    │ (DeepSeek/OpenAI/  │    │                     │
    │  Ollama/vLLM/...)  │    │  → 后端代理调真      │
    └────────────────────┘    │    实 LLM provider   │
                              └─────────────────────┘
```

### 2.2 两条路径的对比

| 维度 | BYOK | 订阅 |
|---|---|---|
| 是否需要登录 | ❌ 不需要 | ✅ 必须注册登录 |
| 是否联网 | ❌ 可完全离线（用 Ollama） | ✅ 必须联网走我们的 gateway |
| LLM 凭证 | 用户自己的 API key | 我们的（用户不见） |
| 计费 | 用户自己承担 | 包含在订阅费中 |
| 用量限制 | 无（受用户自己 key 限制） | 时间窗口配额（如 5h N 轮） |
| 隐私 | prompt 直发用户配置的 endpoint | prompt 经过我们的 gateway |
| 高级功能 | 全部可用 | 全部可用 |
| 私有化部署 | ✅ 适合 | ❌ 不适合 |

**关键决策**：
- BYOK 不锁任何功能（包括 Skill / MCP / 工作空间 / Python）
- 订阅的核心价值是 **"我代你付 LLM 费用"** + **"省去 API key 申请配置"**
- 这与 Cursor / Claude Code 的订阅模式一致

### 2.3 为什么选这种模式

- **降低门槛**：很多用户不会申请 API key、不知道怎么充值
- **可预期成本**：固定订阅费比按 token 付费心理负担小
- **私域用户友好**：不愿用我们的 LLM 的用户也能用产品（BYOK）
- **国内合规**：用我们的 gateway 时我们承担合规风险，用户清爽

---

## 3. 计量维度选型

### 3.1 选定：时间窗口制（参考 Claude Code）

**核心规则**：每 N 小时内可执行 M 次 Agent 对话（轮次）。

```
Free 试用版：
  - 每 24 小时 10 轮 Agent 对话
  - 限 deepseek-chat / 同等价位模型

Pro 订阅版：
  - 每 5 小时 100 轮 Agent 对话
  - 可选 DeepSeek-V3 / Claude Sonnet 等

Team 订阅版：
  - 每 5 小时 300 轮 Agent 对话
  - 全模型支持
```

> 具体配额数值是**示例**，根据后续真实用户用量与成本测算决定。

### 3.2 为什么选时间窗口而非 token 总量

| 选项 | 优 | 劣 | 选用 |
|---|---|---|---|
| Token 总量 | 成本可控 | 用户难感知（"我是不是快用完了？"） | ❌ |
| 月配额 | 直觉 | 用户月初挥霍月末没得用 | ❌ |
| **滑动时间窗口** | **直觉 + 防滥用 + 自然恢复** | 高频用户体验受限 | ✅ |
| Credit 点数 | 灵活 | 用户需要学习概念 | ❌ |

时间窗口的好处：
- 滑动窗口（不是固定每天 0 点重置），用户感觉"用了一会儿等等就好了"
- 防止单用户长期占用资源
- 与 Claude Code / Codex 用户已熟悉的模式一致

### 3.3 "一轮对话"如何定义

**一轮 = 一次用户输入 → 一次完整的 Agent 响应（含所有 tool calls 和子 agent）**

```
用户：分析 GMV 下降原因
   ↓
Agent loop：
  - 调用 search_schema (1)
  - 调用 query_database (2)
  - 调用 query_database (3)
  - spawn_subagents (4)
    - 子 Agent A: query_database
    - 子 Agent B: query_database
  - 调用 generate_report (5)
  - 输出结论
   ↓
[计 1 轮]
```

**注意**：
- 中途用户中止 → **仍计 1 轮**（资源已消耗）
- 中途因系统错误失败 → **不计**（不能让用户为我们的 bug 买单）
- 用户在 SQL 编辑器手动跑 SQL → **不计**（不走 LLM）
- 仅 Embedding 调用（如 RAG 索引）→ **不计**（成本低，不限）

### 3.4 配额触发后的行为

```
用户即将达到配额（剩余 ≤ 10%）
  ↓
顶部 banner 提示："您还有 8 轮对话，下次重置时间 14:30"
  ↓
配额耗尽
  ↓
弹窗：
  ┌─ 用量已用完 ─────────────────────────┐
  │ 当前 5 小时窗口内已用 100/100 轮     │
  │ 下次重置：14:30 (还有 1 小时 23 分)  │
  │                                      │
  │ 选项：                               │
  │  [💳 升级到更高级套餐]               │
  │  [🔑 切换到 BYOK 模式]               │
  │  [⏰ 等待重置]                        │
  └──────────────────────────────────────┘
```

**关键**：配额耗尽不影响：
- SQL 编辑器手动操作
- 表数据浏览/编辑
- 已有会话的查看
- 仅"发起新的 Agent 对话"被禁用

---

## 4. 后台架构

### 4.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                  DBAgent Desktop (Client)                     │
│                                                              │
│   ┌──────────────────┐     ┌────────────────────────────┐    │
│   │ Auth Manager     │     │ Usage Tracker (本地)        │    │
│   │ - 登录/Token     │     │ - 记录每次 Agent 调用       │    │
│   │ - JWT 存 keychain│     │ - 缓存配额状态              │    │
│   └────────┬─────────┘     └─────────────┬──────────────┘    │
│            │                             │                    │
│            ▼                             ▼                    │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  LLM Router                                          │    │
│   │  ┌─ BYOK Branch ─┐    ┌─ Subscription Branch ────┐  │    │
│   │  │ Direct call to│    │ Call our gateway with JWT│  │    │
│   │  │ user endpoint │    │ + usage check            │  │    │
│   │  └───────────────┘    └──────────────────────────┘  │    │
│   └────────┬─────────────────────────────┬────────────────┘   │
└────────────┼─────────────────────────────┼──────────────────┘
             │                             │
             ▼                             ▼
   ┌──────────────────┐         ┌──────────────────────────┐
   │ User's LLM       │         │  Our Backend             │
   │ (DeepSeek/       │         │  ┌────────────────────┐  │
   │  OpenAI/         │         │  │ Auth Service       │  │
   │  Ollama/...)     │         │  │ - 注册/登录/JWT    │  │
   └──────────────────┘         │  └────────────────────┘  │
                                │  ┌────────────────────┐  │
                                │  │ LLM Gateway        │  │
                                │  │ - 用量计量         │  │
                                │  │ - 限流             │  │
                                │  │ - 模型路由         │  │
                                │  └─────────┬──────────┘  │
                                │            │             │
                                │  ┌─────────▼──────────┐  │
                                │  │ Real LLM Providers │  │
                                │  │ - DeepSeek         │  │
                                │  │ - Anthropic        │  │
                                │  │ - OpenAI           │  │
                                │  └────────────────────┘  │
                                │  ┌────────────────────┐  │
                                │  │ Subscription Mgmt  │  │
                                │  │ - 套餐/订单/支付    │  │
                                │  └────────────────────┘  │
                                └──────────────────────────┘
```

### 4.2 后端服务模块

| 服务 | 职责 |
|---|---|
| **Auth Service** | 注册、登录、JWT 签发、刷新、找回密码 |
| **User Service** | 用户资料、订阅状态、设备绑定 |
| **LLM Gateway** | 接收客户端 LLM 请求，做用量校验，转发到真实 provider，记录用量 |
| **Subscription Service** | 套餐定义、订单、支付回调、续订 |
| **Usage Service** | 用量统计、配额管理、滑动窗口计算 |
| **Notification** | 邮件验证、付款成功/失败通知 |

### 4.3 技术选型（建议）

> 后端不在本设计文档主线，但建议组合：

| 组件 | 选型 | 理由 |
|---|---|---|
| 语言 | Node.js (TS) | 与客户端同语言，复用类型定义 |
| 框架 | Hono / Fastify | 轻量、性能好 |
| 数据库 | PostgreSQL | 用量数据天然适合 |
| 缓存 | Redis | 滑动窗口计数、限流 |
| LLM 转发 | 直接 HTTP 反代 | 不引入中间件复杂度 |
| 部署 | Docker + 单 VPS（早期） | 成本可控，扩展时再上云 |
| 支付 | 国内：微信支付/支付宝；海外：Stripe | 按市场分别集成 |

### 4.4 用量记录的数据模型

#### 客户端本地（SQLite）

```sql
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,         -- unix ms

  -- 本次调用的元信息
  mode TEXT NOT NULL,                    -- 'byok' | 'subscription'
  model_ref TEXT NOT NULL,               -- 'deepseek:deepseek-chat'

  -- Token 维度（始终记录，便于用户查看）
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,

  -- 订阅维度
  conversation_round_id TEXT,            -- 一轮对话的 id
  is_round_start INTEGER,                -- 是否本轮第一次调用

  -- 成本估算（BYOK 用，订阅模式置 NULL）
  estimated_cost_usd REAL,

  -- 上报状态（订阅模式专用）
  reported_at INTEGER,                   -- 已上报到后端的时间
  server_record_id TEXT                  -- 后端返回的记录 id
);

CREATE INDEX idx_usage_session ON usage_records(session_id);
CREATE INDEX idx_usage_time ON usage_records(occurred_at);
CREATE INDEX idx_usage_round ON usage_records(conversation_round_id);
CREATE INDEX idx_usage_unreported ON usage_records(reported_at) WHERE reported_at IS NULL;
```

#### 服务端

```sql
-- 用户表
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,                    -- argon2
  display_name TEXT,
  created_at TIMESTAMPTZ,
  email_verified BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active'           -- 'active' | 'suspended' | 'deleted'
);

-- 订阅表
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  plan_id TEXT NOT NULL,                 -- 'free' | 'pro' | 'team'
  status TEXT NOT NULL,                  -- 'trialing' | 'active' | 'past_due' | 'canceled'
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- 用量记录（聚合的）
CREATE TABLE conversation_rounds (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  device_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  status TEXT,                           -- 'success' | 'aborted' | 'failed'
  total_tokens INTEGER,
  model TEXT,
  metadata JSONB                         -- 不含 prompt 内容，仅元数据
);

CREATE INDEX idx_rounds_user_time ON conversation_rounds(user_id, started_at);

-- 套餐配额定义
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                   -- 'free' | 'pro' | 'team'
  display_name TEXT,
  window_hours INTEGER,                  -- 5
  rounds_per_window INTEGER,             -- 100
  allowed_models JSONB,                  -- ['deepseek-v3', 'claude-sonnet-4']
  monthly_price_usd NUMERIC,
  monthly_price_cny NUMERIC
);

-- 设备绑定（防滥用）
CREATE TABLE devices (
  id TEXT PRIMARY KEY,                   -- 设备 fingerprint
  user_id UUID REFERENCES users(id),
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  os TEXT,
  app_version TEXT
);
```

---

## 5. JWT + 离线宽限

### 5.1 用户决策的精髓

> 用我们的 LLM → 必须联网验证；用 BYOK / 本地模型 → 完全不需要联网。

但即使是订阅用户，也不能要求"每次调用都同步验证"（延迟、可用性）。所以采用：

### 5.2 JWT 长效 + 短期续签

```
1. 登录：发放 access_token (1h) + refresh_token (30 天)
   - access_token: JWT，含 user_id, plan, allowed_models
   - 客户端 keychain 存储

2. 每次 LLM 调用：
   - access_token 有效 → 走 gateway
   - access_token 过期 → 后台用 refresh_token 静默换新

3. 完全离线时：
   - access_token 缓存配额信息
   - 仍可走 BYOK / 本地模型（无需联网验证）
   - 不能走我们的 gateway（对方需要验证 token）

4. 离线宽限：
   - refresh_token 30 天有效，过期后强制重新登录
   - 离线 7 天提示"建议联网刷新订阅状态"
```

### 5.3 JWT Payload 设计

```json
{
  "iss": "dbagent",
  "sub": "user-uuid",
  "iat": 1716123456,
  "exp": 1716127056,
  "plan": "pro",
  "plan_period_end": "2026-06-20T00:00:00Z",
  "allowed_models": ["deepseek-v3", "claude-sonnet-4"],
  "device_id": "fp-abc123"
}
```

注意：
- 不放敏感信息（密码、支付）
- `allowed_models` 让客户端可离线判断"模型是否可用"
- `plan_period_end` 让客户端可离线显示"订阅到期时间"

### 5.4 Token 撤销

- 用户主动登出：客户端清除 + 后端 refresh_token 拉黑
- 异常登录：后端 admin 接口可强制撤销
- 订阅取消：在新一轮 access_token 里更新 plan，老的 1 小时内自然失效

---

## 6. 客户端用量追踪（Usage Tracker）

### 6.1 核心组件

```typescript
// packages/core-usage/src/tracker.ts

export interface IUsageTracker {
  /** 一轮对话开始 */
  startConversationRound(sessionId: string, mode: 'byok' | 'subscription'): RoundContext;

  /** 记录一次 LLM 调用 */
  recordLlmCall(round: RoundContext, usage: LlmUsage): Promise<void>;

  /** 一轮对话结束 */
  endConversationRound(round: RoundContext, status: 'success' | 'aborted' | 'failed'): Promise<void>;

  /** 获取当前窗口剩余配额 */
  getCurrentQuota(): Promise<QuotaStatus>;

  /** 监听配额变化 */
  onQuotaChange(callback: (q: QuotaStatus) => void): () => void;
}

export interface RoundContext {
  id: string;
  sessionId: string;
  mode: 'byok' | 'subscription';
  startedAt: number;
}

export interface LlmUsage {
  modelRef: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface QuotaStatus {
  mode: 'byok' | 'subscription';
  windowHours: number;
  roundsUsed: number;
  roundsLimit: number;
  windowResetAt: number;            // unix ms
  modelsAllowed: string[];
}
```

### 6.2 与 Agent Loop 的集成

```typescript
// packages/core-agent/src/loop.ts

async function runAgentLoop(session, userMessage, options) {
  // 1. 检查配额（订阅模式）
  if (options.mode === 'subscription') {
    const quota = await usageTracker.getCurrentQuota();
    if (quota.roundsUsed >= quota.roundsLimit) {
      return { status: 'quota_exceeded', resetAt: quota.windowResetAt };
    }
  }

  // 2. 开启一轮
  const round = usageTracker.startConversationRound(session.id, options.mode);

  try {
    while (...) {
      // ... LLM 调用 ...
      const response = await llmRouter.stream(req, { round });

      // 自动记录用量（在 router 内部）
    }

    await usageTracker.endConversationRound(round, 'success');
    return { status: 'done', ... };
  } catch (e) {
    await usageTracker.endConversationRound(round,
      e.code === 'aborted' ? 'aborted' : 'failed'
    );
    throw e;
  }
}
```

### 6.3 LLM Router 的双分支

```typescript
// packages/core-llm/src/router.ts

class LlmRouter {
  async chatStream(req: ChatRequest & { round?: RoundContext }) {
    const provider = this.resolveProvider(req.modelRef);

    if (provider.type === 'subscription-managed') {
      // 走我们的 gateway
      return this.callViaSubscription(req);
    } else {
      // BYOK 直连
      return this.callDirect(req);
    }
  }

  private async *callViaSubscription(req) {
    const token = await authManager.getAccessToken();
    if (!token) throw new NotLoggedInError();

    const stream = fetch('https://api.dbagent.io/v1/chat/completions', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });

    let usage: LlmUsage = { ... };
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;  // 服务端最后一个 chunk 含 usage
      yield chunk;
    }

    await usageTracker.recordLlmCall(req.round, usage);
  }

  private async *callDirect(req) {
    // BYOK 直连用户配置的 endpoint
    const stream = directProvider.stream(req);

    let usage = { ... };
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      yield chunk;
    }

    // 仅本地记录，不上报后端
    await usageTracker.recordLlmCall(req.round, usage);
  }
}
```

### 6.4 滑动窗口的实现

```typescript
async getCurrentQuota(): Promise<QuotaStatus> {
  const plan = authManager.currentPlan;  // from JWT
  if (plan.id === 'byok' || plan.id === 'unlimited') {
    return { roundsLimit: Infinity, ... };
  }

  // 客户端先用本地数据估算
  const windowStart = Date.now() - plan.windowHours * 3600 * 1000;
  const localCount = await db.count('conversation_rounds',
    { user_id: currentUserId, started_at: { gte: windowStart } }
  );

  // 定期与服务端同步（避免多设备数据不一致）
  if (Date.now() - this.lastSyncAt > 60_000) {
    const serverQuota = await api.getQuota();
    this.lastSyncAt = Date.now();
    return serverQuota;
  }

  return {
    roundsUsed: localCount,
    roundsLimit: plan.roundsPerWindow,
    windowResetAt: this.computeNextReset(localCount, plan),
    ...
  };
}
```

### 6.5 上报队列（订阅模式）

```typescript
// 后台定期把未上报的本地记录推到服务端
class UsageReporter {
  async tick() {
    const unreported = await db.findUnreported();
    if (unreported.length === 0) return;

    try {
      const result = await api.batchReportUsage(unreported);
      await db.markReported(result);
    } catch (e) {
      // 网络失败重试，不阻塞用户
      logger.warn('usage report failed, will retry', e);
    }
  }
}
```

---

## 7. UI 设计

### 7.1 顶部状态栏

```
┌──────────────────────────────────────────────────────────────┐
│ [≡] DBAgent  [连接 ▾] [模式 ▾]  [👤 alice]  [⚡ 87/100 · 2h] │
└──────────────────────────────────────────────────────────────┘
                                              ↑
                                       配额状态指示器
```

**指示器规则**：
- 订阅用户：`⚡ 已用/总数 · 重置时间`
- BYOK 用户：`💎 BYOK · 总 token: 1.2k` 或不显示
- 即将耗尽（< 20%）：橙色
- 耗尽：红色 + 弹出提示

### 7.2 用量面板（设置 → 账号）

```
┌─ 账号与用量 ─────────────────────────────────────────────────┐
│                                                              │
│  alice@example.com                            [👤 编辑]      │
│  套餐: Pro Plan                              [💳 管理订阅]   │
│  续订日: 2026-06-20                                          │
│                                                              │
│  ── 当前用量 ──                                              │
│                                                              │
│  Agent 对话                                                  │
│  ████████████████░░░░  87 / 100 轮                           │
│  下次重置: 14:30 (1h 23m 后)                                 │
│                                                              │
│  ── Token 统计 (本月) ──                                     │
│                                                              │
│  Prompt tokens:       1,234,567                              │
│  Completion tokens:     456,789                              │
│  总计:                1,691,356                              │
│                                                              │
│  ── 历史 ──                                                  │
│                                                              │
│  [查看本周历史]  [查看本月历史]  [📥 导出 CSV]               │
│                                                              │
│  ── 模式切换 ──                                              │
│                                                              │
│  ● 使用我们的 LLM (订阅)                                     │
│  ○ BYOK (用我自己的 API key)                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 7.3 用量历史

```
┌─ 用量历史 · 本周 ──────────────────────────────────────┐
│                                                        │
│  日期         轮数   总 token   主要模型              │
│  ─────────────────────────────────────────────────────│
│  2026-05-20    23    234,567   deepseek-chat          │
│  2026-05-19    45    412,890   claude-sonnet          │
│  2026-05-18    12    123,456   deepseek-chat          │
│                                                        │
│  ── 按会话 ──                                          │
│  会话 #128    GMV 分析       12 轮  234,567 tokens     │
│  会话 #127    用户清洗        8 轮  189,234 tokens     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 7.4 登录/注册流程

#### 7.4.1 启动屏新增

```
启动时检测：
  - 已登录 → 跳过登录界面
  - 未登录 + 选订阅模式 → 弹出登录
  - 未登录 + BYOK → 直接进入主界面（仅引导一次）
```

#### 7.4.2 登录界面

```
┌────────────────────────────────────────────────────┐
│              欢迎使用 DBAgent                       │
│                                                    │
│  ┌─ 登录账号 ────────────────────────────────────┐ │
│  │  邮箱  [_____________________________]       │ │
│  │  密码  [_____________________________]       │ │
│  │                                              │ │
│  │           [登录]                              │ │
│  │                                              │ │
│  │  忘记密码？  · 注册新账号                     │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ── 或 ──                                          │
│                                                    │
│  [💎 使用 BYOK 模式（不登录）]                     │
│                                                    │
└────────────────────────────────────────────────────┘
```

#### 7.4.3 注册界面

```
注册流程：
  1. 邮箱 + 密码
  2. 邮箱验证（发送验证码）
  3. 选择套餐（Free / Pro / Team）
  4. Free → 直接激活
     付费 → 跳转支付（微信/支付宝/Stripe）
  5. 完成 → 进入主界面
```

### 7.5 配额警告

#### 软警告（剩余 ≤ 20%）
```
顶部 banner（橙色）：
  ⚡ 您还有 18 轮 Agent 对话可用，下次重置 14:30
  [升级到 Team] [使用 BYOK]                       [×]
```

#### 硬限制（耗尽）
```
弹窗：见 §3.4
```

---

## 8. 价格策略（参考，待定）

### 8.1 套餐分级

| 套餐 | 月费（CNY） | 时间窗口 | 轮数 | 可用模型 |
|---|---|---|---|---|
| **Free** | ¥0 | 24h | 10 | 仅 deepseek-chat |
| **Pro** | ¥99 | 5h | 100 | deepseek-v3, claude-sonnet, gpt-4o-mini |
| **Team** | ¥299 | 5h | 300 | 全部 |
| **Enterprise** | 联系销售 | 自定义 | 自定义 | 全部 + 私有化 |

> 数字仅为参考，实际依成本测算定。

### 8.2 BYOK 始终免费

明确写在官网：
> "如果您有自己的 API key，DBAgent 完全免费。订阅版本是为了让您不必管理 API key、付 LLM 费用。"

### 8.3 试用机制

新注册用户自动给 14 天 Pro 试用（无需付款）。

---

## 9. 多设备与防滥用

### 9.1 设备绑定

订阅账户限制同时活跃设备数：
- Free / Pro：3 台
- Team：5 台 / 用户

实现：
- 客户端首次登录生成 `device_id`（机器 fingerprint）
- 服务端 `devices` 表记录
- 超出限制时让用户主动注销其他设备

### 9.2 滥用检测

后端监控异常模式：
- 单用户 1 小时内来自 10+ IP（可能账号共享）
- 单用户单轮 token 异常高（可能压测）
- 单 IP 大量注册（机器人）

发现后：风控降级（限流、要求重新验证、拉黑）。

### 9.3 退款条款

- 月付：随时取消，剩余时间不退
- 年付：14 天内全额退，之后按月折算
- 异常账号（违反 ToS）：不退

---

## 10. 与现有文档的修订

### 10.1 需要更新的文档

| 文档 | 更新内容 |
|---|---|
| [00-overview.md](./00-overview.md) | 加入"用量与订阅"模块 |
| [03-agent-design.md](./03-agent-design.md) | Agent loop 集成 usageTracker |
| [04-config-design.md](./04-config-design.md) | LLM Provider 增加 `subscription-managed` 类型 |
| [05-development-guide.md](./05-development-guide.md) | M1 任务清单加入注册/登录骨架 |
| [09-error-recovery.md](./09-error-recovery.md) | 配额检查失败的恢复 |

### 10.2 新增 LLM Provider 类型

```typescript
// 04-config-design.md 中增加
export type LlmProviderType =
  | 'openai-compatible'
  | 'anthropic'
  | 'azure-openai'
  | 'subscription-managed'    // ← 新增：走我们的 gateway
  | 'custom';
```

订阅模式下，UI 上提供"使用 DBAgent 托管模型"作为一个特殊 Provider 选项，用户不需要填 endpoint / apiKey，只需要登录。

---

## 11. 实现优先级

### 11.1 M1（必做骨架）

> 不能跳过。即使 Free 版本也要把整套验证骨架立起来，避免后期重构。

- [ ] 客户端 Auth Manager（登录/JWT/keychain 存储）
- [ ] 客户端 Usage Tracker（本地 SQLite 记录）
- [ ] LLM Router 区分 BYOK / Subscription 分支
- [ ] 顶部用量指示器
- [ ] 登录/注册 UI（基础）
- [ ] 启动时账号状态检测
- [ ] 后端：Auth Service + 简单的用户表
- [ ] 后端：LLM Gateway 最小可用版（仅转发 + 记录）

### 11.2 M3（与 Agent 上线一起）

- [ ] Agent Loop 集成 usageTracker
- [ ] 配额检查 + 软/硬警告
- [ ] 用量面板（设置 → 账号）
- [ ] 配额耗尽弹窗

### 11.3 M5

- [ ] 用量历史页面
- [ ] 上报队列（异步同步）
- [ ] 离线宽限策略

### 11.4 M7（发布前）

- [ ] 套餐管理 UI
- [ ] 支付集成（先国内：微信支付/支付宝）
- [ ] 设备绑定 + 多设备管理
- [ ] 后端风控
- [ ] 退款流程

### 11.5 不进 MVP

- ❌ 团队管理（Team plan 的座位管理 → v1.1）
- ❌ 发票开具（v1.1）
- ❌ 联盟营销 / 推荐码（v1.2）
- ❌ 复杂的用量分析仪表板（v1.2）

---

## 12. 关键安全考量

### 12.1 凭证保护

- access_token / refresh_token 存 OS keychain
- 永不打日志
- 永不进 renderer 进程（renderer 通过 IPC 间接发起请求）

### 12.2 API Gateway 安全

- 所有客户端请求 HTTPS
- JWT 验证 + 速率限制
- 请求体大小限制（防止异常大 prompt 打爆）
- 内置 LLM provider key 仅服务端持有，绝不发给客户端

### 12.3 防 prompt 注入计费攻击

- 用户不能通过特殊 prompt 让一次调用产生异常多 token
- 服务端有 max_tokens 硬上限
- 单轮对话总 token 上限（防止无限循环）

### 12.4 隐私

- 后端的用量记录**不存 prompt 内容**，仅元数据
- 用户可在设置中关闭"上传匿名错误日志"
- 用户可申请数据导出/删除（GDPR）

---

## 13. 与设计宗旨对齐

| 宗旨 | 体现 |
|---|---|
| **轻量化** | 客户端只多一个 Auth + Tracker 模块，本地用 SQLite，无新依赖 |
| **模块化** | LLM Router 增加分支，对其他模块零侵入；Subscription 是可选 Provider 类型 |
| **简洁科技感** | 顶部指示器一个数字 + 一个时间，不喧宾夺主；登录界面极简 |
| **用户体验** | BYOK 用户完全无感（不强制登录）；订阅用户配额可视、可预期；离线宽限保证可用性 |

---

## 14. 反向清单

> 这些**不做**：

- ❌ 复杂的 metering 系统（如 Lago / OpenMeter） — 自己写够用
- ❌ 实时计费提示（每次调用都显示 token 数） — 干扰流畅度
- ❌ 多 tier 限流（按模型/按工具差异化） — 时间窗口足够
- ❌ 团队共享配额池（v1.x） — 简化早期实现
- ❌ Pay-as-you-go（按用量付费） — 与"订阅"哲学冲突
- ❌ 加密货币支付 — 合规复杂
- ❌ 自建支付网关 — 用第三方（Stripe / 微信）

---

## 15. 待定与未来

- [ ] **跨平台账号**：Web 版本上线后，账号能跨桌面 ↔ Web 同步
- [ ] **教育/学生折扣**
- [ ] **企业 SSO**：Okta / SAML / OIDC（企业版）
- [ ] **使用分析仪表板**：用户能看到自己最常用的工具、最长会话等（v1.x）
- [ ] **配额灵活借用**：今天没用满，借给明天（v1.x）
- [ ] **冷启动：邀请码/早鸟**：beta 期间发邀请码控制速度
- [ ] **支付集成的具体方案**：单独的支付集成文档（v1 前补）
