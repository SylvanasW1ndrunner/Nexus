---
name: dbagent-backend-slice-execution
description: Use when executing a DBAgent/Nexus backend-first feature slice from docs/product while frontend UI is deferred, including choosing scope, implementing core services, updating Chinese docs, writing tests, and committing a small shippable increment.
---

# DBAgent Backend Slice Execution

Use this skill when turning product docs into one concrete backend capability. This is the default execution mode until the final UI rebuild starts.

## Required Reading

Read only the documents needed for the slice:

- Roadmap and milestones: `docs/product/00-overview.md`, `docs/product/05-development-guide.md`
- Product principles: `docs/product/07-design-principles.md`
- Module-specific docs: `docs/product/02-rag-design.md`, `03-agent-design.md`, `04-config-design.md`, `06-classic-features.md`, `08-workspace-design.md`, `09-error-recovery.md`, or `10-usage-and-subscription.md`
- Existing engineering docs under `docs/engineering/`

## Execution Rules

1. Start with `git status --short --branch`.
2. Define one user-facing backend workflow, not a broad platform rewrite.
3. Implement in `packages/core-*`, `apps/desktop/src/main`, `apps/desktop/src/preload`, or shared contracts as appropriate.
4. Do not rebuild renderer UI. The renderer remains a minimal host unless the user explicitly reopens UI development.
5. Keep all new docs in Chinese.
6. Prefer existing package patterns and small typed public contracts.
7. Record dependency, packaging, and offline implications before adding libraries.

## Slice Boundary

Before coding, identify:

- 用户场景: the concrete workflow now supported.
- 所属模块: the package or service that owns it.
- 对外合同: exported types, service methods, IPC channels, CLI/test entry points.
- 安全边界: credentials, SQL writes, workspace paths, subprocesses, network, LLM calls.
- 验收方式: deterministic tests plus gated real dependency tests where needed.

## Implementation Standard

- Core packages must not depend on Electron.
- Main-process services should be thin adapters around core package behavior.
- IPC changes must be typed through shared contracts and preload APIs.
- Persistence must use atomic writes or transactional storage where data loss matters.
- Errors must carry stable codes and Chinese user-facing messages at the boundary.

## Done Criteria

- Code is implemented and exported from the owning module.
- Tests cover success, invalid input, permission denial, timeout/cancel, persistence/recovery when relevant.
- Chinese docs explain API contract, module logic, tests, and known limits.
- Targeted typecheck/tests pass.
- Commit is small and does not mention AI/Codex authorship.
