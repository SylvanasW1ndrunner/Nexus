# 04 - 配置设计（Configuration & LLM Provider）

> 文档版本：v0.1
> 关联：[00-overview.md](./00-overview.md), [03-agent-design.md](./03-agent-design.md)
>
> **路线校准（2026-07-21）**：配置边界从 Electron IPC-first 调整为 Runtime/Server-first。H1 的模型和数据库 Secret 仅保存在本地 Server 进程内存中，WebUI 不回显、不落盘；环境变量由 Server 装配层读取。OS Keychain、团队 Secret、配置同步和完整设置 UI 均延后。

---

## 1. 配置体系总览

### 1.1 三层配置

```
┌────────────────────────────────────────────┐
│  Layer 1: User Settings (全局用户偏好)       │
│  - 主题、语言、快捷键                        │
│  - 默认 LLM Provider                        │
│  - 默认 Agent 模式                          │
│  存储: ~/.dbagent/settings.json             │
├────────────────────────────────────────────┤
│  Layer 2: Connection Settings (每个连接)    │
│  - DB host/port/credentials                 │
│  - 连接级覆盖（默认只读、自动 LIMIT 等）     │
│  存储: ~/.dbagent/connections.json          │
│        + OS keychain (敏感字段)             │
├────────────────────────────────────────────┤
│  Layer 3: Session Settings (单次会话)        │
│  - 临时切换的模型 / 模式                     │
│  - Token 预算                                │
│  存储: SQLite sessions 表                   │
└────────────────────────────────────────────┘
```

### 1.2 优先级

`Session > Connection > User > 应用默认`

例：用户全局默认询问模式，但某个连接上设置了"自动模式"，且本次会话临时切到"完全自动"，则本次会话生效"完全自动"。

### 1.3 文件位置

| 文件 | 位置 | 内容 |
|---|---|---|
| `settings.json` | `~/.dbagent/` | 全局设置（非敏感） |
| `connections.json` | `~/.dbagent/` | 连接元信息（不含密码） |
| `mcp.json` | `~/.dbagent/` | MCP server 配置 |
| `sessions.db` | `~/.dbagent/` | 所有会话历史 |
| `rag/*.db` | `~/.dbagent/rag/` | 每个连接的 RAG 数据 |
| `skills/*.yaml` | `~/.dbagent/skills/` | 用户 Skills |
| `logs/*.jsonl` | `~/.dbagent/logs/` | 审计日志 |
| OS keychain | macOS Keychain / Windows Cred Mgr / libsecret | DB 密码、API key |

---

## 2. LLM Provider 配置

### 2.1 设计原则

1. **统一 endpoint + apikey 模型**：所有 OpenAI 兼容服务都走同一套配置
2. **多 Provider 并存**：用户可同时配置 DeepSeek + Claude + 本地 Ollama
3. **细粒度选择**：不同任务（chat / embedding / 工具调用）可用不同 Provider
4. **本地优先选项**：Ollama / vLLM 一等公民
5. **零侵入升级**：新增 Provider 只需配置，不改代码

### 2.2 Provider 类型

我们抽象为五类 Provider：

| 类型 | 示例 | 特征 |
|---|---|---|
| `subscription-managed` | "DBAgent 托管模型" | 走我们的 gateway，需登录，订阅用户专用 |
| `openai-compatible` | OpenAI, DeepSeek, 智谱, Moonshot, 硅基流动, Ollama, vLLM, OpenRouter | 用 OpenAI SDK 直接通（BYOK） |
| `anthropic` | Claude API | Anthropic 原生格式（BYOK） |
| `azure-openai` | Azure OpenAI | OpenAI 风格但路径有差异（BYOK） |
| `custom` | 用户自定义 | 提供 adapter 函数 |

> **MVP 阶段实现 `subscription-managed` + `openai-compatible` + `anthropic` 即可覆盖 95% 需求**

> **`subscription-managed` 详见 [10-usage-and-subscription.md](./10-usage-and-subscription.md)**：
> - 用户不填 endpoint / apiKey
> - 客户端用登录获得的 JWT 调用 `https://api.dbagent.io/v1/chat/completions`
> - 后端代理到真实 LLM provider 并记录用量
> - 配额按时间窗口（5h N 轮）限制

### 2.3 Provider 配置数据模型

```typescript
// src/main/config/types.ts

export interface LlmProviderConfig {
  id: string;                    // uuid
  name: string;                  // "DeepSeek"
  type: 'openai-compatible' | 'anthropic' | 'azure-openai' | 'custom';

  // 连接
  endpoint: string;              // "https://api.deepseek.com/v1"
  apiKey?: string;               // 不存这里，存 keychain，仅放引用
  apiKeyRef?: string;            // keychain key
  extraHeaders?: Record<string, string>;

  // 模型
  models: ModelConfig[];

  // 类型特定字段
  azureDeploymentMap?: Record<string, string>;
  organizationId?: string;       // OpenAI org

  // 行为
  timeout?: number;              // 默认 60s
  maxRetries?: number;           // 默认 2
  enabled: boolean;
}

export interface ModelConfig {
  id: string;                    // 调用时用的模型名 "deepseek-chat"
  displayName: string;           // 用户看的 "DeepSeek V3"
  capabilities: ModelCapability[];  // ['chat', 'tool_calling', 'vision', ...]
  contextWindow: number;         // 128_000
  maxOutputTokens?: number;
  pricing?: {                    // 用于成本估算（每百万 token）
    input: number;
    output: number;
    currency: 'USD' | 'CNY';
  };
}

export type ModelCapability =
  | 'chat'
  | 'tool_calling'
  | 'streaming'
  | 'vision'
  | 'embedding'
  | 'json_mode';
```

### 2.4 默认 Provider 模板

应用首次启动时预置这些 Provider 模板（用户填 key 后即可用）：

```json
{
  "templates": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "type": "openai-compatible",
      "endpoint": "https://api.deepseek.com/v1",
      "models": [
        {
          "id": "deepseek-chat",
          "displayName": "DeepSeek V3",
          "capabilities": ["chat", "tool_calling", "streaming", "json_mode"],
          "contextWindow": 64000,
          "pricing": { "input": 0.27, "output": 1.10, "currency": "USD" }
        },
        {
          "id": "deepseek-reasoner",
          "displayName": "DeepSeek R1",
          "capabilities": ["chat", "streaming"],
          "contextWindow": 64000,
          "pricing": { "input": 0.55, "output": 2.19, "currency": "USD" }
        }
      ]
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "openai-compatible",
      "endpoint": "https://api.openai.com/v1",
      "models": [
        { "id": "gpt-4o", "displayName": "GPT-4o", "capabilities": ["chat", "tool_calling", "streaming", "vision", "json_mode"], "contextWindow": 128000 },
        { "id": "gpt-4o-mini", "displayName": "GPT-4o mini", "capabilities": ["chat", "tool_calling", "streaming", "vision", "json_mode"], "contextWindow": 128000 },
        { "id": "text-embedding-3-small", "displayName": "Embedding 3 Small", "capabilities": ["embedding"], "contextWindow": 8192 }
      ]
    },
    {
      "id": "anthropic",
      "name": "Anthropic Claude",
      "type": "anthropic",
      "endpoint": "https://api.anthropic.com",
      "models": [
        { "id": "claude-sonnet-4", "displayName": "Claude Sonnet 4", "capabilities": ["chat", "tool_calling", "streaming", "vision"], "contextWindow": 200000 }
      ]
    },
    {
      "id": "ollama-local",
      "name": "本地 Ollama",
      "type": "openai-compatible",
      "endpoint": "http://localhost:11434/v1",
      "models": [
        { "id": "qwen2.5-coder:32b", "displayName": "Qwen 2.5 Coder 32B", "capabilities": ["chat", "tool_calling", "streaming"], "contextWindow": 32000 },
        { "id": "llama3.3:70b", "displayName": "Llama 3.3 70B", "capabilities": ["chat", "tool_calling", "streaming"], "contextWindow": 128000 }
      ]
    },
    {
      "id": "vllm",
      "name": "本地 vLLM",
      "type": "openai-compatible",
      "endpoint": "http://localhost:8000/v1",
      "models": []
    },
    {
      "id": "siliconflow",
      "name": "硅基流动",
      "type": "openai-compatible",
      "endpoint": "https://api.siliconflow.cn/v1",
      "models": [
        { "id": "deepseek-ai/DeepSeek-V3", "displayName": "DeepSeek V3 (硅基)", "capabilities": ["chat", "tool_calling", "streaming"], "contextWindow": 64000 },
        { "id": "BAAI/bge-m3", "displayName": "BGE-M3 Embedding", "capabilities": ["embedding"], "contextWindow": 8192 }
      ]
    },
    {
      "id": "zhipu",
      "name": "智谱 GLM",
      "type": "openai-compatible",
      "endpoint": "https://open.bigmodel.cn/api/paas/v4",
      "models": []
    },
    {
      "id": "moonshot",
      "name": "Moonshot Kimi",
      "type": "openai-compatible",
      "endpoint": "https://api.moonshot.cn/v1",
      "models": []
    }
  ]
}
```

### 2.5 自定义 Provider

用户可添加任意 OpenAI 兼容 endpoint：

```
┌─ 添加自定义 Provider ────────────────────┐
│                                          │
│ 名称        [我的代理服务              ] │
│ 类型        [OpenAI 兼容 ▾]              │
│ Endpoint    [https://my-proxy.com/v1   ] │
│ API Key     [sk-************************] │
│             [☐ 保存到系统 keychain]      │
│ Org ID      [(可选)                    ] │
│                                          │
│ ── 自定义请求头 ──            [+ 添加]   │
│ X-Custom: value                          │
│                                          │
│ ── 模型 ──                    [+ 添加]   │
│ ┌──────────────────────────────────────┐ │
│ │ id: my-model                          │ │
│ │ display: My Model                     │ │
│ │ context: [32000]                      │ │
│ │ capabilities: ☑chat ☑tool ☐vision    │ │
│ └──────────────────────────────────────┘ │
│                                          │
│  [测试连接]            [取消] [保存]    │
└──────────────────────────────────────────┘
```

**测试连接**会发一个最小的 chat completion 请求验证。

### 2.6 Ollama / vLLM 适配特别说明

#### 2.6.1 Ollama

Ollama 在 `:11434/v1` 提供 OpenAI 兼容 API：
- chat: `POST /v1/chat/completions`
- 支持 tool calling（v0.3+）
- embedding: `POST /v1/embeddings`

**模型自动发现**：
- 我们提供"自动检测"按钮：调 `GET http://localhost:11434/api/tags` 列出已下载模型，逐个推断 capabilities
- 用户也可手动添加

```typescript
async function detectOllamaModels(endpoint: string): Promise<ModelConfig[]> {
  const res = await fetch(`${endpoint.replace('/v1', '')}/api/tags`);
  const { models } = await res.json();
  return models.map(m => ({
    id: m.name,
    displayName: m.name,
    capabilities: inferCapabilities(m.name),  // 启发式：name 含 "coder" 推断 tool_calling
    contextWindow: m.context_length || 8192,
  }));
}
```

#### 2.6.2 vLLM

vLLM 启动后也提供 OpenAI 兼容 API：
- `python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3.3-70B`
- endpoint 通常是 `http://host:8000/v1`

**注意事项**：
- vLLM 的 tool calling 需要模型本身支持 + 启动时加 `--enable-auto-tool-choice` 等参数
- 用户需要自己确保

### 2.7 Provider 实现接口

```typescript
// src/main/llm/types.ts

export interface ILlmProvider {
  readonly config: LlmProviderConfig;

  /** 流式 chat */
  chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;

  /** 非流式 chat（少用） */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;

  /** Embedding */
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** 测试可达性 */
  ping(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

  /** 估算成本 */
  estimateCost(req: ChatRequest): { inputTokens: number; outputTokens: number; cost: number };

  /** 列出可用模型（远程查询） */
  listRemoteModels?(): Promise<ModelConfig[]>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  stream?: boolean;
}

export interface ChatChunk {
  type: 'text-delta' | 'tool-call' | 'tool-call-delta' | 'finish' | 'error' | 'usage';
  data: any;
}
```

### 2.8 LLM Router 实现

```typescript
// src/main/llm/router.ts

class LlmRouter {
  private providers = new Map<string, ILlmProvider>();

  register(provider: ILlmProvider) {
    this.providers.set(provider.config.id, provider);
  }

  /** Resolve "providerId:modelId" or "modelId" or default */
  resolve(modelRef: string | undefined): { provider: ILlmProvider; modelId: string } {
    if (!modelRef) modelRef = this.defaultModel;
    const [providerId, modelId] = modelRef.includes(':')
      ? modelRef.split(':')
      : [this.findProviderByModel(modelRef), modelRef];
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    return { provider, modelId };
  }

  async chatStream(req: ChatRequest & { modelRef: string }, signal?: AbortSignal) {
    const { provider, modelId } = this.resolve(req.modelRef);
    return provider.chatStream({ ...req, model: modelId }, signal);
  }

  async embed(req: EmbeddingRequest & { modelRef: string }) {
    const { provider, modelId } = this.resolve(req.modelRef);
    return provider.embed({ ...req, model: modelId });
  }
}
```

### 2.9 失败回退策略

```typescript
// 在 Agent 层封装
async function chatWithFallback(req, fallbackChain: string[]) {
  for (const modelRef of fallbackChain) {
    try {
      return await router.chatStream({ ...req, modelRef });
    } catch (err) {
      if (isRetryable(err) && fallbackChain.length > 1) {
        logger.warn(`Model ${modelRef} failed, falling back`, err);
        continue;
      }
      throw err;
    }
  }
}
```

用户在设置中可配置回退链：`deepseek:deepseek-chat → openai:gpt-4o-mini`。默认不开启。

---

## 3. 数据库连接配置

### 3.1 连接配置数据模型

```typescript
export interface ConnectionConfig {
  id: string;
  name: string;                  // "生产 PG"
  dialect: 'postgresql' | 'mysql' | ...;

  // 连接参数
  host: string;
  port: number;
  database: string;
  username: string;
  // 不存密码，存 keychain ref
  passwordRef?: string;

  // SSL / SSH
  ssl?: SslConfig;
  sshTunnel?: SshTunnelConfig;

  // 行为
  defaultReadOnly: boolean;
  autoLimit: number | null;      // null 表示不自动加 LIMIT
  queryTimeout: number;          // 秒
  poolSize: number;              // 默认 5

  // RAG
  ragEnabled: boolean;
  ragSchemas: string[] | 'all';  // 索引哪些 schema
  ragSampleRows: boolean;        // 是否抓样本数据
  ragEmbeddingProviderRef?: string;  // 不指定则用默认

  // 标签 / 环境
  environment: 'dev' | 'staging' | 'prod' | 'unknown';
  tags?: string[];
  color?: string;                // UI 区分

  // 元信息
  createdAt: Date;
  lastUsedAt: Date;
}

export interface SslConfig {
  enabled: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;                   // 证书内容或文件路径
  cert?: string;
  key?: string;
}

export interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  passwordRef?: string;
  privateKeyPath?: string;
  privateKeyPassphraseRef?: string;
}
```

### 3.2 凭证存储

**强制使用 OS keychain** 存敏感字段：
- 数据库密码
- SSH passphrase
- LLM API Key
- MCP server 内的 secrets

**实现**：[keytar](https://github.com/atom/node-keytar)

```typescript
import keytar from 'keytar';

const SERVICE = 'com.dbagent.app';

async function storeSecret(ref: string, value: string) {
  await keytar.setPassword(SERVICE, ref, value);
}

async function loadSecret(ref: string): Promise<string | null> {
  return await keytar.getPassword(SERVICE, ref);
}
```

`ref` 命名规范：
- `conn:{connectionId}:password`
- `conn:{connectionId}:ssh_passphrase`
- `llm:{providerId}:api_key`
- `mcp:{serverId}:env:{varName}`

### 3.3 连接级覆盖

某些设置可在连接级别覆盖全局设置：
- 默认 Agent 模式（如生产环境固定为询问模式）
- 危险操作清单（生产环境追加更多禁止操作）
- 默认模型（某些连接强制走本地模型）

UI 上在连接编辑窗"高级"折叠区显示。

---

## 4. MCP 配置

### 4.1 MCP Server 配置数据模型

```typescript
export interface McpServerConfig {
  id: string;
  name: string;
  source: 'user-defined' | 'market';
  marketEntryId?: string;        // 来自市场时

  // 启动方式（二选一）
  transport: 'stdio' | 'sse' | 'http';

  // stdio
  command?: string;              // "npx"
  args?: string[];               // ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]
  env?: Record<string, string | { ref: string }>;  // 支持 keychain ref

  // sse / http
  url?: string;
  headers?: Record<string, string | { ref: string }>;

  // 行为
  enabled: boolean;
  autoStart: boolean;            // 应用启动时自动起
  timeout: number;               // 调用超时
  memoryLimitMb?: number;
}
```

### 4.2 MCP 配置文件示例

```json
// ~/.dbagent/mcp.json
{
  "version": 1,
  "servers": [
    {
      "id": "fs-local",
      "name": "Filesystem",
      "source": "market",
      "marketEntryId": "smithery/filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "enabled": true,
      "autoStart": true,
      "timeout": 30000
    },
    {
      "id": "company-tools",
      "name": "公司加解密工具",
      "source": "user-defined",
      "transport": "stdio",
      "command": "python",
      "args": ["-m", "company_mcp.server"],
      "env": {
        "ENCRYPT_KEY": { "ref": "mcp:company-tools:env:ENCRYPT_KEY" }
      },
      "enabled": true,
      "autoStart": true
    },
    {
      "id": "github-remote",
      "name": "GitHub MCP",
      "source": "market",
      "marketEntryId": "smithery/github",
      "transport": "sse",
      "url": "https://mcp.example.com/github/sse",
      "headers": {
        "Authorization": { "ref": "mcp:github-remote:headers:Authorization" }
      },
      "enabled": true,
      "autoStart": false
    }
  ]
}
```

### 4.3 公共 MCP Market 集成

#### 4.3.1 Market 抽象

```typescript
export interface IMcpMarket {
  readonly id: string;             // 'smithery' | 'mcp.so' | 自部署
  readonly name: string;
  readonly endpoint: string;

  list(filter?: MarketFilter): Promise<MarketEntry[]>;
  search(query: string): Promise<MarketEntry[]>;
  detail(entryId: string): Promise<MarketEntryDetail>;
  /** 获取启动配置（用户安装时拉取） */
  getInstallConfig(entryId: string): Promise<McpServerConfig>;
}

export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  publisher: string;
  category: string[];
  rating?: number;
  downloads?: number;
  iconUrl?: string;
  requiredEnvVars?: string[];   // ["GITHUB_TOKEN"]
}
```

#### 4.3.2 Smithery 对接

[Smithery](https://smithery.ai) 提供 MCP server registry，对接其公开 API：
- `GET https://registry.smithery.ai/servers` 列表
- `GET https://registry.smithery.ai/servers/{id}` 详情
- 启动配置以 JSON 形式返回，直接生成 `McpServerConfig`

#### 4.3.3 用户体验

```
设置 → 工具 → MCP Market

┌─ MCP Market ──────────────────────────────────┐
│ 来源: [Smithery ▾] [+ 添加自定义市场]         │
│ 搜索: [____________________________]          │
│ 分类: [全部] [文件] [HTTP] [GitHub] [DB] ...   │
│                                                │
│ ┌────────────────────────────────────────────┐ │
│ │ 📁 Filesystem                       [安装] │ │
│ │ ⭐ 4.8  ↓ 12k  Anthropic                   │ │
│ │ Read/write files on local filesystem      │ │
│ └────────────────────────────────────────────┘ │
│ ...                                            │
└────────────────────────────────────────────────┘
```

#### 4.3.4 安装流程

1. 用户点击 [安装]
2. 弹窗显示需要的 env vars 和权限说明
3. 用户填写敏感值 → 写入 keychain
4. 写入 `mcp.json` 一条记录
5. 启动 server 进程，list_tools 验证
6. 工具列表注册到 ToolRegistry，即刻可用

---

## 5. 全局用户设置（settings.json）

### 5.1 数据模型

```typescript
export interface UserSettings {
  version: 1;

  // 通用
  general: {
    language: 'zh-CN' | 'en' | 'auto';
    theme: 'dark' | 'light' | 'system';
    fontSize: 'small' | 'medium' | 'large';
    startup: 'restore_last' | 'new_session' | 'show_dashboard';
  };

  // LLM
  llm: {
    defaultChatModel: string;          // "deepseek:deepseek-chat"
    defaultEmbeddingModel: string;     // "siliconflow:BAAI/bge-m3"
    defaultToolCallingModel?: string;
    fallbackChain?: string[];
    tokenBudgetPerSession: number;     // 默认 40000
    showCostEstimate: boolean;
  };

  // Agent
  agent: {
    defaultMode: 'ask' | 'auto' | 'full-auto' | 'readonly';
    defaultStrategy: 'react' | 'plan-execute' | 'auto-select';
    maxIterations: number;             // 默认 25
    maxParallelSubAgents: number;      // 默认 3
    autoLimitForSelect: number | null; // 自动给 SELECT 加 LIMIT N
    dangerOperations: string[];        // ['DROP', 'TRUNCATE', 'DELETE_NO_WHERE', ...]
  };

  // 隐私
  privacy: {
    telemetryEnabled: boolean;         // 默认 false
    crashReportEnabled: boolean;       // 默认 false
    anonymousUsageStats: boolean;      // 默认 false
  };

  // 快捷键
  shortcuts: Record<string, string>;

  // 高级
  advanced: {
    devTools: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    sqlitePragmas?: Record<string, string>;
  };
}
```

### 5.2 设置面板分组（对应 [01-ui-design.md](./01-ui-design.md) §3.6）

详细 UI 已在界面设计中描述，此处补充配置项：

#### 5.2.1 通用
- 语言、主题、字号、启动行为、自动检查更新

#### 5.2.2 模型
- LLM Provider 列表 (CRUD)
- 默认 chat 模型
- 默认 embedding 模型
- Token 预算
- 是否显示成本

#### 5.2.3 数据库
- 连接列表（CRUD）
- 默认行为：自动 LIMIT、查询超时、连接池大小

#### 5.2.4 工具
- 内置工具开关（每个工具可单独禁用）
- MCP Server 列表 (CRUD)
- 公共 MCP Market 配置（默认 Smithery，可加自定义）

#### 5.2.5 Skills
- Skills 列表（启用/禁用、编辑、删除）
- 导入/导出 (yaml zip)

#### 5.2.6 Agent
- 默认模式
- 策略
- 最大迭代次数
- 子 agent 并发数
- 危险操作清单（可编辑）

#### 5.2.7 安全
- 凭证存储位置（仅展示，不可改）
- 审计日志开关与保留天数
- 加密本地数据库（启用 SQLCipher）

#### 5.2.8 快捷键
- 列表 + 重新绑定

#### 5.2.9 关于
- 版本、许可证、订阅状态、退出登录、检查更新

---

## 6. 配置加载与持久化

### 6.1 加载顺序

```
应用启动
  ↓
1. 读 settings.json 默认配置（不存在则写入默认值）
  ↓
2. 读 connections.json
  ↓
3. 读 mcp.json
  ↓
4. 加载 Skills（扫描 skills/ 目录）
  ↓
5. 解密 keychain（按需，访问时再读）
  ↓
6. 注册 LLM Providers / 启动自动启动的 MCP servers
  ↓
7. UI 就绪
```

### 6.2 持久化策略

- **写时立即落盘**：所有配置变更立即 fsync
- **原子写**：用 `write-file-atomic`，避免崩溃损坏文件
- **版本化**：所有配置 JSON 含 `version` 字段，便于未来迁移
- **备份**：保留最近 3 个版本备份在 `~/.dbagent/backups/`

### 6.3 配置迁移

```typescript
class ConfigMigrator {
  private migrations: Migration[] = [
    { from: 1, to: 2, migrate: (cfg) => { /* ... */ return cfg; } },
  ];

  migrate(cfg: any): any {
    while (cfg.version < CURRENT_VERSION) {
      const m = this.migrations.find(m => m.from === cfg.version);
      cfg = m.migrate(cfg);
    }
    return cfg;
  }
}
```

### 6.4 配置导入/导出

设置面板提供：
- **导出**：选择性导出（不含密码 / 含密码）。密码导出时用用户密码加密
- **导入**：合并或覆盖
- 用途：跨设备迁移、团队共享基础配置

---

## 7. 多用户与订阅

### 7.1 用户账号

桌面端是单机应用，但需要登录账号用于：
- 订阅验证
- 同步部分配置（不同步敏感）
- 提交反馈

```typescript
export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  subscription: {
    tier: 'free' | 'pro' | 'team' | 'enterprise';
    expiresAt?: Date;
    seats?: number;            // team
  };
  loggedInAt: Date;
}
```

存在 `~/.dbagent/account.json`，token 存 keychain。

### 7.2 订阅功能门控

```typescript
function requirePro(feature: string) {
  if (account.subscription.tier === 'free') {
    showUpgradePrompt(feature);
    throw new SubscriptionRequiredError(feature);
  }
}
```

**MVP 阶段先留接口，不做强限制**。商业化阶段再做严格门控。

### 7.3 离线模式

- 未登录时：基础功能可用，AI 功能受限或仅试用
- 登录后离线：缓存订阅状态，离线 7 天后过期需重新验证

---

## 8. 默认配置（首次启动）

```json
{
  "version": 1,
  "general": {
    "language": "zh-CN",
    "theme": "dark",
    "fontSize": "medium",
    "startup": "restore_last"
  },
  "llm": {
    "defaultChatModel": "deepseek:deepseek-chat",
    "defaultEmbeddingModel": "local:bge-m3",
    "tokenBudgetPerSession": 40000,
    "showCostEstimate": true
  },
  "agent": {
    "defaultMode": "ask",
    "defaultStrategy": "auto-select",
    "maxIterations": 25,
    "maxParallelSubAgents": 3,
    "autoLimitForSelect": 1000,
    "dangerOperations": [
      "DROP_DATABASE",
      "DROP_TABLE",
      "TRUNCATE",
      "DELETE_WITHOUT_WHERE",
      "UPDATE_WITHOUT_WHERE"
    ]
  },
  "privacy": {
    "telemetryEnabled": false,
    "crashReportEnabled": false,
    "anonymousUsageStats": false
  },
  "advanced": {
    "devTools": false,
    "logLevel": "info"
  }
}
```

---

## 9. IPC 通信契约（前后端分离）

### 9.1 渲染进程 ↔ 主进程

虽然是单机，但 Electron 有 main / renderer 两个进程，通过 IPC 通信。

```typescript
// 配置相关 IPC channel
const IpcChannels = {
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',

  // Connections
  CONNECTION_LIST: 'connection:list',
  CONNECTION_CREATE: 'connection:create',
  CONNECTION_UPDATE: 'connection:update',
  CONNECTION_DELETE: 'connection:delete',
  CONNECTION_TEST: 'connection:test',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',

  // LLM Providers
  LLM_LIST_PROVIDERS: 'llm:list-providers',
  LLM_TEST_PROVIDER: 'llm:test-provider',
  LLM_DETECT_OLLAMA_MODELS: 'llm:detect-ollama',

  // MCP
  MCP_LIST: 'mcp:list',
  MCP_INSTALL: 'mcp:install',
  MCP_UNINSTALL: 'mcp:uninstall',
  MCP_START: 'mcp:start',
  MCP_STOP: 'mcp:stop',
  MCP_MARKET_SEARCH: 'mcp:market-search',

  // Agent (主要走 stream IPC，详见 agent doc)
  AGENT_RUN: 'agent:run',
  AGENT_ABORT: 'agent:abort',
  AGENT_EVENT: 'agent:event',  // main → renderer 推送

  // RAG
  RAG_REBUILD: 'rag:rebuild',
  RAG_STATUS: 'rag:status',

  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_FORK: 'session:fork',
  SESSION_DELETE: 'session:delete',
  SESSION_EXPORT: 'session:export',
};
```

### 9.2 类型安全

所有 IPC 调用通过统一类型定义保证 type safety：

```typescript
// shared/ipc-contract.ts
export interface IpcContract {
  'settings:get': { req: void; res: UserSettings };
  'settings:update': { req: Partial<UserSettings>; res: UserSettings };
  'connection:test': { req: ConnectionConfig; res: TestResult };
  // ...
}

// 自动生成的 typed wrapper
const ipc = createTypedIpc<IpcContract>();
const settings = await ipc.invoke('settings:get');
```

---

## 10. 模块化扩展

### 10.1 扩展点清单

| 扩展点 | 接口 | 配置位置 |
|---|---|---|
| 新 LLM Provider 类型 | `ILlmProvider` 实现 + provider type 注册 | 代码 |
| 新数据库类型 | `IDatabaseExtractor` + `IDatabaseDriver` | 代码 |
| 新 MCP Market | `IMcpMarket` 实现 | 代码 + 配置 |
| 新 Embedding 提供者 | `IEmbeddingProvider` | 大多走 OpenAI 兼容，配置即可 |
| 新 Skill | YAML 文件 | 配置 |
| 新内置工具 | `ITool` 实现 | 代码 |

### 10.2 插件系统（未来）

MVP 不做完整插件系统，但接口预留：
- 命名空间：`plugin:{name}`
- 沙箱：每个插件独立进程
- 权限申报模型：插件需声明需要的权限

---

## 11. 安全合规

### 11.1 数据存储分级

| 等级 | 内容 | 存储 |
|---|---|---|
| 极敏感 | DB 密码、API key、SSH key | OS keychain |
| 敏感 | 会话 SQL 内容、查询结果 | 本地 SQLite，可启用 SQLCipher 加密 |
| 一般 | 设置、连接元信息（不含密码） | 本地 JSON |
| 公开 | 应用默认配置 | 内置 |

### 11.2 不上传清单

> **以下数据永远不会发送到我们的服务器：**
> - 数据库内容（用户数据）
> - SQL 内容（除非用户主动开启 telemetry，且已脱敏）
> - 数据库连接信息
> - API key
> - schema 详情（仅本地 RAG 使用）

LLM API 调用是直连（用户配置的 endpoint），不经过我们。

### 11.3 用户数据导出与删除

- 用户随时可"导出所有数据"（zip）
- 用户可"清空本地数据"（一键重置应用）
- 用户卸载应用后，所有数据保留在 `~/.dbagent/`，由用户决定是否清理

---

## 12. 待定与未来

- [ ] **配置同步**（Pro 功能）：跨设备同步设置，但不同步敏感
- [ ] **企业策略文件**：管理员下发 `policy.json` 限制员工的 LLM 选择 / 危险操作
- [ ] **审计中心**：企业版集中收集审计日志
- [ ] **SSO**：SAML / OIDC 集成
- [ ] **配额管理**：企业版按用户/团队管理 token 预算
