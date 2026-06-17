---
name: dbagent-config-provider-secrets-development
description: Use when implementing DBAgent/Nexus settings, connection configuration, LLM provider configuration, provider templates, OpenAI-compatible/Anthropic/Ollama/vLLM/SiliconFlow support, secret storage, keychain references, config migration, import/export, typed IPC contracts, and configuration tests from docs/product/04-config-design.md.
---

# DBAgent Config, Providers, And Secrets Development

Use this skill when implementing configuration, provider, and secret-management code. Configuration is a core product boundary because it controls database access, LLM routing, MCP startup, Agent modes, privacy, and future subscription behavior.

## Required Product Docs

- `docs/product/04-config-design.md`
- `docs/product/10-usage-and-subscription.md` when `subscription-managed` providers, auth tokens, quota, or BYOK behavior are involved.
- `docs/product/03-agent-design.md` when config affects Agent modes, strategies, token budgets, or model routing.
- `docs/product/09-error-recovery.md` for atomic writes, backups, migration, and startup recovery.
- `docs/product/05-development-guide.md` for IPC and package layout.

## Configuration Layers

Preserve the product priority:

`Session > Connection > User > Application Default`

Implement typed models for:

- User settings: language, theme, startup, default LLM, default Agent mode, privacy, shortcuts, advanced settings.
- Connection settings: dialect, host, port, database, username, SSL, SSH tunnel, read-only, timeout, pool size, RAG scope, environment.
- Session settings: model override, Agent mode override, strategy, token budget.
- MCP settings: server definitions, transport, env/header refs, autoStart, timeout, memory limits.
- Provider settings: provider type, endpoint, model list, capabilities, retry/timeout behavior, pricing metadata.

## Secret Boundary

- Store DB passwords, SSH passphrases, LLM API keys, MCP env secrets, and auth tokens in OS keychain or the current secret abstraction.
- Store only refs in JSON/SQLite, using names like `conn:{id}:password`, `llm:{providerId}:api_key`, `mcp:{serverId}:env:{name}`.
- Never log secret values or include them in diagnostics.
- Renderer should invoke secret operations through typed IPC; it should not retain plaintext beyond the immediate user action.

## Provider Requirements

- OpenAI-compatible provider must cover DeepSeek, OpenAI, SiliconFlow, Zhipu, Moonshot, Ollama, vLLM, and custom endpoints through config.
- Anthropic provider remains a separate adapter when native protocol is required.
- `subscription-managed` provider must not require endpoint/apiKey in client config; it uses auth/JWT gateway behavior.
- Provider templates must be editable defaults, not hard-coded assumptions.
- `ping`, `listRemoteModels`, streaming, embeddings, retry, timeout, and cost estimation should have explicit contracts.

## Persistence And Migration

- All config files must be versioned.
- Writes must be atomic and keep recent backups.
- Migrations must be deterministic and tested.
- Import/export must support redacted export by default and encrypted secret export only through an explicit user-controlled path.
- Invalid config should quarantine the bad file and restore defaults or previous backup without blocking app startup.

## IPC Requirements

- Add or update shared IPC contract types before wiring handlers.
- Keep IPC handlers thin: validate request, call service, return typed result.
- Include channels for get/update/reset settings, connection CRUD/test/connect/disconnect, provider CRUD/test/detect models, MCP config, auth/account where relevant.

## Testing Requirements

- Unit test config resolution precedence, validation, default creation, migration, backup restore, and redaction.
- Test keychain abstraction with fake backend plus at least one environment-gated real keychain/manual path if feasible.
- Test provider config validation for OpenAI-compatible, Anthropic, Ollama/vLLM local endpoints, and subscription-managed.
- Test IPC contracts through typed compile checks and handler-level tests.
- Test malformed JSON, missing secret ref, disabled provider, timeout config, and fallback chain resolution.

## Done Criteria

- A non-UI caller can create settings/connections/providers, store/load secrets by ref, migrate config, and resolve effective runtime config.
- No secret values appear in logs, docs examples, test snapshots, or diagnostics.
- Chinese docs describe config schemas, storage paths, migration behavior, IPC contract, and security limits.
