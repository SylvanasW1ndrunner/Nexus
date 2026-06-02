# 08 - 工作空间与 Agent 增强能力（Workspace & Agent Augmentation）

> 文档版本：v0.1
> 关联：[03-agent-design.md](./03-agent-design.md), [06-classic-features.md](./06-classic-features.md)

---

## 1. 为什么需要这个文档

### 1.1 核心洞察

经过前面的设计，我们已经有：
- Agent 能调用 SQL 和工具
- 用户可挂载 MCP / 写 Skill
- 传统 IDE 能力扎实

但**还差一块拼图**：

> **数据工程师的工作不只是"跑 SQL"，还包括：写脚本处理数据、维护数据库文档、画 ER 图、产出分析报告。这些事情如果还要用户自己去 Python 项目里写、Confluence 里维护、Lucidchart 里画图，那 Agent 的价值就被天花板限制了。**

### 1.2 我们的真正差异化

```
┌──────────────────────────────────────────────────────┐
│ 普通 Text2SQL 工具：                                  │
│   "给我一条 SQL"   →   生成 SQL                       │
│                                                      │
│ DBAgent：                                            │
│   "分析为什么 GMV 下降"                               │
│   → Agent 写 Python 拉数 + 多维度分析                 │
│   → 自动生成图表                                     │
│   → 输出 markdown 报告                               │
│   → 报告自动归档到工作空间                            │
│   → 下次相关问题可复用历史脚本                        │
└──────────────────────────────────────────────────────┘
```

### 1.3 三大优势支柱

```
        ┌─────────────────────────┐
        │   DBAgent 差异化优势     │
        └────────────┬────────────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  ┌─────────┐  ┌──────────┐  ┌──────────────┐
  │ Skill   │  │ MCP      │  │ Workspace +  │
  │ (流程化)│  │ (工具化) │  │ Python (制品)│
  └─────────┘  └──────────┘  └──────────────┘
```

| 维度 | 形态 | 解决的问题 |
|---|---|---|
| **Skill** | YAML 配置的可复用流程 | "重复任务自动化" |
| **MCP** | 外部工具的标准接入 | "让 Agent 调用任意能力" |
| **Workspace + Python** | 文件系统 + 脚本运行 | "让 Agent 产出真正的工程制品" |

---

## 2. 工作空间（Workspace）核心概念

### 2.1 什么是工作空间

> **工作空间（Workspace）= 一个目录，承载用户与一个或多个数据库相关的所有产物。**

类比：
- VS Code 的 workspace（一个项目目录）
- Cursor 的工作空间
- Jupyter 的 notebook 项目

### 2.2 为什么不是单个会话/Tab

| 维度 | 单会话 | 工作空间 |
|---|---|---|
| 持久性 | 会话级，关闭可能丢失 | 文件系统级，永久保存 |
| 复用 | 难以跨会话复用 | 脚本/文档可被任何会话引用 |
| 协作 | 不方便分享 | 整个目录可打包/同步 |
| 版本控制 | 没有 | 可 git init |
| 工程化 | 不行 | 完整工程项目结构 |

### 2.3 工作空间目录结构

```
my-workspace/                         # 用户选择的目录
├── .dbagent/                         # 工作空间元信息
│   ├── workspace.json                # 配置
│   ├── connections.json              # 关联的连接 ID 列表
│   ├── sessions.db                   # 工作空间内会话历史
│   └── history.jsonl                 # 操作日志
│
├── queries/                          # SQL 文件
│   ├── daily-gmv.sql
│   ├── user-cohort.sql
│   └── _drafts/                      # 草稿
│
├── scripts/                          # Python 脚本
│   ├── decrypt_phone.py             # 用户/Agent 写的工具脚本
│   ├── analyze_gmv.py               # 分析脚本
│   ├── requirements.txt             # 依赖声明
│   └── _runs/                       # 脚本运行输出
│       └── 2026-05-20_14-23/
│           ├── stdout.log
│           ├── result.json
│           └── chart.png
│
├── skills/                           # 工作空间专属 Skill
│   ├── daily-report.yaml
│   └── cohort-analysis.yaml
│
├── docs/                             # 自动生成 + 手写文档
│   ├── schema.md                     # Agent 生成的 schema 文档
│   ├── er-diagram.mermaid            # Agent 生成的 ER 图
│   ├── data-dictionary.md            # 数据字典
│   └── reports/                      # 分析报告
│       └── 2026-05-gmv-analysis.md
│
├── outputs/                          # 导出物（一次性）
│   ├── 2026-05-20-orders.csv
│   └── 2026-05-20-charts.png
│
├── sql/                              # SQL 库（用户/Agent 沉淀的好 SQL）
│   ├── README.md                     # 索引说明
│   ├── analytics/
│   │   ├── daily-gmv.sql             # 含元信息（见下）
│   │   └── user-cohort.sql
│   ├── ops/
│   │   └── cleanup-orphans.sql
│   └── _drafts/                      # 草稿（不展示给 Agent）
│
└── notebooks/                        # （未来）Notebook 文件
    └── exploration.ipynb
```

**SQL 文件元信息约定**（写在文件头部 SQL 注释，类似 frontmatter）：

```sql
-- @name: 每日 GMV
-- @description: 计算昨日 GMV 及环比、同比
-- @connection: prod_pg                     -- 默认连接（可选）
-- @params: {"date": {"type": "date", "default": "yesterday"}}
-- @tags: [gmv, daily, finance]
-- @author: alice
-- @updated: 2026-05-20

SELECT
    DATE(created_at) AS day,
    SUM(amount) AS gmv
FROM orders
WHERE created_at >= :date::date
  AND created_at < :date::date + INTERVAL '1 day'
  AND status = 'paid'
GROUP BY DATE(created_at);
```

**好处**：
- Agent 可以 `grep_workspace` 查找历史好 SQL（"找到处理 GMV 的 SQL"）
- 命令面板能搜索 `@name`、`@tags` 快速定位
- `:date` 参数化语法 → 执行时弹窗输入参数
- 多连接 workspace 中，文件用 `@connection` 关联默认连接
- `_drafts/` 子目录不被 Agent 看见，避免污染 RAG 召回

### 2.4 工作空间打开方式

| 入口 | 行为 |
|---|---|
| 启动时 | 显示"最近工作空间"列表 + "打开/新建" |
| 应用菜单 | File → Open Workspace / New Workspace |
| 命令面板 | `>workspace open` |
| 拖拽目录到应用 | 自动识别为工作空间或转换 |
| 多窗口 | 每个工作空间一个窗口 |

### 2.5 工作空间 vs 全局

| 资源 | 工作空间级 | 全局级 |
|---|---|---|
| 数据库连接元信息 | ✓（关联，可多个） | ✓（所有连接定义） |
| 会话历史 | ✓ | - |
| Skill | ✓（专属） | ✓（用户/内置） |
| Python 脚本 | ✓ | - |
| SQL 文件 | ✓ | - |
| 生成的文档/报告 | ✓ | - |
| RAG 索引 | -（连接级，每连接一份） | -（连接级） |
| LLM Provider 配置 | -（用户级） | ✓ |
| MCP Server 配置 | -（用户级） | ✓ |
| 主题/快捷键 | -（用户级） | ✓ |

> **关键设计**：
> - 连接定义本身是**全局**的（同一个 PG 可被多个 workspace 关联）
> - 工作空间持有**连接关联列表**（可一个或多个），管理这些连接的"激活/断开"状态
> - 断开连接时**自动清除该连接的 RAG 索引**（详见 [02 §5.7](./02-rag-design.md)）

### 2.6 多连接管理

工作空间可以**同时关联多个数据库连接**（例如 staging + prod + analytics 三个 PG），并在它们之间灵活切换。

#### 2.6.1 连接的三种状态

| 状态 | 说明 | RAG | UI 表现 |
|---|---|---|---|
| **关联但未激活** | 在 workspace.json 中登记，但当前没连 | 不存在 / 已清除 | 灰色点 + "未激活" |
| **激活中（连接中）** | 正在建 TCP / 拉 schema | 构建中（Stage 1-3） | 黄色点 + spinner |
| **已激活** | 可用 | 已就绪（部分或全部）| 绿色点 |

#### 2.6.2 多连接交互

```
左侧连接面板：
─────────────────────
工作空间 · 电商分析项目
─────────────────────
▾ 连接 (3)
  🟢 prod_pg          [当前]    [⋮]
     └─ public, analytics
  🟢 staging_pg                  [⋮]
     └─ public
  ⚪ legacy_mysql      [未激活]  [⋮]

[+ 关联现有连接] [+ 新建连接]
```

**操作**：
- 点击连接 → 设为"当前"（chat 默认走它，SQL 编辑器默认连它）
- 右键连接 [激活/断开/重新索引/取消关联/编辑]
- 同一时刻可以**多个连接处于已激活状态**（用于跨连接对比 SQL，但 Agent 默认只用"当前"连接）

#### 2.6.3 断开行为

```typescript
// 用户右键 [断开]
async function disconnectInWorkspace(workspace, connectionId) {
  await pool.close(connectionId);

  // 默认：清除该连接的 RAG（详见 02-rag-design §5.7）
  if (settings.autoClearRagOnDisconnect) {
    await fs.rm(`${appData}/rag/${connectionId}.db`, { force: true });
  }

  // workspace 中保留连接关联（下次激活时重建 RAG）
  // 不清除：会话历史、SQL 文件、Python 脚本
}

// 用户右键 [取消关联]
async function unlinkFromWorkspace(workspace, connectionId) {
  // 1. 先断开（含清除 RAG）
  await disconnectInWorkspace(workspace, connectionId);

  // 2. 从 workspace.json 的 connections 列表里移除
  workspace.connections = workspace.connections.filter(c => c.connectionId !== connectionId);
  await saveWorkspace(workspace);

  // 注：连接定义本身（全局）仍然保留，可被其他 workspace 关联
}
```

#### 2.6.4 跨连接的小能力（MVP 留口）

MVP 不做跨连接的 Agent 自动 JOIN（太复杂），但留以下入口：

- SQL 编辑器顶部连接选择器：可临时切到其他已激活连接执行
- 右键表 → "在 [staging_pg] 中查看同名表"（同名/同 schema 时跳转）

未来版本（v1.x）再考虑：
- `diff_schemas(conn_a, conn_b)` 工具
- Agent 主动用多连接（数据迁移、staging vs prod 对比）

---

## 3. 工作空间数据模型

### 3.1 workspace.json

```typescript
// .dbagent/workspace.json
export interface WorkspaceConfig {
  version: 1;
  id: string;                          // uuid
  name: string;                        // "电商分析项目"
  description?: string;
  createdAt: Date;

  // 关联的连接（id 引用全局连接列表）
  connections: WorkspaceConnection[];

  // 默认设置
  defaults: {
    connectionId?: string;             // 默认连接
    agentMode?: 'ask' | 'auto' | 'full-auto' | 'readonly';
    pythonRuntime?: PythonRuntimeConfig;
  };

  // Skill / Tool 启用列表
  enabledSkills: string[];
  enabledMcpServers: string[];

  // 元
  tags?: string[];
  icon?: string;
  color?: string;
}

export interface WorkspaceConnection {
  connectionId: string;                // 全局连接 ID
  alias?: string;                      // 在此 workspace 内的别名
  isDefault?: boolean;                 // 工作空间打开时默认激活
  autoActivate?: boolean;              // 工作空间打开时自动连接（默认 false，需用户手动激活）

  // 运行时状态（不持久化，仅内存中维护）
  // active?: 'disconnected' | 'connecting' | 'active' | 'error';
}
```

> **激活策略**：工作空间打开时不自动激活所有关联连接（避免大量连接同时建立），仅激活 `isDefault: true` 的（如果有）。其他连接在用户点击/Agent 显式调用时按需激活。

### 3.2 Python Runtime 配置

```typescript
export interface PythonRuntimeConfig {
  // 类型
  type: 'system' | 'venv' | 'docker' | 'embedded';

  // 路径
  pythonPath?: string;                 // 'system' / 'venv' 用
  venvPath?: string;                   // 工作空间内的 .venv 路径

  // 包管理
  packageManager: 'pip' | 'uv' | 'poetry';
  requirementsFile?: string;           // 默认 'scripts/requirements.txt'

  // 资源限制
  timeoutSeconds: number;              // 默认 300
  memoryLimitMb?: number;              // 默认 1024
  networkAllowed: boolean;             // 默认 false

  // 环境变量
  env?: Record<string, string | { ref: string }>;

  // Docker（如果用）
  dockerImage?: string;                // 'python:3.11-slim'
}
```

---

## 4. Agent 写 Python 脚本

### 4.1 这是核心差异化

> **Agent 不只是"建议你写脚本"，而是"自己写、自己跑、自己解读结果"。**

类比 Claude Code 的工作模式：用户描述需求 → Agent 创建/修改文件 → 运行代码 → 看结果 → 迭代。

### 4.2 典型场景

#### 场景 1：复杂数据处理

```
用户：把 users 表所有 phone_enc 解密后，按城市码统计注册数

Agent 思考：
  - phone_enc 是 BYTEA 加密字段
  - 单纯 SQL 无法解密
  - 需要写 Python 脚本：
    1. 从 DB 拉数据
    2. 调用本地 decrypt_phone 工具（或 Python 库）
    3. 解析城市码
    4. 聚合输出

Agent 操作：
  → 创建 scripts/analyze_phone_by_city.py
  → 写入完整 Python 代码
  → 执行（用户确认后）
  → 输出 stdout 到 chat
  → 同时把结果保存到 scripts/_runs/.../result.json
```

#### 场景 2：可视化分析

```
用户：画一张过去 30 天每日 GMV 的趋势图

Agent 思考：
  - SQL 查每日 GMV
  - Python + matplotlib 画图
  - 保存 PNG 到 outputs/

Agent 操作：
  → 创建 scripts/plot_gmv_trend.py
  → 用 SQLAlchemy / psycopg 拉数
  → 用 pandas 处理 + matplotlib 画图
  → 保存 outputs/gmv-trend-2026-05.png
  → 在 chat 中内嵌显示图片
```

#### 场景 3：脚本复用

```
用户：再帮我画一次，但只看周末的数据

Agent 思考：
  - 已有 plot_gmv_trend.py
  - 不需要从零写，修改即可

Agent 操作：
  → 编辑 scripts/plot_gmv_trend.py（diff 预览）
  → 用户确认后重新执行
```

### 4.3 Python 执行架构

```
┌─────────────────────────────────────────────────┐
│  Agent decides to write/run a script             │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ Tool: write_script(path, content)                │
│  - 写入 workspace/scripts/                       │
│  - 触发 UI 显示 diff                             │
│  - 询问模式下需用户确认                          │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ Tool: install_deps(packages)  (按需)              │
│  - pip install / uv add                          │
│  - 写入 requirements.txt                         │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ Tool: run_script(path, args)                     │
│  - 启动 Python 子进程                            │
│  - 注入环境变量（DB 连接信息等）                  │
│  - 资源限制（timeout / memory）                  │
│  - 流式捕获 stdout/stderr                        │
│  - 输出归档到 _runs/{timestamp}/                 │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ 结果回传给 Agent                                  │
│  - stdout 摘要（截断）                           │
│  - 生成的文件列表                                │
│  - 错误（如有）                                  │
└─────────────────────────────────────────────────┘
```

### 4.4 脚本工具清单（内置）

| 工具 | 用途 | 危险等级 |
|---|---|---|
| `read_workspace_file(path)` | 读工作空间文件 | safe |
| `write_workspace_file(path, content)` | 写文件（含 diff 预览） | medium |
| `edit_workspace_file(path, edits)` | 编辑文件（精确 diff） | medium |
| `list_workspace_dir(path)` | 列目录 | safe |
| `delete_workspace_file(path)` | 删文件 | medium |
| `run_python_script(path, args?)` | 执行脚本 | high |
| `install_python_deps(packages)` | 安装依赖 | high |
| `python_repl(code)` | 短代码片段（无需建文件） | high |

### 4.5 Python 脚本与数据库的连接

#### 4.5.1 自动注入连接信息

Agent 写的脚本需要访问数据库时，**不在脚本中硬编码凭证**，而是：

```python
# Agent 生成的脚本头部模板
import os
import psycopg2

# DBAgent 注入的连接信息（环境变量）
conn = psycopg2.connect(
    host=os.environ['DBAGENT_DB_HOST'],
    port=os.environ['DBAGENT_DB_PORT'],
    database=os.environ['DBAGENT_DB_NAME'],
    user=os.environ['DBAGENT_DB_USER'],
    password=os.environ['DBAGENT_DB_PASSWORD'],
)
```

环境变量由主进程在启动子进程时注入，不写入文件，不进版本控制。

#### 4.5.2 SDK 包装（可选优化）

提供轻量 SDK：
```python
from dbagent import workspace

# 自动用当前连接
df = workspace.query("SELECT * FROM users LIMIT 100")

# 写文件到工作空间
workspace.save("outputs/users-sample.csv", df)
```

SDK 在脚本运行时通过 stdin/stdout 与主进程通信（IPC），避免暴露凭证。

### 4.6 Python 运行环境管理

#### 4.6.1 用户的 Python 选择

设置中（工作空间级）：

```
Python 运行时：
  ○ 系统 Python      [/usr/bin/python3]    [检测]
  ● 工作空间 venv   [./venv]              [创建]
  ○ Docker 容器     [python:3.11-slim]
  ○ 内嵌 Python     [由应用管理]            [实验性]

包管理器：
  ○ pip
  ● uv (推荐，更快)
  ○ poetry

资源限制：
  超时:    [300] 秒
  内存:    [1024] MB
  网络:    ☐ 允许
```

#### 4.6.2 内嵌 Python（未来探索）

为了真正"开箱即用"，未来可以：
- 应用打包内置 Python（10MB+ 包体增量）
- 或首次使用时下载 micropython / pyodide
- 这样用户零配置就能用

**MVP 阶段不做内嵌**，让用户用系统 Python 或自建 venv。

#### 4.6.3 依赖管理流程

```
Agent 检测到需要某个包（如 pandas）
  ↓
检查 requirements.txt 是否已声明
  ↓
未声明 → 调用 install_python_deps(['pandas'])
  ↓
触发 UI 询问确认（询问模式）
  ↓
确认 → 写入 requirements.txt + uv add pandas
  ↓
后续运行可直接使用
```

#### 4.6.4 推荐的预装依赖（开箱即用基础栈）

> 创建工作空间时，"数据分析项目"模板会预生成 `scripts/requirements.txt`，含以下依赖。Agent 可以直接 import，不需要每次都 `install_python_deps`。

| 类别 | 包 | 用途 | 必装 |
|---|---|---|---|
| **DB 连接** | `psycopg[binary]` | PG 驱动（psycopg3 二进制版，零编译） | ✅ |
| | `sqlalchemy` | 通用 ORM / 连接管理 | ✅ |
| **数据处理** | `pandas` | 数据帧，几乎所有分析的入口 | ✅ |
| | `polars` | 列式高性能（大数据量场景） | ⚪ 可选 |
| | `numpy` | 数值计算（pandas 依赖） | ✅（间接） |
| **可视化** | `matplotlib` | 基础图表，PNG 输出 | ✅ |
| | `plotly` | 交互式图表（HTML 输出） | ⚪ 可选 |
| | `seaborn` | 统计可视化（基于 matplotlib） | ⚪ 可选 |
| **报表生成** | `jinja2` | 报告模板渲染 | ✅ |
| | `tabulate` | 表格转 markdown / 文本 | ✅ |
| **加解密** | `cryptography` | AES/RSA 等通用加解密 | ✅ |
| | `pycryptodome` | 国密 / 旧标准加解密 | ⚪ 可选 |
| **工具** | `python-dateutil` | 日期解析 | ✅ |
| | `pytz` | 时区处理 | ✅ |
| | `httpx` | HTTP 请求（替代 requests） | ✅ |
| **DBAgent SDK** | `dbagent`（自家轻量 SDK） | 注入连接 + 写 workspace 文件 | ✅ |

**默认 requirements.txt（基础栈）**：

```
# 数据库
psycopg[binary]>=3.2
sqlalchemy>=2.0

# 数据处理
pandas>=2.2
numpy>=1.26

# 可视化
matplotlib>=3.8

# 报表
jinja2>=3.1
tabulate>=0.9

# 加解密
cryptography>=42.0

# 工具
python-dateutil>=2.9
pytz>=2024.1
httpx>=0.27

# DBAgent SDK
dbagent-sdk>=0.1
```

**模板分级**：

| 模板 | 包含 | 安装大小（venv） | 适用场景 |
|---|---|---|---|
| **minimal** | psycopg + sqlalchemy + dbagent-sdk | ~30 MB | 纯 SQL 场景、CI |
| **standard**（推荐默认）| 上面"必装"全部 | ~250 MB | 一般数据分析、报表、EDA |
| **full** | 必装 + 所有可选（plotly/seaborn/polars/pycryptodome） | ~500 MB | 重度可视化、大数据 |
| **ml** | standard + scikit-learn + lightgbm + xgboost + optuna | ~800 MB | 经典机器学习 |
| **dl** | ml + pytorch + transformers + sentence-transformers | ~3-6 GB | 深度学习、NLP |
| **rl** | dl + gymnasium + stable-baselines3 | ~3-7 GB | 强化学习 |

> 用户在新建工作空间向导可选模板，**默认 standard**。轻量化派可选 minimal，按需自己 `install_python_deps`。
>
> 对于深度学习/强化学习，由于安装包大、CUDA 配置复杂，**建议用户手动选择 dl/rl 模板或自己 pip install**，Agent 不主动安装重型库 —— 安装前会询问。

#### 4.6.5 dbagent-sdk（自写轻量 SDK）

为了让 Agent 写脚本更顺手，提供薄 SDK：

```python
# scripts/example.py
from dbagent import workspace, db, save, load

# 1. 数据库连接（自动从环境变量读取，凭证不暴露）
df = db.query("SELECT * FROM orders WHERE created_at > now() - interval '7 days'")

# 流式拉数（大数据量场景）
for chunk in db.query_stream("SELECT * FROM huge_table", chunksize=10000):
    process(chunk)

# 用 SQLAlchemy engine（高级用户）
engine = db.engine()

# 2. 写文件到 workspace（路径锁定，自动按扩展名编解码）
save("outputs/last-week-orders.csv", df)         # DataFrame → CSV
save("outputs/result.parquet", df)               # DataFrame → Parquet
save("outputs/model.pkl", trained_model)         # joblib pickle
save("outputs/checkpoint.pt", torch_state_dict)  # torch.save
save("docs/reports/weekly.md", "# 本周报告\n...")  # 字符串 → 文本

# 3. 读文件（同样路径锁定，自动解码）
config = load("config/model.yaml")               # YAML / JSON / TOML
df = load("outputs/cached_features.parquet")     # → DataFrame
model = load("outputs/model.pkl")                # joblib

# 4. 调用 workspace 内其他工具（注册过 @tool docstring 的脚本）
result = workspace.call_tool("decrypt_phone", encrypted=b"...")

# 5. 在 chat 中实时输出（流式给 agent / 用户）
workspace.print("✓ 处理 1234 行")

# 6. 渲染 chat 内嵌图片 / 表格 / markdown
workspace.show_image("outputs/gmv-trend.png")
workspace.show_dataframe(df.head(20))

# 7. 长任务进度条
with workspace.progress("训练模型", total=100) as bar:
    for epoch in range(100):
        ...
        bar.update(1, info=f"loss={loss:.3f}")
```

**SDK 接口清单**：

```
dbagent.db
  .query(sql, params=None) -> DataFrame
  .query_stream(sql, chunksize=10000) -> Iterator[DataFrame]
  .engine() -> sqlalchemy.Engine
  .connection() -> psycopg.Connection
  # 注：写操作不在 SDK 提供，Agent 在 Python 里不该直接写库

dbagent.save(path, obj, **kwargs)
  # 自动按扩展名分发：
  #   .csv .tsv  → DataFrame
  #   .parquet   → DataFrame (推荐大数据用)
  #   .json      → dict / list
  #   .yaml/.yml → dict
  #   .pkl       → joblib.dump
  #   .pt/.pth   → torch.save
  #   .npy/.npz  → numpy.save
  #   .png/.jpg  → matplotlib Figure / PIL Image / bytes
  #   .md/.txt   → str
  #   其他      → bytes / str

dbagent.load(path) -> 自动解码（与 save 对称）

dbagent.workspace
  .root() -> Path                          # workspace 根目录
  .print(msg)                              # 流式输出（chat 实时显示）
  .show_image(path_or_fig)
  .show_dataframe(df, max_rows=100)
  .show_markdown(text)
  .progress(title, total) -> ContextMgr   # 进度条
  .call_tool(name, **kwargs)              # 调用其他注册脚本
  .list_tools() -> List[str]              # 当前可用 workspace tool
  .ask_user(question) -> str              # 脚本运行中向用户提问（chat 弹出）
```

**SDK 设计原则**：
- 极薄（< 800 行代码），不做"框架"
- 所有方法都是同步的（脚本场景不需要 async）
- 凭证通过环境变量注入，SDK 内部读取，**不暴露给用户脚本**
- Workspace 路径锁定：`save() / load()` 不能逃出 workspace 根
- 与主进程通过 stdin/stdout 协议通信（非 HTTP，无端口冲突）
- **写 DB 故意不提供**：Agent 想做写操作必须回到 chat 走 SQL 审批路径

#### 4.6.6 脚本互相调用（关键能力）

工作空间内的脚本是**一等模块**，可以互相组合。这是支撑深度学习/RL/复杂 pipeline 任务的核心能力。

##### 方式 1：直接 Python import

```python
# scripts/models/train_lgb.py
from scripts.data.load_orders import load_recent_orders
from scripts.features.build_features import make_features

df = load_recent_orders(days=30)
X, y = make_features(df)
...
```

**实现细节**：workspace 根目录会自动加入 `sys.path`（在 SDK init 时），让 `scripts.xxx.yyy` 这种 import 直接生效。

##### 方式 2：注册为 workspace tool

在脚本顶部加 `@tool` docstring，自动被识别：

```python
# scripts/decrypt_phone.py
"""
@tool decrypt_phone
@description 对 AES 加密的手机号字段解密
@param encrypted: bytes 加密数据
@returns str 解密后的手机号字符串

依赖于环境变量 WORKSPACE_ENCRYPT_KEY（用户在工作空间设置中配置）
"""
import os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

def main(encrypted: bytes) -> str:
    key = os.environ['WORKSPACE_ENCRYPT_KEY']
    ...
    return decrypted_phone
```

注册的 tool 同时被：
- **Agent** 通过 ToolRegistry 自动发现，能在自然语言场景下调用
- **其他脚本** 通过 `workspace.call_tool("decrypt_phone", encrypted=...)` 调用

##### 方式 3：编排脚本（pipeline）

复杂任务用一个编排脚本调用多个子脚本：

```python
# scripts/run_pipeline.py
"""
@tool run_full_pipeline
@description 跑完整训练 pipeline：拉数 → 特征 → 训练 → 评估
"""
from dbagent import workspace
from scripts.data.load_orders import load_recent_orders
from scripts.features.build_features import make_features
from scripts.models.train_lgb import train
from scripts.models.evaluate import evaluate

def main(days: int = 30):
    workspace.print("Step 1/4: 拉数...")
    df = load_recent_orders(days)

    workspace.print("Step 2/4: 特征工程...")
    X, y = make_features(df)

    workspace.print("Step 3/4: 训练...")
    model = train(X, y)

    workspace.print("Step 4/4: 评估...")
    metrics = evaluate(model, X, y)

    return metrics
```

##### 推荐目录结构（Agent 会主动遵循）

```
{workspace}/scripts/
├── data/                    # 数据加载（拉数、解密、清洗）
│   ├── load_orders.py
│   ├── load_users.py
│   └── decrypt_phone.py     # @tool 注册
├── features/                # 特征工程
│   └── build_features.py
├── models/                  # 模型相关
│   ├── train_lgb.py
│   ├── train_torch.py
│   └── evaluate.py
├── viz/                     # 可视化
│   └── plot_gmv_trend.py
├── reports/                 # 报告生成
│   └── weekly_report.py
├── lib/                     # 共享工具
│   └── time_utils.py
├── run_pipeline.py          # 编排
└── requirements.txt
```

不强制，但 Agent 在 [03 §6.4.4 data_analysis Skill](./03-agent-design.md) 中会被引导按这个结构组织代码。

### 4.7 安全沙箱

#### 4.7.1 默认安全层

| 限制 | 默认值 | 可配置 |
|---|---|---|
| 文件访问 | 仅 workspace 目录（写）；用户 home 只读（读）| 是 |
| 网络 | **允许**（httpx 已预装，需要联网拉数据是常态） | 是（关闭后所有 HTTP 请求被拦截） |
| 子进程 | 禁用（除 Python 自身） | 是 |
| CPU 时间 | 300 秒 | 是 |
| 内存 | 1024 MB | 是 |
| 输出大小 | 100 MB | 是 |

> **网络默认放开**是为了让 Agent 能调用外部 API、抓取数据、装依赖。**询问模式下**首次脚本运行会提示"此脚本可能联网"，用户可关闭。

#### 4.7.2 实现

- macOS：`sandbox-exec` 配置文件
- Linux：`bwrap` (bubblewrap) / `firejail`
- Windows：Job Object + AppContainer
- 跨平台兜底：进程级资源限制 + 文件路径白名单（最低保障）

**MVP 阶段**：先做基础（路径白名单 + 资源限制），不强求完整 sandbox-exec / firejail。文档明示"非生产级隔离"。

---

## 5. Agent 生成工程制品

### 5.1 这是另一个核心差异化

Agent 不只是"回答问题"，更要**留下工程产物**。

| 类别 | 产物 | 用途 |
|---|---|---|
| 文档 | schema.md, data-dictionary.md | 团队知识库 |
| 图表 | ER 图（mermaid）、数据流图 | 系统理解 |
| 报告 | 分析报告（markdown） | 决策支持 |
| 脚本 | Python 工具脚本 | 复用 |
| Skill | 流程化的可复用任务 | 自动化 |
| SQL | 复杂查询库 | 复用 |

### 5.2 自动生成清单

#### 5.2.1 Schema 文档生成

```
触发：用户在工作空间中点击"生成 Schema 文档"
   或 命令面板 >generate schema doc
   或 Chat："帮我把 schema 文档化"

Agent 流程：
  1. 调用 RAG 拉取所有表 + 字段 + 关系
  2. 按 schema/模块分组
  3. 为每个表生成：用途、字段说明、关键索引、关联关系
  4. 输出到 docs/schema.md
  5. 用户可以审阅/修改/手写补充

输出示例：
  # Schema 文档

  ## public schema

  ### users
  > 用户基础信息表

  | 字段 | 类型 | 描述 |
  |------|------|------|
  | id | BIGINT | 主键，自增 |
  | email | VARCHAR(255) | 邮箱（唯一） |
  | phone_enc | BYTEA | 加密手机号 ⚠ 需用 decrypt_phone 解密 |
  ...

  **关联**：
  - 1:N → orders (orders.user_id)
  - 1:1 → profiles (profiles.user_id)
```

#### 5.2.2 ER 图生成

```
Agent 写入 docs/er-diagram.mermaid
内容为 mermaid erDiagram 语法
UI 中可以直接渲染查看（[06 §8](./06-classic-features.md)）
也可以导出为 SVG/PNG

Agent 还可以生成"分主题"的子图：
  - er-orders.mermaid    (订单子系统)
  - er-users.mermaid     (用户子系统)
```

#### 5.2.3 数据字典生成

比 schema 文档更结构化的版本：

```
docs/data-dictionary.md：
  - 业务术语 ←→ 数据库字段映射
  - 指标定义（GMV、活跃用户...）
  - 计算口径（含 SQL）
  - 数据来源 / 更新频率
```

数据字典也作为 RAG 的 glossary 输入，Agent 后续查询会自动用上。

#### 5.2.4 分析报告生成

```
用户："帮我分析上周 GMV 下降原因，写成报告"

Agent 流程：
  1. 拆解为多个子任务（订单数、客单价、退款率...）
  2. 子 Agent 并行查询
  3. 用 Python 画图保存到 outputs/
  4. 主 Agent 撰写 markdown 报告，引用图表
  5. 保存到 docs/reports/2026-05-gmv-analysis.md

报告示例：
  # 2026-05 GMV 下降分析

  ## TL;DR
  上周 GMV 同比下降 8%，主因客单价下降...

  ## 数据
  ![日 GMV 趋势](../outputs/gmv-trend-2026-05.png)

  ...

  ## 结论
  ...

  ## 附录
  - 查询 SQL: queries/gmv-cohort.sql
  - 分析脚本: scripts/gmv_analysis.py
```

#### 5.2.5 Skill 自动沉淀

```
用户："这个 GMV 报表流程，以后我要每天都跑"

Agent 流程：
  → 把刚才的分析步骤总结成 Skill yaml
  → 保存到 skills/daily-gmv-report.yaml
  → 提示用户："已生成 Skill，下次用 /daily-gmv 即可触发"

skill yaml 示例：
  name: daily_gmv_report
  description: 生成每日 GMV 报表
  steps:
    - 查询昨日 GMV
    - 计算环比/同比
    - 用 plot_gmv_trend.py 画图
    - 输出到 docs/reports/
```

### 5.3 生成产物的内置工具

| 工具 | 用途 |
|---|---|
| `generate_schema_doc(scope)` | 生成 Schema 文档 |
| `generate_er_diagram(tables?)` | 生成 ER 图（mermaid） |
| `generate_data_dictionary(scope)` | 生成数据字典 |
| `generate_report(title, sections)` | 生成结构化报告 |
| `save_skill(definition)` | 把当前流程保存为 Skill |
| `render_chart(data, type)` | 调用 Python 生成图表（matplotlib/plotly） |

这些工具内部组合 RAG / LLM / 文件操作完成。

### 5.4 用户可定制模板

用户/团队可以提供自定义模板：

```
.dbagent/templates/
├── schema-doc.md.hbs
├── data-dictionary.md.hbs
├── report.md.hbs
└── skill.yaml.hbs
```

Agent 生成时使用模板，保证团队风格统一。

---

## 6. 工作空间 + Skill + MCP 协同模式

### 6.1 三者关系

```
┌────────────────────────────────────────────┐
│                Workspace                    │
│  (项目级容器：脚本/文档/会话/Skill)           │
│                                            │
│   ┌──────────┐         ┌──────────┐        │
│   │ Skill    │ 调用→   │ Tool     │        │
│   │ (流程)   │         │ Registry │        │
│   └──────────┘         └────┬─────┘        │
│                             │              │
│        ┌─────────┬──────────┼──────────┐   │
│        ▼         ▼          ▼          ▼   │
│    ┌──────┐ ┌────────┐ ┌──────┐ ┌────────┐ │
│    │Built-│ │ MCP    │ │Python│ │Skill   │ │
│    │  in  │ │ Server │ │Script│ │Tool    │ │
│    └──────┘ └────────┘ └──────┘ └────────┘ │
└────────────────────────────────────────────┘
```

### 6.2 Skill 可以调用什么

```yaml
# skills/daily-gmv-report.yaml
name: daily_gmv_report
description: 生成每日 GMV 报告

allowed_tools:
  # 内置工具
  - query_database
  - generate_report

  # 工作空间脚本
  - workspace_script:plot_gmv_trend  # 调用 scripts/plot_gmv_trend.py

  # MCP 工具
  - mcp:slack:send_message           # 发送到 Slack

steps:
  - 查询昨日 GMV
  - 调用 plot_gmv_trend 画图
  - 写入 docs/reports/
  - 通过 Slack 通知团队
```

### 6.3 关键观察：脚本即工具

> **工作空间内的 Python 脚本，可以注册为 Tool，被 Skill 调用，被 Agent 自主使用。**

```python
# scripts/decrypt_phone.py
"""
DBAgent Tool: decrypt_phone
@param encrypted: bytes 加密手机号
@return: str 解密后的手机号
"""
def main(encrypted: bytes) -> str:
    # ... 解密逻辑
    return decrypted_phone

if __name__ == '__main__':
    import sys, json
    args = json.loads(sys.stdin.read())
    result = main(**args)
    print(json.dumps({'result': result}))
```

Agent 自动识别脚本头的 docstring 注释，注册为可调用 tool：
- 名称：`workspace_script:decrypt_phone`
- 描述：从 docstring
- 参数 schema：从 type hints

这样**用户不需要单独搭一个 MCP server，写个脚本就能给 Agent 用**。

### 6.4 完整示例

```
用户在工作空间："分析上周 GMV 下降"

Agent 视角下可用的能力：
  - 内置工具：query_database, generate_report, ...
  - MCP（市场）：filesystem, fetch
  - MCP（用户）：slack-notifier
  - 工作空间脚本：
      decrypt_phone.py    (用户写的)
      plot_gmv_trend.py  (上周 Agent 自己写的，已沉淀)
  - Skills：
      daily-gmv-report (上次保存的)

Agent 决策：
  1. 调 daily_gmv_report Skill？
     - 不完全匹配（用户问"分析下降原因"，不是"出报表"）
  2. 自主规划：
     - query_database 拉数 → 客单价变化
     - workspace_script:plot_gmv_trend 画图
     - 调用 LLM 写分析
     - generate_report 输出
     - 询问用户："要不要保存为 Skill？"
```

---

## 7. UI 集成

### 7.1 工作空间侧栏（左侧 Sidebar 新增标签）

```
┌────────────────────┐
│ [🔌][📁][📦][🕐]   │
└────────────────────┘
       ↑
      工作空间标签

工作空间 · 电商分析项目
─────────────────────
▾ queries (3)
  📄 daily-gmv.sql
  📄 user-cohort.sql
▾ scripts (2)
  🐍 plot_gmv_trend.py
  🐍 decrypt_phone.py
▾ skills (2)
  ⚡ daily-gmv-report.yaml
▾ docs (3)
  📘 schema.md
  📘 data-dictionary.md
  📘 reports/
    📄 2026-05-gmv.md
▾ outputs (5)
  🖼 gmv-trend.png
  📊 users-sample.csv

[+ 新建文件] [⚡ 跑 Skill] [🤖 让 Agent 生成...]
```

### 7.2 文件双击打开

| 类型 | 打开方式 |
|---|---|
| .sql | SQL 编辑器 Tab |
| .py | Python 编辑器 Tab（Monaco + Python lang） |
| .md | Markdown 预览 + 编辑分屏 |
| .mermaid | Mermaid 渲染 + 编辑分屏 |
| .yaml (skill) | Skill 编辑器（结构化 + raw 切换） |
| .png/.jpg/.svg | 图片预览 |
| .csv/.json | 数据表格预览 |

### 7.3 Python 编辑器 Tab

```
┌────────────────────────────────────────────────────────────────┐
│  🐍 plot_gmv_trend.py                                          │
│  [▶ 运行] [⏸ 取消] [💾] [🤖 AI 改写] | Python: venv (3.11) ▾  │
├────────────────────────────────────────────────────────────────┤
│  1  import os                                                  │
│  2  import psycopg2                                            │
│  3  import matplotlib.pyplot as plt                            │
│  ...                                                           │
├────────────────────────────────────────────────────────────────┤
│  [▸ 输出] [📦 依赖] [🕐 历史]                                   │
├────────────────────────────────────────────────────────────────┤
│  Running...                                                    │
│  > Connecting to database...                                   │
│  > Fetching 30 days of GMV data...                            │
│  > Saved to outputs/gmv-trend-2026-05.png                     │
│  ✓ Done in 2.3s                                                │
└────────────────────────────────────────────────────────────────┘
```

### 7.4 一键操作面板

工作空间右键菜单：

```
- 在 Chat 中讨论这个工作空间
- 让 Agent 生成 Schema 文档
- 让 Agent 生成 ER 图
- 让 Agent 生成数据字典
- 让 Agent 写个新脚本...
- 把当前会话保存为 Skill
- 在文件管理器中打开
- 用 Git 初始化
```

### 7.5 启动屏（Startup Screen）

```
┌──────────────────────────────────────────────────────────────┐
│                     DBAgent                                   │
│                                                              │
│  最近的工作空间                                               │
│   📁 电商分析项目         /Users/me/work/ecommerce-analytics │
│   📁 用户行为研究         /Users/me/work/user-research       │
│   📁 财务报表             /Users/me/work/finance             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [📁 打开工作空间]                                    │    │
│  │ [+ 新建工作空间]                                     │    │
│  │ [🚀 快速开始（无工作空间）]                           │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

> **快速开始模式**：用户不想建工作空间，可以直接用，但 Python 脚本/Skill 等高级功能受限。

---

## 8. 与 Skill / MCP 的关系细化

### 8.1 Skill 的存储分级

| 级别 | 路径 | 范围 | 来源 |
|---|---|---|---|
| 内置 | 应用内置 | 所有用户 | 我们提供 |
| 用户级 | `~/.dbagent/skills/` | 当前用户 | 用户自定义 |
| 工作空间级 | `{workspace}/skills/` | 仅本工作空间 | 项目专属 |
| 团队共享（未来）| 云同步 | 团队 | 团队 |

加载顺序：内置 → 用户级 → 工作空间级（后者覆盖前者）

### 8.2 MCP 的存储分级

| 级别 | 路径 | 范围 |
|---|---|---|
| 用户级 | `~/.dbagent/mcp.json` | 全局 |
| 工作空间级 | `{workspace}/.dbagent/mcp.json` | 仅本工作空间（追加） |

工作空间可以**追加**专属 MCP（如项目专用的内部 API server），但不能屏蔽全局 MCP。

### 8.3 工作空间脚本作为工具

参见 §6.3。

```typescript
// 加载逻辑
function loadWorkspaceTools(workspace: Workspace): ITool[] {
  const tools: ITool[] = [];
  const scriptsDir = path.join(workspace.path, 'scripts');

  for (const file of fs.readdirSync(scriptsDir)) {
    if (!file.endsWith('.py')) continue;

    const meta = parseScriptDocstring(path.join(scriptsDir, file));
    if (!meta?.toolName) continue;  // 没声明 tool 标记则跳过

    tools.push(new WorkspaceScriptTool({
      name: `workspace_script:${meta.toolName}`,
      description: meta.description,
      parameters: meta.parameters,
      scriptPath: path.join(scriptsDir, file),
    }));
  }

  return tools;
}
```

---

## 9. 工作空间生命周期

### 9.1 创建工作空间

```
新建工作空间向导：
  Step 1: 选择目录 [/Users/me/work/new-project]
  Step 2: 命名     [电商分析项目]
  Step 3: 关联连接（可选） [☑ 本地PG] [☐ 生产PG]
  Step 4: 选择模板（可选）
    ○ 空白
    ● 数据分析项目（含基础脚本/文档结构）
    ○ 数据库迁移项目
    ○ 自定义模板
  Step 5: 是否初始化 Git ☑
  → 创建目录结构 + workspace.json
```

### 9.2 打开工作空间

- 验证 workspace.json 完整性
- 加载 workspace 级配置
- 注册 workspace 级 Skill / MCP
- 扫描 scripts/ 注册为工具
- 恢复上次打开的 Tab

### 9.3 工作空间迁移

- 工作空间是普通目录，可以直接：
  - 拷贝到其他机器
  - git clone
  - zip 分享
- 第一次打开新机器时：
  - 提示安装 Python 依赖
  - 提示配置数据库连接（凭证不在 workspace）
  - 验证 RAG 是否需要重建（schema 变了）

### 9.4 工作空间删除

- 应用内"移除"：仅从最近列表去掉，不删文件
- 文件系统删除：用户自己处理（提示用户慎重）

---

## 10. 性能与轻量化考量

### 10.1 工作空间不应膨胀

| 项 | 限制 |
|---|---|
| 单脚本运行输出归档 | 默认保留最近 50 次，超过自动清理 |
| outputs/ 目录 | 用户可设置最大大小（默认 1GB） |
| docs/reports/ | 不限，由用户管理 |
| sessions.db | 自动 vacuum，超过 100MB 提示清理 |

### 10.2 Python 启动开销

- 第一次 Agent 写脚本会有 venv 创建延迟（10-30s）
- UI 显示进度，不卡死
- venv 创建后续脚本启动 < 1s

### 10.3 脚本扫描性能

- 启动时扫描 scripts/ 一次
- 后续用文件监听器（chokidar）增量更新
- 大型工作空间（> 1000 脚本）按目录分组懒加载

---

## 11. 安全性

### 11.1 脚本执行的风险

> **Agent 写代码 + 自动执行 = 强大且危险。**

我们必须把"自动写脚本"的风险讲清楚：

| 风险 | 缓解 |
|---|---|
| 脚本读取本机敏感文件 | 路径白名单（仅 workspace 目录） |
| 脚本恶意联网泄漏数据 | 默认禁网，用户主动开启 |
| 脚本无限循环耗 CPU | 进程超时（默认 5 分钟） |
| 脚本占满内存 | 内存限制 |
| 脚本误删数据 | DB 凭证默认只读（如果连接是只读连接） |
| 依赖供应链攻击 | requirements.txt 白名单（未来） |

### 11.2 默认安全模式

新工作空间默认：
- 询问模式
- Python 脚本执行需逐次确认
- 网络禁用
- 仅 workspace 目录可写

进阶用户可调高自动度，但每次跨越安全边界都有警告。

### 11.3 审计

所有脚本运行写入 `.dbagent/history.jsonl`：
```jsonl
{"ts":"...","action":"run_script","path":"scripts/x.py","duration_ms":234,"exit_code":0}
{"ts":"...","action":"write_file","path":"docs/schema.md","size":12345}
```

用户可随时查看 / 导出。

---

## 12. 模块化与扩展

### 12.1 接口

```typescript
// packages/core-workspace/src/types.ts

export interface IWorkspace {
  readonly id: string;
  readonly path: string;
  readonly config: WorkspaceConfig;

  // 文件操作
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  listFiles(relPath: string): Promise<FileEntry[]>;

  // 脚本
  runScript(relPath: string, args?: any): AsyncIterable<ScriptOutput>;
  installDeps(packages: string[]): Promise<void>;

  // Skill / Tool
  loadSkills(): Promise<Skill[]>;
  loadScriptTools(): Promise<ITool[]>;

  // 元
  recordHistory(event: HistoryEvent): Promise<void>;
}

export interface IPythonRuntime {
  readonly type: 'system' | 'venv' | 'docker' | 'embedded';

  detect(): Promise<PythonInfo>;
  run(scriptPath: string, args: string[], opts: RunOptions): AsyncIterable<RunOutput>;
  installPackages(packages: string[]): Promise<void>;
}
```

### 12.2 扩展点

| 点 | 接口 | 用途 |
|---|---|---|
| 新脚本语言 | `IRuntime` | 支持 Node.js / R / Julia 脚本 |
| 新工作空间模板 | 模板目录 | 定制项目结构 |
| 新文件类型 Tab | `ITabType` | 处理 .ipynb 等 |
| 自动生成产物模板 | `templates/*.hbs` | 团队风格 |

### 12.3 模板系统

应用内置常用模板，用户可补充：

```
templates/
├── data-analysis-project/
│   ├── workspace.json
│   ├── scripts/
│   │   └── _example.py
│   ├── docs/
│   │   └── README.md
│   └── README.md
├── etl-project/
└── ...
```

新建工作空间时选择模板即可。

---

## 13. 范围与里程碑

### 13.1 MVP（M5 -- 与现有规划合并）

> 本文档对应的功能放在 M5 里程碑实现。

**M5 必做**：
- [ ] 工作空间核心：创建/打开/切换
- [ ] 工作空间侧栏（文件浏览）
- [ ] Python 编辑器 Tab + 运行 + 输出展示
- [ ] 内置脚本工具（write/run/edit）
- [ ] 工作空间级 Skill 加载
- [ ] 启动屏 + 最近工作空间
- [ ] 自动生成 Schema 文档（基础版）
- [ ] 自动生成 ER 图（mermaid）
- [ ] Skill 自动沉淀（保存当前会话为 Skill）

**M5 可选**：
- [ ] 工作空间脚本注册为 Tool
- [ ] 自动生成数据字典
- [ ] 分析报告生成
- [ ] 自定义产物模板

### 13.2 不进 MVP

- ❌ Notebook 模式（v1.1）
- ❌ 完整沙箱（macOS sandbox-exec / Linux bwrap）
- ❌ 工作空间云同步
- ❌ 团队协作
- ❌ 内嵌 Python 运行时
- ❌ 多语言脚本（仅 Python）

---

## 14. 与设计宗旨的对齐

| 宗旨 | 本文档的体现 |
|---|---|
| **轻量化** | 工作空间不强制（可"快速开始"模式跳过）；脚本运行限制资源；产物按需生成 |
| **模块化** | 工作空间是独立模块；Python 运行时可插拔；脚本即工具的统一抽象 |
| **简洁科技感** | 文件树清爽分组；启动屏简洁；编辑器/运行/输出三段式 |
| **用户体验** | 双击打开、一键生成、Diff 预览、撤销机制；新手"快速开始"；老手"完整工作空间" |

---

## 15. 关键反向决策

> 我们**不做**这些（即使技术上可行）：

- ❌ **网页式协作工作空间**：违背"数据不出本机"原则
- ❌ **强制工作空间**：会拦住"我就想跑个 SQL"的简单用户
- ❌ **复杂的脚本权限模型**：MVP 用简单白名单，足够用
- ❌ **自创脚本语言**：用 Python，不重新发明
- ❌ **重型 IDE 的全部功能**：调试器、性能分析器都不做（用户用 VS Code）
- ❌ **Notebook 编辑器（MVP）**：脚本 + 编辑器 Tab + 输出已能覆盖核心需求

---

## 16. 待定与未来

- [ ] **Notebook 模式**：单文件多 cell（Markdown + SQL + Python 混排）
- [ ] **Agent 自主迭代脚本**：脚本运行报错后 Agent 自己修
- [ ] **跨工作空间复用**：把某个 Skill / 脚本"提升"到用户级
- [ ] **工作空间市场**：分享团队工作空间模板
- [ ] **Schema 变更追踪**：监听 DDL 自动更新 schema.md
- [ ] **数据血缘**：跨脚本/SQL/视图的字段血缘自动构建
- [ ] **报告订阅**：定时跑某个 Skill 输出报告（需调度系统，远期）
- [ ] **Webhook 触发**：外部系统触发 workspace 内的 Skill
