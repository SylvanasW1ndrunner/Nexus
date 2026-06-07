# 00 - 总纲（Overview）

> 项目代号：**DBAgent**（暂定，最终名称待定）
> 文档版本：v0.1
> 最后更新：2026-05

---

## 1. 项目愿景

### 1.1 一句话定义

> **DBAgent 是一款面向数据工程师的 Agent 原生数据库 IDE。** 它不仅是 SQL 编辑器，更是能够自主完成"理解 Schema → 生成 SQL → 调用工具 → 执行任务 → 解读结果"全流程的智能工作台。

### 1.2 与现有产品的关系

| 维度 | Navicat / DBeaver | Vanna / Chat2DB | **DBAgent** |
|---|---|---|---|
| 核心定位 | SQL 编辑器 | Text-to-SQL | **Agent IDE** |
| AI 能力 | 插件式辅助 | 单轮生成 | **多步 Agent 自主执行** |
| 工具扩展 | 无 | 无 | **MCP 生态 + 内置工具** |
| 上下文 | 全量 schema 复制粘贴 | 简单 RAG | **结构化 RAG + 业务语义层** |
| 执行模式 | 手动 | 手动 | **询问 / 自动双模式** |
| 商业模式 | License 买断 | 开源 + 企业版 | **订阅制 + 私有化** |

### 1.3 目标用户

**主要用户**：
- 数据分析师（写 SQL 但不擅长复杂查询）
- 后端工程师（业务开发顺带操作数据库）
- DBA（需要批量分析、跨库操作）

**次要用户**：
- 数据科学家（探索性查询）
- 产品经理 / 运营（基于自然语言查数）

### 1.4 核心价值主张

1. **零上下文输入**：连接数据库即自动建立 RAG，告别复制粘贴 schema
2. **Agent 自主完成任务**：不只是生成 SQL，而是端到端完成"分析任务"
3. **可扩展工具生态**：内置工具 + 用户自定义 MCP + 公共 MCP Market
4. **执行安全网**：双模式（询问/自动）+ 危险操作拦截 + 可回滚事务
5. **国内友好**：DeepSeek 默认接入、中文优化、私有化可选

---

## 2. 产品形态

### 2.1 形态定位

**桌面应用（Desktop App）+ 单机架构**

- **打包方式**：Electron + TypeScript
- **运行方式**：用户本机运行，数据库连接、RAG、Agent 全部在本地
- **数据流向**：用户数据库 ↔ 本机 App ↔ LLM API（仅 prompt 经过云端）
- **企业版**：支持完全离线（本地 LLM via Ollama / vLLM）

### 2.2 为什么是桌面端

| 候选 | 优点 | 缺点 | 是否选用 |
|---|---|---|---|
| Web SaaS | 部署简单 | 数据要经过服务器，企业不接受 | ❌ |
| VS Code 扩展 | 分发现成 | 受限于 VSCode UI，非技术用户门槛高 | ❌ |
| **桌面端 (Electron)** | 完整体验、本地数据、商业化清晰 | 包体积大 | ✅ |
| CLI | 启动快 | 用户面窄、表格展示差 | ❌ |

### 2.3 单机架构示意

```
┌─────────────────────────────────────────────────┐
│  Electron Desktop App                            │
│                                                  │
│  ┌──────────────────┐       ┌────────────────┐  │
│  │   Renderer       │       │  Main Process  │  │
│  │   (React UI)     │ ←IPC→ │  (Node.js)     │  │
│  │                  │       │                │  │
│  │  - 对话窗口      │       │  - Agent Core  │  │
│  │  - 结果表格      │       │  - DB Pool     │  │
│  │  - Schema 树     │       │  - RAG Engine  │  │
│  │  - 设置面板      │       │  - MCP Client  │  │
│  └──────────────────┘       │  - LLM Router  │  │
│                             └────────┬───────┘  │
└──────────────────────────────────────┼──────────┘
                                       │
              ┌────────────────────────┼─────────────────────┐
              │                        │                     │
        ┌─────▼──────┐          ┌──────▼─────┐         ┌─────▼──────┐
        │ User's DB  │          │ LLM API    │         │ MCP Servers│
        │ (PG/MySQL) │          │ (DeepSeek/ │         │ (local +   │
        │            │          │  Claude/   │         │  remote)   │
        │            │          │  Ollama)   │         │            │
        └────────────┘          └────────────┘         └────────────┘
```

> **关键原则**：**用户数据永不经过我们的服务器**。这是数据库工具商业化的底线。

---

## 3. 核心功能模块

### 3.1 模块全景图

```
┌────────────────────────────────────────────────────────────┐
│                        DBAgent App                          │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ UI Layer │  │  Agent   │  │   RAG    │  │ Connection │  │
│  │  (React) │  │  Engine  │  │  Engine  │  │  Manager   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │             │             │              │          │
│       └─────────────┼─────────────┼──────────────┘          │
│                     │             │                          │
│              ┌──────▼─────────────▼──────┐                  │
│              │      Core Services         │                  │
│              │  - LLM Router              │                  │
│              │  - MCP Client Manager      │                  │
│              │  - Tool Registry           │                  │
│              │  - Skill Registry          │                  │
│              │  - Session Manager         │                  │
│              │  - Permission/Approval     │                  │
│              └────────────┬───────────────┘                  │
│                           │                                  │
│              ┌────────────▼───────────────┐                  │
│              │      Storage Layer         │                  │
│              │  - SQLite (sessions/cfg)   │                  │
│              │  - sqlite-vec (vectors)    │                  │
│              │  - File system (skills)    │                  │
│              └────────────────────────────┘                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 模块清单与文档索引

| # | 模块 | 职责 | 详细文档 |
|---|---|---|---|
| 1 | **UI Layer** | 用户交互、对话窗、结果展示 | [01-ui-design.md](./01-ui-design.md) |
| 2 | **RAG Engine** | Schema 提取、向量化、检索 | [02-rag-design.md](./02-rag-design.md) |
| 3 | **Agent Engine** | 任务规划、ReAct loop、子 agent | [03-agent-design.md](./03-agent-design.md) |
| 4 | **Configuration** | 模型配置、连接、权限设置 | [04-config-design.md](./04-config-design.md) |
| 5 | **Development** | 项目结构、技术栈、里程碑 | [05-development-guide.md](./05-development-guide.md) |
| 6 | **Classic Features** | 传统数据库工具能力（基本盘） | [06-classic-features.md](./06-classic-features.md) |
| 7 | **Design Principles** | 设计哲学与原则（最高仲裁） | [07-design-principles.md](./07-design-principles.md) |
| 8 | **Workspace** | 工作空间 + Python 脚本 + Agent 制品 | [08-workspace-design.md](./08-workspace-design.md) |
| 9 | **Error Recovery** | 错误恢复、自动保存、崩溃恢复 | [09-error-recovery.md](./09-error-recovery.md) |
| 10 | **Usage & Subscription** | 用量计量、订阅、注册登录、BYOK | [10-usage-and-subscription.md](./10-usage-and-subscription.md) |

---

## 4. 关键设计原则

### 4.1 模块化（Modularity）

- **数据库适配器抽象**：MVP 仅 PostgreSQL，但接口设计兼容 MySQL/Oracle/ClickHouse/MongoDB
- **LLM Provider 抽象**：默认 DeepSeek，支持 OpenAI/Claude/Ollama/vLLM 任意 OpenAI 兼容端点
- **工具系统统一**：内置工具、用户 MCP、市场 MCP 走同一调用接口
- **Agent 策略可插拔**：ReAct / Plan-and-Execute / Reflexion 等策略可切换

### 4.2 安全优先（Security First）

- **默认询问执行**：所有写操作（INSERT/UPDATE/DELETE/DDL）需用户确认
- **只读模式**：连接级别可强制只读，agent 无法越权
- **事务回滚**：DML 默认在事务中执行，失败自动回滚
- **凭证隔离**：数据库密码、API Key 用 OS keychain 加密存储
- **审计日志**：所有 SQL 执行记录可追溯

### 4.3 渐进增强（Progressive Enhancement）

- **离线可用**：连接 + SQL 执行不依赖网络
- **AI 增强**：网络可用时启用 RAG + Agent
- **本地模型**：Ollama/vLLM 支持完全本地化

### 4.4 用户掌控（User in Control）

- **模式切换**：询问执行 / 自动执行 随时切换
- **会话隔离**：每个会话独立 context，可命名、可导出
- **撤销机制**：所有 agent 行为可中止、可回退

---

## 5. 技术栈总览

| 层 | 技术 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 30+** | 成熟、AI 生态友好、社区资源多 |
| 前端 | **React 18 + TypeScript** | 团队熟悉、组件库丰富 |
| 状态管理 | **Zustand** | 轻量、好用 |
| UI 库 | **Radix UI + Tailwind CSS** | 现代化、可定制 |
| 主进程 | **Node.js 20+ (TypeScript)** | 与渲染进程同语言 |
| Agent 框架 | **Vercel AI SDK + 自写 loop** | TS 原生、tool calling 简洁 |
| 数据库驱动 | **pg (PostgreSQL)** + 适配层 | 官方稳定 |
| 向量存储 | **sqlite-vec** | 嵌入式、零部署 |
| Embedding | **BGE-M3** (本地) / **OpenAI 兼容** | 中英文双优 |
| MCP | **@modelcontextprotocol/sdk** | 官方 SDK |
| 凭证存储 | **keytar** | OS keychain 集成 |
| 打包 | **electron-builder** | 跨平台 |
| 测试 | **Vitest + Playwright** | 单元 + E2E |

---

## 6. 实现效果（Demo 场景）

### 6.1 场景一：自然语言查数

```
用户：上周哪个商品销量最高？

[Agent 思考]
  → 检索 RAG：products / orders / order_items 三张表相关
  → 生成 SQL：SELECT ... JOIN ... GROUP BY ... ORDER BY ... LIMIT 1
  → 询问用户确认（默认询问模式）
  → 执行
  → 解读：上周销量最高的是 XX 商品，共售出 1234 件

[结果区域]
| product_name | total_sold |
|--------------|------------|
| iPhone 15    | 1234       |
```

### 6.2 场景二：调用自定义工具（MCP）

```
用户：把用户表里 phone 字段解密后，统计每个城市的注册人数

[Agent 思考]
  → 检索 RAG：users 表，phone 字段标注为 AES 加密
  → 发现已挂载 decrypt_phone MCP tool
  → 计划：
    1. SELECT id, phone FROM users
    2. 对每条 phone 调用 decrypt_phone tool
    3. 解析城市码，按城市聚合
  → 询问用户：是否执行（涉及全表扫描）？
  → 用户确认后执行
  → 输出聚合结果
```

### 6.3 场景三：子 Agent 并行

```
用户：帮我分析为什么上周 GMV 下降了

[主 Agent 拆解任务]
  → 子 Agent 1：分析订单数变化
  → 子 Agent 2：分析客单价变化
  → 子 Agent 3：分析退款率变化
  [三个子 Agent 并行执行 SQL 查询]

[主 Agent 汇总]
  → 输出分析报告：
    - 订单数同比 -5%
    - 客单价同比 -8% （主因）
    - 退款率上升 2pp
    → 建议：检查 7/15 上线的优惠券规则
```

---

## 7. 商业化路径

> 详细见 [10-usage-and-subscription.md](./10-usage-and-subscription.md)。

### 7.1 双路径商业模式

| 路径 | 形态 | 是否登录 | 是否联网 | 计费 |
|---|---|---|---|---|
| **BYOK（用户自带 key）** | 完全免费 | ❌ | 取决于用户的 endpoint | 用户自付 LLM 费用 |
| **订阅（用我们的 LLM）** | 付费 | ✅ 必须注册 | ✅ 走我们的 gateway | 时间窗口配额（如 5h N 轮，参考 Claude Code） |

> BYOK 永久免费，所有功能不锁；订阅的核心价值是"代付 LLM 费用 + 省去 API key 管理"。

### 7.2 阶段规划

| 阶段 | 形态 | 关键能力 |
|---|---|---|
| MVP（开发期） | 闭源桌面端 + Free/Pro 订阅 | DeepSeek 默认、PG 支持、基础 Agent、注册登录骨架 |
| v1.0 | 个人版 + 团队版 | 多数据库、MCP Market、Skill 系统、设备管理 |
| v2.0 | 企业版 | 私有化部署、SSO、审计、本地 LLM、自定义合规 |

### 7.3 技术决策对商业的硬要求

- 私有化部署 → LLM Provider 必须可插拔
- 企业合规 → 数据不出本机（对应 BYOK 模式）
- 团队协作 → Skill / RAG 训练数据可导出/共享
- 订阅计费 → **从 M1 起就要有用量记录 + 注册登录骨架**（避免后期重构）

---

## 8. 项目里程碑

| 里程碑 | 范围 | 验收标准 |
|---|---|---|
| **M0：设计完成** | 5 份设计文档 | 当前阶段 |
| **M1：可连可查** | DB 连接 + 手动 SQL 执行 + 结果展示 | 端到端能跑 PG |
| **M2：RAG 上线** | Schema 提取 + 向量化 + 检索 | 能基于 RAG 生成 SQL |
| **M3：Agent 上线** | ReAct loop + 询问执行 + Tool 调用 | 三大 demo 场景跑通 |
| **M4：MCP 集成** | MCP Client + 公共 Market 对接 | 能挂载用户 MCP server |
| **M5：Beta 发布** | 打包 + 安装包 + 基础订阅 | 邀请 50 个内测用户 |

> 每个里程碑采用**垂直切片**方式，端到端可跑可 demo。

---

## 9. 文档维护规则

- 所有设计变更需更新对应文档并标注版本
- 重大架构决策记录在 `docs/adr/` 目录（待建）
- 每次里程碑发版前 review 一次文档与实现的偏差
