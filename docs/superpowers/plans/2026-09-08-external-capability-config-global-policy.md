# External Capability Configuration and Global Policy Implementation Plan

> **For maintainers:** Follow this plan in order. Documentation is the contract and must land before runtime code. Per the product decision, implementation is understanding-first; tests are updated and run after the functional changes rather than driving each edit.

**Goal:** Remove SchemaNaut-owned Capability/model project configuration, add one global TOML source for models and enterprise permissions, and replace Agent `read/edit/full` with `default/auto/full-access` without disturbing the existing Capability generation/lease architecture.

**Architecture:** Keep the current private Host, Control Plane and unified Tool Invocation path. Simplify Capability lifecycle inputs to ambient discovery, split global and project setting stores by scope, and make permission decisions from structured action/resource facts plus global rules.

**Tech Stack:** TypeScript, Node.js 22, AJV/JSON schema for project settings, a maintained TOML parser for global configuration, Vitest, SQLite event upcasters.

---

## Phase 1: Documentation contract

1. Update `docs/product/overview.md` and `docs/product/roadmap.md` to state the confirmed product definition and reorder milestones.
2. Update terminal, architecture and code-map documentation; remove project model/module configuration examples and old access modes.
3. Add the approved design spec and this plan.
4. Scan docs for contradictory Capability configuration UI, project model secrets, database-first delivery, old modes and premature local-release promises. Resolve only references in scope.

**Checkpoint:** No runtime code changes before this phase is reviewed as one coherent boundary.

## Phase 2: Capability configuration deletion

**Primary files:**

- `packages/core-agent/src/capability-types.ts`
- `packages/core-agent/src/capability-control-plane.ts`
- `packages/core-agent/src/index.ts`
- `packages/agent-host/src/project-settings.ts`
- `packages/agent-host/src/schemanaut-settings.schema.json`
- `packages/agent-host/src/agent-runtime.ts`
- Capability and Host tests/fixtures that construct configuration values

**Work:**

1. Delete configuration declarations/values/revisions from Capability public types and snapshots.
2. Change `activate` / `refresh` to receive lifecycle context only.
3. Remove module schema registration and module payload extraction from project settings and Host startup/reload.
4. Make discovery retry a failed/unavailable module by performing a fresh probe; do not key eligibility to a removed settings revision.
5. Preserve immutable generations, atomic contribution publication, old-generation fallback, leases, draining and rollback exactly as lifecycle invariants.
6. Update database and fixture modules to the simplified API.

## Phase 3: Settings scope split

**Primary files:**

- `packages/agent-host/src/project-settings.ts`
- `packages/agent-host/src/schemanaut-settings.schema.json`
- new global configuration store under `packages/agent-host/src/`
- `packages/agent-host/src/agent-runtime.ts`
- `packages/agent-host/src/types.ts`
- `packages/agent-host/src/index.ts`
- terminal runtime construction, settings commands and tests

**Work:**

1. Reduce project settings to project-scoped MCP declarations; reject `llm` and `modules` with actionable diagnostics.
2. Add a single global path resolver for `~/.schemanaut/config.toml`; do not search project directories and do not support project override.
3. Parse/version/validate model connections, generation defaults, default permission mode and policy rules. Use atomic snapshots and safe summaries.
4. Resolve model API keys from environment-variable references; never accept or display plaintext key fields.
5. Build the LLM connection manager from the global snapshot while keeping selected connection/model binding in Session.
6. Keep terminal scope explicit: `/config` describes/validates the redacted global file, while `/settings`
   describes/validates project MCP settings without exposing resolved secrets.

## Phase 4: Permission model replacement

**Primary files:**

- `packages/core-agent/src/types.ts`
- `packages/core-agent/src/permission-manager.ts`
- `packages/core-agent/src/tool-registry.ts`
- `packages/core-agent/src/tools/tool-invocation-runtime.ts`
- event, journal, kernel, session and projection types that persist the mode
- built-in Tool descriptors/adapters in `packages/core-tools`
- Host and terminal mode types, parser/help/activity output

**Work:**

1. Replace Agent mode types with `default | auto | full-access`; remove rank-based required permissions.
2. Define structured permission facts for action class and resolved resources (workspace/external path, network host, credentials/admin/destructive intent).
3. Give built-in, MCP and Capability Tool registrations conservative facts; use runtime argument resolvers where path/host depends on arguments.
4. Implement built-in decisions for the three modes, then apply matching global rules with `deny > ask > allow` precedence.
5. Ensure full access removes only built-in prompts; explicit enterprise `ask/deny`, validation, audit and outcome-unknown recovery remain active.
6. Update durable event/upcast boundaries so historical runs can be read while all new writes use new mode names.
7. Update terminal `/mode` and approvals.

## Phase 5: Database permission decoupling

1. Locate database SQL authorization contracts that use `read/edit/full`.
2. Rename them to database-specific access/action categories without reusing Agent mode types.
3. Map database classifications into the unified Tool permission facts at the Tool boundary.
4. Confirm the database Capability remains optional and has no special settings path or Control Plane UI.

## Phase 6: Unified verification and architecture review

1. Update affected tests and fixtures after functional code stabilizes.
2. Run focused Capability, Agent Host, terminal, Tool permission and database suites.
3. Run terminal build, repository typecheck, lint and full test suite; run external/live tests only when their declared credentials/services exist.
4. Scan source and active docs for removed `settings.modules`, project `llm`, Capability configuration types, old Agent modes and project/global policy overrides.
5. Review architecture invariants: one Invocation authority, one global policy source, no Capability config surface, no Control Plane user surface, preserved generation/lease behavior, no plaintext model secret.
6. Fix every in-scope discrepancy and repeat the relevant verification before declaring completion.
