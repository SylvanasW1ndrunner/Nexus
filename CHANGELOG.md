# Changelog / 变更日志

All notable changes to SchemaNaut will be documented here.

SchemaNaut 的重要变更都会记录在这里。

## [0.1.0] - Unreleased / 未发布

### Added / 新增

- Embeddable TypeScript SDK, REST API, CLI, and local WebUI.
- OpenAI-compatible, SiliconFlow, Ollama, vLLM, and Anthropic model adapters.
- PostgreSQL connection lifecycle, query jobs, transactions, discovery, observations, operations, audit, and metrics.
- Hierarchical Schema knowledge catalog, hybrid retrieval, and Merkle-based version verification.
- ReAct AI SQL Agent with built-in tools and Skills.
- `read`, `edit`, and `full` permission modes with approval callbacks.
- Durable SQLite sessions, automatic context compaction, manual compaction, and checkpoint history.
- Unified database, warehouse, cluster resource and state contracts.
- MCP client and user Skill extension foundations.

### Current limits / 当前限制

- PostgreSQL is the first complete reference connector.
- MCP and user Skill extension foundations are not yet exposed through every public SDK/API path.
- Secret persistence and multi-tenant service authentication are not production-ready.
- The public npm package has not yet been published.
