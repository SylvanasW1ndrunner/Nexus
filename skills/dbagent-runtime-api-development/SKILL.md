---
name: dbagent-runtime-api-development
description: Implement or refactor DBAgent Runtime, TypeScript SDK, REST API, CLI, lightweight WebUI management endpoints, public contracts, run state, cancellation, or lifecycle wiring. Use for work in packages/sdk, packages/shared, or apps/server.
---

# DBAgent Runtime and API Development

1. Read the shared foundation, service surfaces, security, and delivery sections in `docs/product-functional-overview.md`.
2. Inspect the public contract and package graph before editing.
3. Put product logic in Runtime services; keep REST, CLI, and WebUI as thin adapters.
4. Version public requests, responses, persisted state, and errors through transport-neutral contracts.
5. Propagate request IDs, AbortSignal, timeouts, connection identity, permission context, and audit context.
6. Never return Secrets from status/list endpoints.
7. Add SDK and REST contract tests for the same scenario.
8. Run type checks, relevant unit tests, real SDK/REST functional tests, applicable performance tests, and npm clean-install validation when packaging changes.

Keep the WebUI intentionally simple and dependent only on public REST contracts.
