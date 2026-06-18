---
name: dbagent-feature-readiness-audit
description: Use when deciding whether a DBAgent/Nexus backend feature is ready to commit, push, package, or release by checking implementation completeness, contracts, docs, tests, security, dependencies, and frontend deferral boundaries.
---

# DBAgent 功能就绪审计

用于提交、推送、打包或发版前判断一个后端功能是否真正完成。它是质量门禁，不替代功能实现。

## 审计输入

读取：

- 当前 diff：`git status --short --branch`、相关 `git diff`。
- 功能来源文档：`docs/product/` 对应章节。
- 工程文档：`docs/engineering/modules/`、`docs/engineering/releases/`。
- 测试输出：类型检查、单元测试、集成测试、真实依赖门控测试、密钥扫描。

## 就绪检查

逐项确认：

- 实现完整：用户场景闭环，不依赖未来 UI 才能验证。
- 合同稳定：导出类型、服务方法、IPC 或事件没有隐式 breaking change。
- 错误可控：超时、取消、重试、恢复、降级、用户错误码已覆盖。
- 安全合格：无明文密钥、无敏感日志、危险 SQL 或文件操作有边界。
- 测试充分：成功、失败、边界、恢复路径已覆盖；真实依赖测试有门控说明。
- 文档同步：中文模块文档、接口说明、测试说明或 release note 已更新。
- 打包可行：新增依赖、原生模块、二进制、平台路径和离线安装影响已评估。
- 前端边界：没有重建旧 UI，没有把最终 UI 工作混入后端切片。

## 判定结果

输出只能是：

- `可以提交`：所有必需检查通过。
- `可以提交但需记录限制`：核心可用，但存在明确的非阻塞限制，必须写入文档。
- `不能提交`：存在破坏合同、缺测试、数据风险、凭证风险、无法验证或范围混乱。

## 阻塞条件

出现以下任一情况，判定为 `不能提交`：

- 类型检查失败。
- 关键测试失败且未修复。
- 涉及凭证、数据库写操作、文件删除、子进程或网络调用但没有安全边界。
- 文档与实现明显不一致。
- 新增依赖未评估打包和许可证。
- 提交包含旧前端 UI 重建内容。

## 输出格式

```markdown
## 就绪结论

结论：

通过项：

阻塞项：

非阻塞限制：

已运行验证：

提交建议：
```
