---
name: schemanaut-nl2sql-knowledge-development
description: Implement SchemaNaut Schema extraction, business knowledge, retrieval, context building, NL2SQL generation, parsing, validation, repair, memory, permission enforcement, or SQL execution. Use for core-db, core-rag, core-llm, and SDK query work.
---

# SchemaNaut NL2SQL and Knowledge Development

1. Read the AI SQL generation and execution, knowledge, security, and shared foundation sections in `docs/product-functional-overview.md`.
2. Keep database facts, organization knowledge, task memory, and runtime evidence distinct and versioned.
3. Preserve connection-level isolation and minimize Schema context sent to the model.
4. Return SQL with explanation, assumptions, evidence, safety, and run identity.
5. Keep generation and execution separate. Revalidate SQL and enforce the selected `read`, `edit`, or `full` permission mode immediately before execution.
6. Prefer deterministic parsing and database validation over Prompt-only guarantees.
7. Add unit tests for parsing/safety/retrieval, real PostgreSQL tests for metadata/execution, and golden evaluations for user-level correctness.
8. Measure refusal and clarification quality as well as successful generation.

Do not add UI-specific behavior to Driver, RAG, LLM, or SDK core.
