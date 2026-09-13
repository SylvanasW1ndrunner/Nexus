---
name: recover-from-sql-error
description: 根据数据库错误、最新 Schema 和方言信息修正 SQL。
license: Apache-2.0
allowed-tools: resource_list resource_get knowledge_search sql_execute sql_explain result_read
metadata:
  author: SchemaNaut
  version: '1.0.0'
  capabilities: database.query database.schema
---

# 从 SQL 错误恢复

读取数据库返回的结构化错误，区分语法、对象、字段、类型、函数、权限和运行时问题。不要只重复生成近似 SQL。

需要数据库事实时，刷新 Schema、重新检索相关对象或执行针对性的有限探索。只修改与已确认错误直接相关的部分，并保持用户原始业务目标不变。每次修正后重新执行或验证；相同路径没有产生新证据时，更换查询方式、工具或检索入口。
