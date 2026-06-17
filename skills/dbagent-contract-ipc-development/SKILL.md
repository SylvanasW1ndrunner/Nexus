---
name: dbagent-contract-ipc-development
description: Use when designing or changing DBAgent/Nexus typed public contracts, shared TypeScript types, Electron IPC channels, preload APIs, main-process service adapters, or backend interfaces that the future UI and Agent tools will consume.
---

# DBAgent Contract And IPC Development

Use this skill whenever a backend capability needs a stable boundary for renderer UI, Agent tools, tests, or future plugin integration.

## Required Reading

- `docs/product/04-config-design.md` §9 for IPC communication contracts.
- `docs/product/05-development-guide.md` for package boundaries and typing rules.
- The feature-specific product document.
- Existing contracts in `packages/shared/src/` and `apps/desktop/src/preload/`.

## Contract Design Flow

1. Identify the caller: renderer, Agent tool, CLI/test harness, plugin, or another core package.
2. Define domain types in a shared or owning core package before adding IPC.
3. Add IPC only when a desktop process boundary is actually required.
4. Keep channels action-oriented and stable, for example `connection:test` or `rag:search`.
5. Return structured results with error codes; do not throw raw implementation errors across boundaries.
6. Add contract tests or compile-time usage tests where feasible.

## Boundary Rules

- Renderer must not receive secrets, database passwords, raw API keys, or unrestricted filesystem paths.
- Preload exposes a narrow typed API, not generic `ipcRenderer.invoke`.
- Main process validates input again even if renderer validation exists.
- IPC request and response types must survive future UI rebuilds.
- Long-running operations need progress events, cancellation IDs, and timeout behavior.

## Naming Rules

- IPC channel: `domain:verb` or `domain:verb-object`.
- Request type: `DomainVerbRequest`.
- Response type: `DomainVerbResponse` or `Result<T, AppErrorLike>`.
- Stream event: `domain:event`.

## Tests

- Typecheck all packages touched by shared types.
- Test main-process handler validation with invalid requests.
- Test cancellation/progress where a channel starts long-running work.
- Test that sensitive fields are redacted before crossing into renderer-visible contracts.

## Documentation

Update Chinese engineering docs with:

- Channel or interface name.
- Request/response shape.
- Error codes.
- Security boundary.
- Example user workflow that exercises the contract.
