---
name: schemanaut-product-planning
description: Plan SchemaNaut product modules, milestones, scope, acceptance criteria, and implementation work for the AI SQL Agent. Use when deciding what to build next, reconciling product scope, or updating roadmap and architecture docs.
---

# SchemaNaut Product Planning

1. Read `docs/product-functional-overview.md` and identify the relevant functional module before changing scope.
2. Treat SDK/API as the product core. Keep CLI and WebUI as thin clients of the same Runtime.
3. Separate current implementation, core-only capabilities, and planned work.
4. Choose the smallest vertical slice that reaches a user through SDK or REST and includes security, storage, observability, tests, and docs.
5. Define concrete user scenarios, public contracts, non-goals, dependencies, risks, and acceptance checks.
6. Prefer PostgreSQL depth and complete `read`, `edit`, and `full` permission behavior before adding more database engines.
7. Update the functional design when a decision changes product boundaries.

Return a prioritized recommendation with the first shippable slice and its quality gates.
