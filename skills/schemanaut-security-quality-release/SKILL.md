---
name: schemanaut-security-quality-release
description: Review SchemaNaut terminal and runtime security boundaries, dependencies, verification, PostgreSQL integration, observability, and documentation consistency.
---

# SchemaNaut Security, Quality, and Release

1. Read `docs/product/overview.md` and `docs/engineering/verification.md`, then the relevant architecture document.
2. Inspect dirty changes first and preserve unrelated user work.
3. Trace the user scenario through the terminal, internal Agent host, Runtime, policy, applicable Capability, storage, and observability.
4. Check SQL safety, read-only enforcement, permission, approval provenance, Secret redaction, cancellation, limits, and recovery. Do not add data-content rules that are not part of the product design.
5. Review new dependencies for necessity, maintenance, license, native binaries, install scripts, package size, and private-data behavior.
6. Complete static development first, then run type checks and relevant behavior verification together. Real PostgreSQL/model/MCP tests require their explicit environment; avoid repeating full suites per edit.
7. Verify terminal startup, configuration, sessions, and task execution. SDK/API and their prior npm packaging are removed; do not use historical release results as current evidence.
8. Ensure docs distinguish implemented and planned capabilities without migration history.

Report exact passes, skips, failures, and residual risks. Do not declare release-ready when a required gate was skipped.
