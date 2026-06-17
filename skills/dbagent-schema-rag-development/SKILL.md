---
name: dbagent-schema-rag-development
description: "Use when implementing DBAgent/Nexus Schema RAG: database metadata extraction, schema documents, sqlite-vec or FTS indexes, progressive indexing, graph expansion, hybrid retrieval, context building, per-connection RAG storage, and RAG tests with real PostgreSQL metadata."
---

# DBAgent Schema RAG Development

Use this skill for schema-aware retrieval and context generation.

## Required Product Docs

- `docs/product/02-rag-design.md`
- `docs/product/06-classic-features.md`
- `docs/product/05-development-guide.md`
- `docs/product/09-error-recovery.md`

## Core Principles

- Schema RAG is not document RAG. Prefer structured metadata, relationships, SQL semantics, and database comments over generic text chunks.
- Keep RAG storage per connection, for example `{appData}/rag/{connectionId}.db`.
- Disconnecting an active connection should clear in-memory active RAG state unless the workflow explicitly keeps it.
- Retrieval must support explicit references like schema/table/column names before relying on embeddings.

## Pipeline

1. Extract metadata from database driver introspection.
2. Normalize into schema documents with stable IDs.
3. Build progressive indexes:
   - Skeleton: schemas, tables, comments, and FTS.
   - Hot tables: columns, constraints, foreign keys, indexes, embeddings when available.
   - Long tail: background indexing.
   - On demand: explicit user references.
4. Build relationship graph for foreign keys, naming, usage, and semantic expansion.
5. Retrieve with a hybrid strategy: exact match, FTS, vector when available, glossary, graph expansion, RRF or reranking.
6. Build token-budgeted context for Agent and SQL workflows.

## Testing Requirements

- Use real PostgreSQL fixtures for schema extraction and relation graph correctness.
- Include schemas with comments, composite keys, foreign-key chains, views, functions, indexes, and similarly named tables.
- Test progressive indexing restart and recovery.
- Test retrieval with Chinese and English aliases where fixtures support it.
- Assert returned context structure and IDs, not model-generated prose.

## Failure Handling

- Corrupted local RAG DB must not break database use.
- Indexing cancellation and app restart must leave a recoverable state.
- Missing embedding provider must fall back to exact and FTS retrieval.
