# DBAgent 设计文档

> 数据工程师的 Agent 原生数据库 IDE
> 文档版本：v0.4（设计阶段）

## 文档索引

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 00 | [overview.md](./00-overview.md) | 总纲：愿景、定位、架构、里程碑 | ✅ |
| 01 | [ui-design.md](./01-ui-design.md) | 界面设计：布局、交互、组件 | ✅ |
| 02 | [rag-design.md](./02-rag-design.md) | RAG：Schema 提取、向量化、混合检索 | ✅ |
| 03 | [agent-design.md](./03-agent-design.md) | Agent：Loop、策略、工具、Skill、子 Agent | ✅ |
| 04 | [config-design.md](./04-config-design.md) | 配置：LLM Provider、连接、MCP、设置 | ✅ |
| 05 | [development-guide.md](./05-development-guide.md) | 开发：项目结构、规范、里程碑、任务 | ✅ |
| 06 | [classic-features.md](./06-classic-features.md) | 传统数据库工具能力（基本盘） | ✅ |
| 07 | [design-principles.md](./07-design-principles.md) | **设计哲学与原则（最高仲裁文件）** | ✅ |
| 08 | [workspace-design.md](./08-workspace-design.md) | 工作空间 + Python 脚本 + Agent 制品 | ✅ |
| 09 | [error-recovery.md](./09-error-recovery.md) | 错误恢复与可恢复性（基本盘） | ✅ |
| 10 | [usage-and-subscription.md](./10-usage-and-subscription.md) | 用量计量与订阅体系（含 BYOK） | ✅ |

## 阅读建议

| 你是谁 / 你的目标 | 推荐顺序 |
|---|---|
| 想了解整体 | 00 → 07 → 08 |
| 做产品/UX | 00 → 07 → 01 → 06 |
| 做后端/Agent | 00 → 07 → 03 → 02 → 08 → 04 |
| 做工程/开发 | 00 → 07 → 05 → 09 → 各模块 |
| 做"任务执行" | 05 §11 里程碑任务清单 |

## 核心决策摘要

### 产品定位
- **Agent IDE，不是 SQL 编辑器**：核心是让 Agent 自主完成任务
- **AI 与传统并重**：[06](./06-classic-features.md) 描述传统能力，要做到与 Navicat 持平
- **三大优势支柱**：Skill（流程化）+ MCP（工具化）+ 工作空间 Python（制品化）

### 技术栈
- 桌面端 Electron + TypeScript 全栈
- 单机架构（用户数据不出本机）
- 闭源、订阅制 + 私有化（未来）
- DeepSeek 默认，多 Provider 可插拔

### MVP 范围（PostgreSQL）
- 连接管理 + Schema 树
- SQL 编辑器 + 结果浏览
- 表数据浏览 + 编辑
- 表设计器 + ER 图（mermaid）
- RAG（向量 + FTS + 图扩展）
- Agent ReAct loop + 询问执行
- MCP Client + Smithery 市场对接
- 工作空间 + Python 脚本 + Agent 写代码
- 自动生成 Schema 文档 / ER 图

### 不做的事
- 重型功能（数据同步、备份、调度）
- 拖拽式 ER 编辑器
- 协作 / Web 版
- ChatGPT 套壳
- 数据安全合规专项文档（详见 [07 §8.1](./07-design-principles.md)）
- 完整 AI 评测框架（详见 [07 §8.2](./07-design-principles.md)）

## 设计宗旨（最高约束）

详见 [07-design-principles.md](./07-design-principles.md)：

1. **轻量化**：安装包 < 200MB，启动 < 3s
2. **模块化**：每个能力独立演进
3. **简洁科技感**：参考 Postman / Linear / Cursor
4. **用户体验为终极标准**

## 下一步

设计阶段（M0）已完成，下一步：
- 基于 [05-development-guide §11.2 M0 任务清单](./05-development-guide.md#112-m0-任务清单可丢给-ai-编码代理执行) 搭建仓库脚手架
- 按里程碑垂直切片推进（M1 → M7）
