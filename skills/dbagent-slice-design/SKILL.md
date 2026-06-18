---
name: dbagent-slice-design
description: Use when turning a DBAgent/Nexus product requirement into a backend-first implementation slice with scope, contracts, security boundaries, tests, docs, and commit criteria before coding.
---

# DBAgent 功能切片设计

用于在编码前定义一个小而完整的后端功能切片。目标是让每次提交都能被验证，而不是堆叠半成品。

## 设计前读取

按需读取：

- 路线和任务：`docs/product/00-overview.md`、`docs/product/05-development-guide.md`
- 模块文档：根据功能选择 `02`、`03`、`04`、`06`、`08`、`09`、`10`
- 已有工程文档：`docs/engineering/modules/`、`docs/engineering/releases/`
- 现有代码入口：对应 `packages/core-*`、`packages/shared`、`apps/desktop/src/main`

## 切片定义

每个切片必须明确：

- 用户场景：用户最终要完成什么，不写内部技术愿望。
- 所属模块：唯一主责模块，必要时列出协作模块。
- 对外合同：导出的类型、服务方法、IPC channel、事件或测试入口。
- 数据边界：持久化位置、迁移策略、事务或原子写要求。
- 安全边界：凭证、SQL 写操作、文件路径、子进程、网络、LLM 输出。
- 错误边界：超时、取消、重试、恢复、降级、用户可读错误码。
- 验收方式：确定性测试、真实依赖测试、手动验证步骤。

## 范围控制

- 不重建 renderer UI。
- 不把多个里程碑能力塞进一个切片。
- 不引入新依赖，除非先完成依赖和打包影响评估。
- 不为了测试方便 mock 掉产品真正依赖的关键风险；真实 PG、Python、LLM、MCP 通过环境门控执行。
- 不提交没有中文工程文档的核心能力。

## 输出模板

```markdown
## 功能切片

用户场景：

来源文档：

实现范围：

不做范围：

对外合同：

数据与安全边界：

测试计划：

文档计划：

提交标准：
```

## 进入实现的门槛

只有满足以下条件才开始编码：

- 切片能在一个小提交内完成。
- 验收可以脱离最终 UI 进行。
- 已知道需要修改哪些模块和哪些测试。
- 已确认不会破坏已有 IPC、持久化格式或打包路径。
