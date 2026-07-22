---
name: dbagent-database-operations-development
description: Build or test DBAgent PostgreSQL health checks, EXPLAIN analysis, slow-query diagnosis, lock analysis, long-transaction diagnosis, operation previews, approvals, verification, or future controlled actions. Use for AI database management and operations features.
---

# DBAgent Database Operations Development

1. Read the AI database governance and operations, Agent extension, and shared foundation sections in `docs/product-functional-overview.md`.
2. Start with a user incident and the database evidence required to diagnose it.
3. Separate facts, hypotheses, impact, recommendations, and limitations.
4. Implement read-only collection tools before action tools. Never hide a termination or write inside a diagnostic handler.
5. Validate every user-derived number or identifier; parameterize values where supported.
6. For future actions, require Preview → Approval → Execute → Verify → Audit, with immutable approved parameters.
7. Test permission failures, missing PostgreSQL extensions, timeouts, cancellation, empty results, and real lock/transaction fixtures.
8. Expose the capability through Runtime SDK/API and add observability before calling it complete.

Do not use EXPLAIN ANALYZE by default or automatically terminate sessions.
