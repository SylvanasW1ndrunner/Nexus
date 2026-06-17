---
name: dbagent-db-sql-rag-development
description: Use when implementing DBAgent/Nexus database adapters, PostgreSQL connection lifecycle, SQL execution/audit/rollback/performance tooling, result export/filter contracts, Schema RAG extraction/indexing/retrieval/context, or database integration tests.
---

# DBAgent Database, SQL, And RAG Development

Use this skill for all database engine and Schema RAG work. Keep implementation backend-first; final UI integration is deferred.

## Required Product Docs

- `docs/product/06-classic-features.md` for traditional database IDE behavior.
- `docs/product/02-rag-design.md` for Schema RAG contracts.
- `docs/product/04-config-design.md` for connection config, secrets, SSL/SSH, and IPC contracts.
- `docs/product/09-error-recovery.md` for reconnect, cancellation, rollback, and recovery.
- `docs/product/05-development-guide.md` for package layout and testing policy.

## Core Boundaries

- Database logic belongs in `packages/core-db` or the current DB-owning package.
- RAG logic belongs in `packages/core-rag`.
- Agent-facing database tools belong in `packages/core-tools`, using core-db and core-rag contracts.
- Electron IPC only exposes typed service operations; renderer must not hold credentials.

## Database Requirements

- PostgreSQL is first-class; design adapter interfaces so MySQL, Oracle, ClickHouse, and others can be added later.
- Support remote database reality: network timeout, DNS failure, TCP reset, slow queries, SSL config, SSH tunnel placeholder, reconnect, and cancellation.
- Keep connection pools per configured connection. Release clients in `finally`.
- Distinguish user disconnect from abnormal network disconnect; only user disconnect should clear RAG by default.
- Implement write SQL inside transactions where the product requires rollback protection.

## SQL Execution And Audit

- Classify SQL as select, insert, update, delete, ddl, explain, transaction, or unknown.
- Detect dangerous operations: `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `DELETE/UPDATE` without `WHERE`, large-table full scans where available.
- Add query timeout and cancellation. PostgreSQL cancellation should use a real backend cancel path when possible.
- Record SQL history and audit metadata without logging secrets.
- For result sets, support pagination/streaming and export providers for CSV, Excel, and JSON at service level.

## Schema RAG Requirements

- Extract schema, table, column, primary key, foreign key, index, view, comments, row estimates, and optional samples.
- Use progressive indexing:
  - Stage 1: table skeleton plus keyword search, fast enough for immediate use.
  - Stage 2: hot tables with columns, relations, and embeddings.
  - Stage 3: long-tail background indexing with CPU yielding.
- Retrieval should combine explicit references, keyword search, vector search where enabled, glossary hits, RRF ranking, graph expansion, and token-budget pruning.
- Context builder must output structured schema snippets, not unbounded schema dumps.
- Keep each connection's RAG index isolated.

## Testing Requirements

- Unit test SQL classification, danger detection, parameter handling, context building, ranking, and token pruning.
- Integration test against real PostgreSQL for connection, schema extraction, DML rollback, transaction behavior, cancellation, network-like failures where feasible, and complex SQL.
- Include fixtures with joins, JSONB, indexes, foreign keys, comments, soft delete, encrypted-field markers, and large-ish tables.
- Performance tests should assert practical bounds for extractor/retriever logic without making CI flaky.

## Done Criteria

- A non-UI caller can connect to PostgreSQL, inspect schema, execute safe SQL, handle failures, and retrieve relevant schema context.
- Tests cover real database behavior, not only mocks.
- Chinese docs explain API contracts, edge cases, and operational limits.
