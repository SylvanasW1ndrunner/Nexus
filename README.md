# DBAgent

DBAgent is an agent-native database IDE for data engineers. It starts as a local-first
Electron desktop app for PostgreSQL, then grows into Schema RAG, agent execution, MCP tools,
skills, and workspace-based Python artifacts.

## Repository Layout

- `apps/desktop` - Electron + React desktop client.
- `packages/shared` - shared domain types, result model, and IPC contracts.
- `packages/core-db` - database driver abstraction, PostgreSQL driver, SQL safety, connection and query history stores.
- `packages/core-auth` - local auth/session skeleton for subscription integration.
- `packages/core-usage` - usage tracking skeleton shared by BYOK and subscription modes.
- `packages/core-llm` - LLM routing boundary for BYOK and future gateway modes.
- `docs/product` - original product and architecture design documents.
- `docs/engineering` - implementation-facing interface, testing, packaging, and operations docs.

## Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm --filter @dbagent/desktop package
```

The current workstation must have Node.js and pnpm installed or available through Corepack.
The desktop package is designed so development and test-only dependencies stay outside the final
Electron application bundle.
