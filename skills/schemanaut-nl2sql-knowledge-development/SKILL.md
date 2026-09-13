---
name: schemanaut-nl2sql-knowledge-development
description: Use when implementing SchemaNaut database Capability work involving Schema extraction, knowledge retrieval, NL2SQL, SQL validation or execution, database permissions, result evidence, or PostgreSQL integration.
---

# SchemaNaut NL2SQL and Knowledge Development

1. Read `docs/capabilities/database/overview.md`, `schema-knowledge.md`, and `sql-execution-results.md`; use `docs/product/overview.md` only for the general Runtime boundary.
2. Keep all SQL-specific behavior inside `database-capability`, `core-db`, or `core-rag`. Do not add database dependencies, SQL system roles, or direct database execution paths to `core-agent` or `core-tools`.
3. Keep database facts, organization knowledge, Session memory, Journal facts, and runtime evidence distinct and versioned.
4. Preserve connection-level isolation, immutable retrieval snapshots, bounded model context, and controlled Result Handles for large outputs.
5. Return generated SQL with explanation, assumptions, evidence, safety classification, and durable run identity.
6. Keep generation and execution separate. Revalidate SQL and enforce the selected `read`, `edit`, or `full` permission mode immediately before execution.
7. Prefer deterministic parsing, AST policy, connector contracts, and database validation over Prompt-only guarantees.
8. Verify parsing, safety, retrieval, recovery, and publication with proportionate local checks; use real PostgreSQL and model evaluations only when their explicit environment is available.
9. Measure refusal and clarification quality as well as successful generation.

Keep terminal-specific behavior out of Driver, RAG, LLM, and Agent core. The database Capability must remain optional for the general Agent Runtime.
