---
name: discover-schema-and-shape
description: 探索数据库结构和有限的数据形态，用于确认候选表、字段、关系、枚举、时间范围、JSON 结构或数据粒度。
license: Apache-2.0
allowed-tools: resource_list resource_get knowledge_search sql_execute sql_explain result_read
metadata:
  author: SchemaNaut
  version: '1.0.0'
  capabilities: database.query database.schema
---

# 发现结构与数据形态

优先通过知识检索和资源浏览定位候选对象，读取最新 Schema、关系和业务知识。只使用工具返回的业务语义内容。

只有元数据不足以完成任务时，才执行小结果集探索 SQL，例如读取 JSON 样例、枚举频次、时间范围或主键候选。探索 SQL 必须直接验证一个明确假设；获得所需事实后立即转入用户目标 SQL。

用户明确要求使用的配置表、字典表或映射必须参与最终 SQL；不得凭经验编造阈值、字段含义或清洗规则。遇到 JSON、枚举、重复值或异常类型时，先探索实际数据形态，再依据用户要求与已知业务规则决定转换方式。
