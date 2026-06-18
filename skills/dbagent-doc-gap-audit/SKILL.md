---
name: dbagent-doc-gap-audit
description: Use when auditing DBAgent/Nexus docs/product requirements against the current backend implementation, tests, and engineering docs to find missing backend capabilities while frontend UI work is deferred.
---

# DBAgent 文档差距审计

用于把 `docs/product/` 的产品要求转成后端能力缺口清单。此 skill 不直接写代码，输出下一步可执行的功能切片候选。

## 输入范围

优先读取：

- 产品总览与路线：`docs/product/00-overview.md`、`docs/product/05-development-guide.md`
- 最高约束：`docs/product/07-design-principles.md`
- 相关模块文档：`02-rag-design.md`、`03-agent-design.md`、`04-config-design.md`、`06-classic-features.md`、`08-workspace-design.md`、`09-error-recovery.md`、`10-usage-and-subscription.md`
- 已实现记录：`docs/engineering/`
- 代码边界：`packages/core-*`、`apps/desktop/src/main`、`apps/desktop/src/preload`、`packages/shared`

不要把旧 renderer UI 状态纳入缺口判断。当前开发路径是先完成后端和核心能力，最后统一重建前端 UI。

## 审计流程

1. 用 `rg` 查找产品文档中的能力点、里程碑任务和验收标准。
2. 对照代码导出、主进程服务、IPC 合同、测试和工程文档，判断能力状态。
3. 将缺口按用户价值和依赖顺序排序，避免只按文件目录排序。
4. 将每个缺口拆成可独立提交的后端切片。
5. 标出真实依赖：PostgreSQL、LLM、Embedding、Python、MCP、文件系统、终端、打包。

## 状态分类

- `已完成`：有实现、测试、中文工程文档，且可通过非 UI 入口验证。
- `部分完成`：有核心实现但缺少边界、恢复、真实依赖测试、文档或 IPC。
- `未开始`：产品文档要求明确，但代码和测试没有对应能力。
- `阻塞`：需要外部凭证、云服务、签名证书或明确产品决策。
- `后置到 UI`：只涉及最终界面呈现，不影响后端能力建设。

## 输出格式

输出应包含：

- 审计日期和当前分支。
- 已读取的产品文档。
- 缺口表：能力、来源文档、当前证据、风险、建议切片。
- 下一批 3-5 个推荐切片，按优先级排序。
- 不应开发的内容，尤其是前端 UI 重建项。

## 判断标准

优先级高的缺口通常满足：

- 是后续 Agent/RAG/Workspace/Release 的基础能力。
- 用户在无最终 UI 的情况下仍能通过服务、IPC、测试或脚本验证。
- 能降低数据丢失、错误执行、凭证泄露、网络中断或打包失败风险。
- 能被 1 次小提交完成并验证。
