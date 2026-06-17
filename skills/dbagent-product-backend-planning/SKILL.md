---
name: dbagent-product-backend-planning
description: Use when planning DBAgent/Nexus backend-only development from docs/product, slicing milestones, choosing module order, defining acceptance criteria, or deciding what to build next while frontend UI is deferred.
---

# DBAgent Product Backend Planning

Use this skill to turn product documents into backend development slices. Do not plan renderer UI work unless the user explicitly reopens frontend work.

## Required Product Docs

Read only the docs needed for the current slice:

- Overall roadmap: `docs/product/00-overview.md`, `docs/product/05-development-guide.md`
- Database and classic IDE capability: `docs/product/06-classic-features.md`
- Schema RAG: `docs/product/02-rag-design.md`
- Agent, tools, skills, MCP: `docs/product/03-agent-design.md`
- Config, providers, secrets, IPC: `docs/product/04-config-design.md`
- Workspace and Python: `docs/product/08-workspace-design.md`
- Resilience: `docs/product/09-error-recovery.md`
- Auth, usage, subscription: `docs/product/10-usage-and-subscription.md`

## Current Development Mode

- Build all non-UI product capabilities first.
- Preserve Electron main, preload, IPC contracts, shared types, core packages, service tests, and pure renderer utility functions.
- Treat renderer UI as a blank host until frontend reconstruction resumes.
- Keep docs in Chinese during this phase.

## Slice Rules

For every slice, define:

1. Product scenario: the concrete user workflow the backend now supports.
2. Module boundary: which package owns the behavior.
3. Public contract: exported TS types, service methods, IPC contracts, or CLI/test fixture entry points.
4. Safety boundary: credentials, workspace paths, SQL writes, process execution, or network behavior.
5. Tests: deterministic unit tests plus real integration tests behind explicit env gates when external systems are required.
6. Docs: update module docs, API docs, and release notes in Chinese.

Prefer thin vertical backend slices over broad scaffolding. A slice is not done until it can be exercised without the final UI.

## Priority Order

1. Core DB and SQL execution: connection lifecycle, SQL parsing/audit, transaction rollback, result streaming, history.
2. Schema RAG: extractor, progressive index, retriever, context builder, disconnect cleanup.
3. LLM and Agent runtime: provider router, ReAct loop, tools, permission policy, usage tracking.
4. Workspace and Python: workspace store, script execution, environment detection, terminal process service.
5. Auth/config/usage: local PostgreSQL-backed account storage, provider config, secrets boundary, quota skeleton.
6. MCP/plugin/skill extension: registry, tool adapters, market skeleton, official built-in skills.
7. Release hardening: diagnostics, packaging smoke tests, release folder, version branch discipline.

## Decision Rules

- Prefer existing packages and established local patterns.
- Prefer mature open-source libraries for commodity capability, but record license, packaging impact, offline behavior, Windows/Linux compatibility, and fallback.
- Do not introduce a dependency if a small local implementation is safer and clearer.
- Do not expose secrets to renderer or logs.
- Do not rely on mocks for final confidence when PostgreSQL, process IO, LLM providers, or packaging behavior is the risk.

## Completion Checklist

- Code is implemented in the owning package with typed public contracts.
- Tests cover success, failure, timeout/cancel, malformed input, permission denial, and persistence/recovery where relevant.
- Real PostgreSQL or real process tests exist for features that depend on those systems.
- Chinese docs explain module logic, API contract, test method, and known limits.
- Typecheck and targeted tests pass before commit.
