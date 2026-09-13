---
name: write-and-verify
description: 生成并执行 INSERT、UPDATE、DELETE、MERGE 或 DDL，随后验证影响范围和最新结构。
license: Apache-2.0
allowed-tools: resource_list resource_get knowledge_search sql_execute sql_explain result_read workspace_apply_patch
metadata:
  author: SchemaNaut
  version: '1.0.0'
  capabilities: database.query database.schema
---

# 写入并验证

先确认目标对象、修改条件、期望结果和可能受影响的范围，再生成边界明确的 SQL。权限引擎会按全局默认、仅风险操作确认或完全访问模式，以及企业规则，决定是否需要许可。

执行后使用数据库返回的影响行数、返回值或有针对性的验证查询确认结果。DDL 成功后刷新或重新读取最新 Schema，后续步骤不得继续依赖旧结构。若用户拒绝许可，尝试不需要该操作的替代路径；没有可行替代时，清楚说明未执行的操作和继续所需条件。
