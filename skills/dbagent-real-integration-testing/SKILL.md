---
name: dbagent-real-integration-testing
description: Use when designing or running DBAgent/Nexus tests against real dependencies such as PostgreSQL, shell/terminal processes, Python interpreters, filesystem persistence, packaging smoke runs, or LLM/embedding providers behind explicit environment gates.
---

# DBAgent Real Integration Testing

Use this skill when unit tests are insufficient because the risk lives in PostgreSQL semantics, process IO, filesystem behavior, native packaging, or real provider behavior.

## Required Reading

- `docs/product/05-development-guide.md` §6 for the testing strategy.
- `docs/product/09-error-recovery.md` for resilience and recovery scenarios.
- Feature-specific product docs.
- Existing tests in the touched package.

## Test Ladder

1. Deterministic unit tests for pure functions and validation.
2. Service integration tests with real local resources.
3. Real PostgreSQL tests for SQL, transactions, schema extraction, locks, timeouts, rollback, and network-like failures.
4. Real process tests for terminal, shell, Python, cancellation, stdin/stdout/stderr, and exit codes.
5. Real provider tests only behind explicit env gates; default test runs must not require secrets.
6. Packaging smoke tests when native modules, subprocesses, or bundled assets are touched.

## PostgreSQL Requirements

- Test CTEs, joins, window functions, JSONB, temp tables, DDL, transactions, savepoints, rollback, errors, timeouts, cancellation, and permission denial when relevant.
- Use fixture schemas that look like real business systems: users, orders, order_items, soft deletes, comments, indexes, foreign keys, views, functions, and messy naming.
- Clean state after tests.
- Never log passwords or full connection URLs.

## Process And Python Requirements

- Prove interactive stdin and stdout, not only process creation.
- Include timeout, cancel, kill, broken interpreter, missing executable, nonzero exit, and large output.
- Test Windows paths and Linux-compatible assumptions.

## Provider-Gated Tests

- Use environment variables such as `TEST_DEEPSEEK_API_KEY`, `TEST_OPENAI_API_KEY`, or provider-specific endpoints.
- Skip with an explicit reason when env vars are absent.
- Assert tool calls, schemas, and state transitions rather than exact prose.
- Redact requests and responses before writing logs or snapshots.

## Reporting

When reporting validation, include:

- Tests run and pass/fail result.
- Tests skipped and exact reason.
- Real dependencies used.
- Residual risk that still needs manual or release-level verification.
