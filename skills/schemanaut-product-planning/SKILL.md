---
name: schemanaut-product-planning
description: Use when planning SchemaNaut product scope, Capability modules, milestones, acceptance criteria, roadmap changes, or architecture boundaries for the general Agent Runtime.
---

# SchemaNaut Product Planning

1. Read `docs/product/overview.md`, then select only the relevant architecture, Capability, guide, or reference documents from `docs/README.md`.
2. Treat the Journal-driven Agent Runtime as the core, with private composition in `packages/agent-host` and the current user entry in `apps/terminal`. SDK, HTTP API, and WebUI are deferred and must not be restored without a new request.
3. Model professional behavior as equal Capability modules. Database is the first production Capability, not a prerequisite or global product identity.
4. Keep installed, discovered, configured, active, and Agent-published states distinct in plans and acceptance criteria.
5. Separate current implementation from planned work. Do not describe a future Capability as shipped or create placeholder documentation for it.
6. Choose the smallest vertical slice that reaches a user through the terminal and defines security, persistence, observability, recovery, verification, and documentation boundaries.
7. Define concrete scenarios, public contracts, non-goals, package-direction constraints, dependencies, risks, and acceptance evidence.
8. For database-specific planning, preserve PostgreSQL depth and complete `read`, `edit`, and `full` permission behavior inside the database Capability rather than moving SQL concerns into Agent core.

Return a prioritized recommendation with the first shippable slice, explicit Capability boundary, and proportionate quality gates.
