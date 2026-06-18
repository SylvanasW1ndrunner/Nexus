---
name: dbagent-module-doc-authoring
description: Use when writing or updating Chinese DBAgent/Nexus module development documents, API notes, IPC/service contract docs, testing docs, release notes, or implementation logic explanations for backend-first feature slices.
---

# DBAgent 模块文档编写

用于补齐每个核心模块的开发文档，让验收者能理解实现逻辑、接口边界、测试方式和当前限制。此 skill 适用于代码实现前的设计文档，也适用于实现后的同步文档。

## 文档位置

- 模块实现说明：`docs/engineering/modules/`
- release note：`docs/engineering/releases/`
- 测试说明：就近放在模块文档或 `docs/engineering/tests/`
- ADR：重大架构决策放入 `docs/adr/`
- 产品来源：`docs/product/`

## 必写内容

每个核心模块文档至少包含：

- 模块职责：该模块解决什么用户问题，不解决什么。
- 来源文档：引用对应 `docs/product` 文件和章节。
- 代码入口：包、文件、导出类型、服务类、IPC channel。
- 对外合同：输入、输出、事件、错误码、取消/超时语义。
- 数据边界：持久化位置、迁移策略、事务或原子写。
- 安全边界：凭证、SQL 写操作、文件路径、子进程、网络、LLM 输出。
- 失败与恢复：重试、降级、恢复、用户可读错误。
- 测试覆盖：单元、集成、真实依赖、跳过条件。
- 当前限制：明确未完成能力和后续扩展点。

## 写作规则

- 使用中文，事实优先，不写营销语言。
- 引用真实路径、类型名、函数名、IPC channel 和测试文件。
- 不写真实密钥、连接串、用户数据或云端凭证。
- 不隐藏限制；未实现的能力写成“当前限制”或“后续扩展”。
- 文档必须和代码同提交；核心能力没有模块文档不能视为完成。

## 模块文档模板

```markdown
# 模块名

## 模块职责

## 来源文档

## 代码入口

## 对外合同

## 数据与安全边界

## 失败与恢复策略

## 测试覆盖

## 当前限制
```

## Release Note 模板

```markdown
# 版本 - 能力名称

## 新增能力

## 影响范围

## 验证命令

## 已知限制

## 迁移说明
```
