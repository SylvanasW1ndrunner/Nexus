---
name: dbagent-core-db-development
description: Use when implementing or testing DBAgent/Nexus database IDE core capabilities: PostgreSQL drivers, connection management, SQL execution, transactions, rollback, schema extraction, EXPLAIN, query history, export, network resilience, and future multi-database driver interfaces.
---

# DBAgent Core DB Development

Use this skill for database-facing implementation.

## Required Product Docs

- `docs/product/06-classic-features.md`
- `docs/product/05-development-guide.md`
- `docs/product/09-error-recovery.md`

Read RAG docs only when schema metadata will feed indexing:

- `docs/product/02-rag-design.md`

## Architecture Rules

- Put database behavior in `packages/core-db` or another core package, not directly in renderer UI.
- Keep driver interfaces database-agnostic: prefer `IDbDriver`, dialect, introspector, query executor, and export provider boundaries.
- PostgreSQL is the first implementation, but do not bake PostgreSQL assumptions into shared contracts unless marked dialect-specific.
- Treat remote databases as normal: handle latency, dropped connections, SSL, SSH tunnel configuration, timeouts, cancellation, and reconnect.

## Implementation Checklist

- Connection lifecycle: create, test, pool, reconnect, close.
- Query lifecycle: parse, safety check, execute, stream/page results, cancel, timeout, collect metrics.
- Transaction behavior: begin, commit, rollback, savepoint where useful, error recovery after failed transaction.
- Schema extraction: schemas, tables, columns, constraints, indexes, views, functions, triggers, sequences, comments.
- Performance helpers: `EXPLAIN`, slow query metadata, index hints when defensible.
- Export: CSV, JSON, Excel-capable abstraction, large result safeguards.

## Testing Requirements

- Prefer real PostgreSQL integration tests for behavior that depends on database semantics.
- Cover realistic SQL: CTEs, joins, window functions, temp tables, transactions, rollback, DDL, errors, timeouts, cancellation.
- Test remote-like failure modes where possible: wrong host, wrong credentials, closed connection, SSL mismatch, timeout.
- Keep deterministic fixtures and clean database state after tests.

## Documentation

Update Chinese docs for:

- Public driver contracts.
- Supported PostgreSQL capabilities.
- Known unsupported cases.
- Operational assumptions for local and remote database connections.
