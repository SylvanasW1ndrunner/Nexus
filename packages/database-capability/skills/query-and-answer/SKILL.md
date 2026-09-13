---
name: query-and-answer
description: 将自然语言统计、查询、比较、排名和聚合需求转换为 SQL，并由数据库完成计算。
license: Apache-2.0
allowed-tools: resource_list resource_get knowledge_search sql_execute sql_explain result_read
metadata:
  author: SchemaNaut
  version: '1.0.0'
  capabilities: database.query database.schema
---

# 查询与回答

先确认指标、维度、时间范围和过滤条件；信息不足时使用知识检索或资源浏览确认表、字段、关系和业务定义。

让数据库完成过滤、连接、聚合、排序、窗口计算和异常判断。不要把整张表或大型结果集读取到模型上下文后再计算。执行 SQL 后只读取完成任务所需的最小结果；完整结果通过结果句柄、导出文件或调用方界面交付。

用户明确要求参与的配置、字典或映射必须出现在最终 SQL。回答只陈述数据库结果支持的事实，并说明关键口径和必要假设。
