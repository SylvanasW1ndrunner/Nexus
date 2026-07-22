---
name: dbagent-security-quality-release
description: Review DBAgent security boundaries, dependencies, tests, PostgreSQL integration, observability, npm packaging, release readiness, or documentation consistency. Use before commits, releases, dependency changes, or when deciding whether a feature is genuinely complete.
---

# DBAgent Security, Quality, and Release

1. Read the security, observability, quality, and acceptance sections in `docs/product-functional-overview.md`.
2. Inspect dirty changes first and preserve unrelated user work.
3. Trace the user scenario through SDK/API, Runtime, policy, database, storage, and observability.
4. Check SQL safety, read-only enforcement, permission, approval provenance, Secret/PII redaction, cancellation, limits, and recovery.
5. Review new dependencies for necessity, maintenance, license, native binaries, install scripts, package size, and private-data behavior.
6. Run type checks, full unit tests, relevant real PostgreSQL/model/MCP tests, smoke checks, and clean npm package installation in proportion to risk.
7. Inspect the tarball contents and verify CLI, REST health, and SDK import.
8. Ensure docs distinguish implemented and planned capabilities without migration history.

Report exact passes, skips, failures, and residual risks. Do not declare release-ready when a required gate was skipped.
