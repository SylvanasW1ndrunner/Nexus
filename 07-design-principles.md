# 07 - 设计哲学与原则（Design Principles）

> 文档版本：v0.1
> 关联：所有设计文档的统一原则约束

---

## 1. 项目宗旨

> 本文档是所有设计决策的**最高仲裁文件**。
> 当任何模块设计与此原则冲突时，以此文档为准。

### 1.1 四条核心宗旨

1. **轻量化（Lightweight）**：在功能足够的前提下，应用必须轻量
2. **模块化（Modular）**：每一个能力都是可独立演进的模块
3. **简洁科技感（Clean & Tech）**：参考 Postman 风格，简约不简陋
4. **用户体验为终极标准（UX First）**：技术选型、架构决策最终都为体验服务

### 1.2 与差异化优势的对应

我们的差异化不是"AI + 数据库"，是：

| 优势 | 体现 | 文档 |
|---|---|---|
| Agent IDE 而非聊天工具 | 多 Tab、Plan 视图、子 Agent | [03](./03-agent-design.md) |
| 传统能力扎实 | 与 Navicat 持平的核心功能 | [06](./06-classic-features.md) |
| AI/传统融合 | Cmd+K 改写、错误修复、Schema 解读 | [06 §17](./06-classic-features.md) |
| Skill + MCP 双扩展 | 自定义流程 + 工具生态 | [03 §6, §5.4](./03-agent-design.md) |
| 工作空间 + Python 脚本 | Agent 写脚本做数据处理 | [08](./08-workspace-design.md) |
| Agent 反哺工程产物 | 自动生成 ER 图、文档、报告 | [08](./08-workspace-design.md) |

**核心定位**：
> 我们不是"加了 AI 的 Navicat"，也不是"会写 SQL 的 ChatGPT"，
> 我们是**让数据工程师能像程序员用 Cursor 一样高效工作的 Agent IDE**。

---

## 2. 轻量化原则（Lightweight）

### 2.1 量化目标

| 维度 | 目标 |
|---|---|
| 安装包大小 | < 200 MB（Mac/Win/Linux 全平台） |
| 冷启动到主窗口 | < 3 秒 |
| 空闲内存占用 | < 400 MB |
| 重度使用内存 | < 1 GB |
| 本地数据存储 | 用户每个连接 RAG < 200 MB（中型库） |

### 2.2 设计准则

#### 2.2.1 零依赖优先
- 能用 Node 内置 / 纯 TS 实现，不引入大包
- 例：MD5/SHA 用 `node:crypto`，不引入 crypto-js
- 例：日期处理用 `date-fns`（按需）而非 `moment`

#### 2.2.2 按需加载（Code Splitting）
- Monaco 仅加载 SQL 语言包（不打 JS/TS/Python 等）
- 数据库驱动只打 PG，其他动态加载（v1.0 仅 PG）
- 主题、语言文件单独 chunk
- 每个 Tab 类型按需加载组件

#### 2.2.3 按需启动
- 应用启动只起必要后台进程
- MCP server 默认懒启动（除非用户标 `autoStart: true`）
- RAG embedding 模型仅在需要时加载

#### 2.2.4 数据分级存储
- 高频访问：内存 LRU
- 持久化：SQLite（一个文件一个连接）
- 大文件（脚本输出/导出）：直接文件系统
- 不上云、不在内存中堆积

#### 2.2.5 拒绝重型功能进 MVP
| 功能 | 决定 | 理由 |
|---|---|---|
| 数据同步/传输 | ❌ MVP | 本质是 ETL 工具，单独产品 |
| 备份/还原 | ❌ MVP | 用 pg_dump 命令更专业 |
| 计划任务调度 | ❌ MVP | 不是 IDE 的核心责任 |
| 拖拽式 ER 编辑器 | ❌ MVP | 工作量巨大，仅做查看 |
| 模型逆向（生成实体类） | ⏸ 后置 | 优先级低 |
| 实时多人协作 | ⏸ 后置 | 单干阶段做不动 |

### 2.3 反例（不要这样）

❌ "为了完整，把 Navicat 所有功能都加上"
❌ "加个 Sentry 错误监控吧"（默认不开，仅可选）
❌ "把 Electron 升级到最新版顺带打包整个 Chromium 95"（用 stable 版即可）
❌ "把 history 全量加载到 store"（用分页/虚拟滚动）

---

## 3. 模块化原则（Modular）

### 3.1 模块划分准则

#### 3.1.1 按职责分包
```
@dbagent/core-llm      → LLM 调用
@dbagent/core-rag      → RAG 引擎
@dbagent/core-agent    → Agent 编排
@dbagent/core-db       → 数据库驱动抽象
@dbagent/core-tools    → 工具系统
@dbagent/core-skills   → Skill 系统
@dbagent/core-workspace → 工作空间
```

每个 core-* 包：
- **不依赖 Electron**（Node 纯逻辑，便于单测）
- **不依赖其他 core-***（除非通过接口）
- 通过 DI 接收依赖（logger / fs / db）

#### 3.1.2 接口先行
所有跨模块交互**必须先定义接口**，再实现：
- `ILlmProvider`
- `IDbDriver` / `IDbDialect`
- `IDatabaseExtractor`
- `ITool`
- `ISkill`
- `IRetriever`
- `IMcpMarket`

新增数据库 / 模型 / 工具来源时，只实现接口即可，不改核心代码。

#### 3.1.3 注册中心模式
```typescript
DriverRegistry.register('postgresql', PgDriver);
ProviderRegistry.register('openai-compatible', OpenAICompatProvider);
ToolRegistry.register(new QueryDatabaseTool());
```

UI 自动从 registry 渲染选项。

### 3.2 边界明确

| 边界 | 不可跨越 |
|---|---|
| 主进程 ↔ 渲染进程 | 仅通过类型化 IPC |
| Renderer 不能直接读写文件系统 | 必须经主进程 |
| Renderer 不能拿到 API key | API 调用全在主进程 |
| Tool 之间互相不可知 | 通过 ToolRegistry 间接 |
| Skill 是工具的组合者，不直接执行 | 通过 ToolRegistry 调用 |

### 3.3 反模式

❌ 主进程组件知道 React state shape
❌ Renderer 组件直接调用数据库
❌ 一个 core 包深度依赖另一个 core 包的实现细节
❌ "为了简单"在多个地方实现同一份逻辑

---

## 4. 简洁科技感（Clean & Tech）

### 4.1 视觉基调

参考产品：**Postman, Linear, Raycast, Notion, Cursor**

#### 4.1.1 配色
- **深色为默认主题**（数据工程师习惯）
- 主色 1 个（建议品牌色，不抢戏）
- 状态色 4 个：success / warning / error / info
- 灰阶 8-10 级（避免视觉混乱）
- 不用渐变（除非极少数特殊场景）

#### 4.1.2 字体
- UI：Inter / 系统默认
- 代码：JetBrains Mono / Cascadia Code / SF Mono
- 字号：UI 13-14px，代码 13px，标题 16-18px
- 字重：400/500 为主，加粗用 600

#### 4.1.3 留白
- 信息密度中等偏高（IDE 风格，不是营销页）
- 关键操作给足呼吸感
- 列表项不要太挤，也不要太空

#### 4.1.4 图标
- 风格统一（建议 [Lucide](https://lucide.dev)）
- 单色为主
- 一致大小（16/20/24 三档）
- 避免 emoji 滥用（系统图标除外）

### 4.2 信息架构

#### 4.2.1 三栏稳定
- 左：导航（连接/文件/历史）
- 中：工作区（Tab）
- 右：辅助（Chat / Schema / Plan / Tools 切换）
- **不要做更多列**（信息密度临界）

#### 4.2.2 Tab 而非 Modal
- 长任务用 Tab（SQL 编辑器、表设计、ER 图）
- 一次性操作用 Modal（新建连接、确认提交）
- 极简反馈用 Toast（成功/错误提示）

#### 4.2.3 命令优先
- 任何 GUI 操作必须有命令面板入口
- 快捷键覆盖核心操作
- 鼠标党、键盘党都能用

### 4.3 交互细节

#### 4.3.1 反馈即时
- 按钮点击后 200ms 内必须有视觉反馈
- 长任务（> 1s）显示 progress / spinner
- 网络请求超过 500ms 显示加载态

#### 4.3.2 状态可见
- 当前连接、模式、模型显示在顶部 / 底部状态栏
- 修改未保存有明显标识（● / 黄色边框）
- 错误不藏匿（toast / 内联错误）

#### 4.3.3 撤销友好
- 编辑操作支持 Cmd+Z
- 关闭 Tab 支持 Cmd+Shift+T
- 删除操作 5 秒内可撤销（toast 中提供）

### 4.4 反例（避免）

❌ 满屏 emoji（除非用户主动需要）
❌ 一个面板塞 10 个 Tab
❌ 多色 button（一组按钮颜色不要超过 2 种）
❌ 圆角过大（看起来像 toy）
❌ 过多动画（卡顿 / 分散注意）

---

## 5. 用户体验为终极标准（UX First）

### 5.1 决策优先级

当技术 / 性能 / UX 冲突时：

```
UX > 性能 > 简洁性 > 技术新颖性
```

### 5.2 UX 关键准则

#### 5.2.1 尊重用户的工作流
- 不打断长任务（执行中允许切 Tab）
- 不强制弹窗（除非真危险）
- 默认不发送遥测（隐私优先）
- 离线可用（不依赖云）

#### 5.2.2 渐进披露（Progressive Disclosure）
- 默认界面只展示常用功能
- 高级功能折叠在"高级"或"更多"
- 设置项分组合理，不一坨堆

#### 5.2.3 防误操作
- 所有写操作有确认（询问模式）
- 危险操作（DROP / TRUNCATE）双重确认
- 大批量操作（影响 > 1000 行）警告
- 关闭未保存 Tab 提示

#### 5.2.4 智能默认
- 连接时默认开 RAG（除非用户禁用）
- SELECT 自动加 LIMIT 1000（除非用户禁用）
- 查询超时默认 60s（合理值，不太严苛）
- 中文用户默认中文界面

#### 5.2.5 错误友好
- 错误信息中文化（PG 英文错误自动解释）
- 错误旁提供"AI 帮我修复"快捷入口
- 错误可复制到剪贴板
- 严重错误提供错误码（便于反馈）

### 5.3 用户分层

我们的用户不是单一画像，至少包括：

| 用户类型 | 主要场景 | UX 关注点 |
|---|---|---|
| **重度键盘党 DBA** | 写 SQL、改 schema、调优 | 快捷键、命令面板、Vim 模式 |
| **新手分析师** | 用自然语言查数 | Chat 引导、错误提示友好 |
| **后端工程师** | 写业务时偶尔操作 DB | 默认配置开箱即用、不用学 |
| **数据科学家** | 探索性分析、Python 脚本 | 工作空间、Notebook、可视化 |

设计时心里要有这四类人，不要为某一类做出对其他类难用的决策。

### 5.4 体验清单（Acceptance Criteria）

每个新功能上线前 self-check：

- [ ] 有键盘快捷键？
- [ ] 在命令面板可达？
- [ ] 有 loading / error / empty 状态？
- [ ] 移动焦点 / Tab 顺序合理？
- [ ] 错误信息中文友好？
- [ ] 最长操作 < 3 秒（除非显式异步）？
- [ ] 在小屏（1280px）下也能用？
- [ ] 无障碍（aria-label）？

---

## 6. 各模块的优先级映射

### 6.1 在轻量化与功能完整之间的权衡

下表给出每个 [06-classic-features.md](./06-classic-features.md) 中的功能在 MVP 中的优先级：

| 功能 | 轻量化代价 | 用户价值 | 决策 |
|---|---|---|---|
| 连接管理 + Schema 树 | 低 | 极高 | M1 必做 |
| SQL 编辑器 + 执行 | 低 | 极高 | M1 必做 |
| 结果表格 + 导出 | 低 | 极高 | M1 必做 |
| 表数据浏览/编辑 | 中 | 极高 | M2 必做 |
| 表设计器 | 中 | 高 | M3 必做 |
| ER 图（mermaid） | 低 | 中 | M3 做 |
| EXPLAIN 可视化 | 中 | 高 | M3 做 |
| 视图/函数/过程编辑 | 中 | 中 | M4 做 |
| 用户与权限 | 中 | 中 | M4 做 |
| 数据导入向导 | 中 | 中 | M4 做 |
| 拖拽式 ER 编辑 | 高 | 中 | 不做 |
| 数据同步/传输 | 极高 | 中 | 不做 |
| 备份/还原 | 中 | 低 | 不做 |
| 调度任务 | 高 | 低 | 不做 |

### 6.2 AI 部分优先级

| 能力 | 优先级 | 文档 |
|---|---|---|
| Schema RAG | M2 必做 | [02](./02-rag-design.md) |
| 基础 ReAct Loop | M3 必做 | [03 §3](./03-agent-design.md) |
| 询问执行 | M3 必做 | [03 §7](./03-agent-design.md) |
| 内置工具 | M3 必做 | [03 §5.2](./03-agent-design.md) |
| MCP 集成 | M4 必做 | [03 §5.4](./03-agent-design.md) |
| MCP Market | M4 做 | [04 §4.3](./04-config-design.md) |
| Plan & Execute | M5 做 | [03 §4.3](./03-agent-design.md) |
| 子 Agent 并行 | M5 做 | [03 §4.4](./03-agent-design.md) |
| Skill 系统 | M5 做 | [03 §6](./03-agent-design.md) |
| 工作空间 + Python 脚本 | M5 做 | [08](./08-workspace-design.md) |
| Agent 生成 ER/文档 | M5 做 | [08](./08-workspace-design.md) |

---

## 7. 决策仲裁流程

当遇到设计 / 实现争议时，按以下顺序判断：

1. **是否违反核心宗旨？** 违反则改方案
2. **是否影响 MVP 目标？** 影响则推迟
3. **轻量化 vs 用户价值** 用 §6.1 的表格判断
4. **多种方案可选** 选**最简单**的能跑通的方案
5. **没有共识** 默认选**最易回退**的方案

记录到 `docs/adr/NNNN-决策标题.md`（[ADR](https://adr.github.io/) 格式）。

---

## 8. 范围明确决策（Scope Decisions）

> 以下决策已经讨论确定，**不再单独立专项文档，避免后续过度发挥**。

### 8.1 数据安全：不做单独的合规章程

**决策**：数据安全不作为独立模块或专项文档处理。

**理由**：
- 我们支持自部署 LLM（Ollama / vLLM / 用户自有 endpoint），用户完全可以做到数据不出本机
- 默认走云端 LLM 时，**只有 schema 元数据和必要的查询条目**会进 prompt，本来就不是高敏数据
- 用户数据库的真实数据**不会被 Agent 主动塞给 LLM**（除非用户在 chat 中显式粘贴）
- 凭证用 OS keychain，详见 [04-config-design §3.2](./04-config-design.md)
- 不做 SOC2/ISO27001 等企业合规认证（MVP 阶段）

**实现要求（散落在各模块即可）**：
- 凭证不进日志、不进 renderer 进程
- LLM 调用走主进程（避免 CSP / 跨域 / 凭证泄漏）
- 用户可在设置中切到完全本地模型，验证"无外发"
- 默认关闭遥测/崩溃上报

**不做**：
- ❌ 单独的 "data-security.md" 文档
- ❌ 数据脱敏/水印/审计中心（企业版功能，不入 MVP）
- ❌ 合规认证申请（短期不做）

### 8.2 测试策略：真实 API + 任务清单驱动

**决策**：Agent 和 RAG 测试**用真实 API key 跑真实 LLM**，不做 LLM mock。详见 [05-development-guide §6](./05-development-guide.md#6-测试策略)。

**理由**：
- LLM mock 测的是"我们假设它会怎么响应"，不是真实行为
- Agent 真正的不稳定来自真实 LLM（tool calling、参数偏差），mock 测不出
- DeepSeek 价格便宜到 CI 完全跑得起（每次 PR 几毛钱）
- 我们不需要"快速迭代 prompt"的评测框架，而是要"早发现真实问题"

**实际做法**：
1. **构造一个标准测试 PG**（`scripts/test-fixtures/`），含 10-20 张表 + 真实业务数据 + 加密字段 + 故意的烂 schema
2. **维护任务清单**（`tests/manual-cases.md`），30-50 个典型 prompt + 期望行为
3. **CI 跑真实 LLM E2E**：每次 PR 至少 DeepSeek 一遍；每天 nightly 跑多模型矩阵
4. **断言行为不断言文字**：检查"是否调了某工具"、"是否产生了某结构"，不卡死具体输出
5. **传统功能正常单测 + E2E**：Vitest + Playwright

**不做**：
- ❌ LLM 响应 mock / 录制回放
- ❌ 复杂的 metric 评测框架（recall@k 等数值化指标）
- ❌ Prompt A/B 测试基础设施
- ❌ RAG 检索质量的精确数值评估（用任务清单的"必含命中"代替）

**预算控制**：
- CI 用专用低额度测试 key，单 PR 预算上限 ¥10
- 完整 release 候选 checklist ≈ ¥30
- 这点钱比 mock 的维护成本便宜得多

### 8.3 错误恢复：作为基本盘必做

**决策**：错误恢复是传统软件的基本盘，必须做。详见 [09-error-recovery.md](./09-error-recovery.md)。

**理由**：
- 桌面应用最基础的体验保障
- Agent 长任务的不确定性放大了对此的需求
- 不是"AI 加分项"，而是"不做就没法用"

**优先级映射**：
- M1：基础持久化（autosave、Tab 状态、连接重连、ErrorBoundary）
- M3：Agent checkpoint、流式中断恢复
- M4：MCP 健康监控
- M5：Python 脚本沙箱与容错
- M7：崩溃恢复对话框、诊断报告

---

## 9. 反向清单（What we don't build）

明确不做的事，比做的事更重要：

- ❌ **再造一个 Navicat / DBeaver**：我们做差异化，不做替代
- ❌ **All-in-one 数据平台**：不做 ETL、BI、调度、监控
- ❌ **ChatGPT 套壳**：纯对话工具没价值
- ❌ **跨平台不一致**：Mac/Win/Linux 行为必须一致
- ❌ **Web 版本（短期）**：本地数据安全是核心卖点
- ❌ **强耦合特定 LLM**：DeepSeek 是默认，不是唯一
- ❌ **过度抽象**：不做"通用 AI 平台"，专注数据库场景
- ❌ **重型插件市场**：MVP 不做，先把核心做好
- ❌ **数据安全合规专项**：见 §8.1
- ❌ **AI 评测框架**：见 §8.2

---

## 10. 持续校准

### 10.1 每个里程碑结束 review

- 安装包大小是否超标？
- 启动时间是否退化？
- 关键操作是否有快捷键？
- 设计文档是否与实现一致？

### 10.2 用户反馈优先

- 用户说"慢" → 性能优先
- 用户说"找不到" → 信息架构优化
- 用户说"难用" → 交互重设计
- 用户说"少功能" → 评估是否符合宗旨，**不轻易加**

### 10.3 拒绝功能膨胀

新功能进入 MVP 前必须回答：

1. 当前用户的多大比例需要？
2. 是否能用现有功能组合实现？
3. 是否引入新依赖？多大？
4. 上线后维护成本？
5. **不做的代价是什么？** 如果不做也能活，就先不做

---

## 11. 附：与各文档的引用关系

```
07-design-principles (本文档)
   ├── 约束 → 00-overview (项目愿景)
   ├── 约束 → 01-ui-design (界面)
   ├── 约束 → 02-rag-design (RAG)
   ├── 约束 → 03-agent-design (Agent)
   ├── 约束 → 04-config-design (配置)
   ├── 约束 → 05-development-guide (开发)
   ├── 约束 → 06-classic-features (传统功能)
   ├── 约束 → 08-workspace-design (工作空间)
   └── 约束 → 09-error-recovery (错误恢复)
```

**任何文档的设计冲突时，以本文档为准。**
