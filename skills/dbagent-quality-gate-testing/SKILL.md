---
name: dbagent-quality-gate-testing
description: Use when validating DBAgent/Nexus backend features, designing user-level test plans, running TypeScript/Vitest/PostgreSQL/LLM-gated tests, checking docs and release readiness, or deciding whether a feature can be committed or released.
---

# DBAgent Quality Gate And Testing

Use this skill before committing, releasing, or declaring a DBAgent backend slice complete.

## Required Product Docs

- `docs/product/05-development-guide.md` for test layers and coding standards.
- `docs/product/09-error-recovery.md` for resilience expectations.
- The module-specific product doc for the feature under test.
- The module-specific engineering docs under `docs/engineering/` when present.

## Test Philosophy

- Test the behavior users depend on, not only implementation details.
- Deterministic unit tests are required, but not sufficient for integration-heavy features.
- Use real PostgreSQL for database behavior.
- Use real shell/Python processes for terminal and Python runtime behavior.
- Use real LLM providers only behind explicit environment gates; never require secrets for the default test run.
- Do not expose API keys or credentials in logs, snapshots, docs, or commits.

## Standard Validation Ladder

1. Static check: TypeScript compile for touched packages.
2. Unit tests: pure logic and service contracts.
3. Integration tests: PostgreSQL, filesystem, subprocess, IPC service handlers as applicable.
4. Resilience tests: timeout, cancellation, corrupted config, reconnect, rollback, partial stream, process exit.
5. Documentation check: Chinese module docs, API docs, and test docs are updated.
6. Packaging impact check: dependency size, native module packaging, Windows/Linux behavior, offline install risk.
7. Secret scan: search for real API keys and credential patterns before commit.

## Required Scenario Coverage

- Happy path for the target user workflow.
- Invalid input and malformed config.
- Permission denied or readonly mode.
- Timeout and cancellation.
- Crash/restart or persistence recovery where the module stores state.
- Windows path behavior and Linux-compatible assumptions for cross-platform code.
- Large-result or long-running behavior when the feature can scale poorly.

## Release Gate

Before creating a version artifact or release folder:

- Full test suite passes or skipped tests are justified.
- Typecheck passes for all touched packages and `apps/desktop` if contracts changed.
- Release notes in Chinese describe scope, known limitations, and validation.
- A smoke run verifies the app starts with the minimal host and backend services load.
- Dependency changes are documented with license and packaging notes.

## Output Format For Reviews

When reporting validation, include:

- Changed capability.
- Tests run and results.
- Tests not run and reason.
- Residual risk.
- Commit hash or working tree status when relevant.
