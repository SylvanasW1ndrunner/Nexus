---
name: dbagent-auth-config-usage-development
description: Use when implementing DBAgent/Nexus authentication, local PostgreSQL-backed user storage, login/register/password reset flows, verification-code abstractions, settings, connection configs, secret storage, LLM provider config, subscription skeleton, or usage tracking.
---

# DBAgent Auth, Config, Usage Development

Use this skill for account, configuration, secrets, provider, and usage modules. During the current development mode, implement service contracts and tests first; final renderer UI is deferred.

## Required Product Docs

- `docs/product/04-config-design.md`
- `docs/product/10-usage-and-subscription.md`
- `docs/product/05-development-guide.md`
- `docs/product/09-error-recovery.md`

## Current Product Rules

- Authentication UI is deferred, but backend auth must be real and testable.
- Local user data currently uses PostgreSQL because the future cloud service will also use PostgreSQL.
- Test account must exist or be seedable with username/password `test` / `test` for local validation.
- Store passwords as hashes, never plaintext.
- Support account-password login and verification-code login/reset at the service-contract level.
- Email/SMS verification may use a local/dev provider until cloud services exist, but the provider boundary must be explicit.
- Login/register/reset flows must be callable without the final UI through service tests or IPC tests.

## Configuration Boundaries

- User settings: editor/IDE preferences, theme, font, telemetry/privacy, provider defaults.
- Connection settings: DB type, host, port, database, SSL/SSH, timeouts, pool, read-only mode, RAG flags.
- Session settings: selected connection, permission mode, active workspace, temporary agent state.
- Secrets: keep out of plain JSON; use keychain or an explicit dev-only fallback with clear warnings in docs.

## Usage Tracking

- Track one agent round as: user input -> final agent response, including tool calls and subagents.
- BYOK mode must not require login or subscription locks.
- Subscription-managed mode must route through auth and later gateway contracts.
- Local usage records should be append-only and queryable for diagnostics.

## Testing Requirements

- Register/login/logout/status.
- Password hash verification and failed login lockout/rate-limit logic where implemented.
- Verification-code issue/expire/retry/reset-password flows.
- Settings read/write migration and corrupted config recovery.
- Usage round creation, completion, failure, and offline persistence.
- Local PostgreSQL auth schema migrations and seed behavior.
