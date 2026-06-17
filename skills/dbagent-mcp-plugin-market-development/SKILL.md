---
name: dbagent-mcp-plugin-market-development
description: Use when implementing DBAgent/Nexus MCP client support, MCP process management, MCP tool adaptation, Smithery or other MCP market integration, plugin-like extension points, official built-in tools or skills as plugins, permission manifests, extension registries, sandbox boundaries, or marketplace tests from docs/product/03-agent-design.md and docs/product/04-config-design.md.
---

# DBAgent MCP, Plugin, And Market Development

Use this skill for extension work: MCP servers, market installation, plugin-like contracts, official extensions, and third-party extension boundaries.

## Required Product Docs

- `docs/product/03-agent-design.md` for Tool Registry, Skill Registry, MCP integration, and Agent permissions.
- `docs/product/04-config-design.md` for `mcp.json`, market abstraction, secrets, and IPC.
- `docs/product/09-error-recovery.md` for MCP health, timeout, restart, and isolation.
- `docs/product/05-development-guide.md` for dependency and testing policy.
- `docs/product/08-workspace-design.md` when workspace scripts become Agent tools.

## Architecture Rules

- Treat built-in tools, user MCP tools, market MCP tools, workspace script tools, and future plugins as sources feeding a single typed Tool Registry.
- Keep source-specific code behind adapters. Agent runtime should receive normalized tool definitions, permission metadata, schemas, and execution functions.
- Store MCP config as non-secret JSON plus keychain refs for secrets.
- Do not expose raw secrets to renderer, logs, tool output, or Agent context.
- Keep plugin/MCP failures isolated from the app and from unrelated tools.

## MCP Requirements

- Support stdio first, with explicit model for SSE/HTTP where contracts already exist.
- Manage process lifecycle: install config, start, stop, restart, health state, autoStart, disabled state.
- Enforce timeout, memory/CPU guardrails where feasible, and output limits.
- Convert MCP tool schemas into internal tool schemas without losing required fields.
- Register and unregister tools dynamically as servers start/stop.
- Return structured unavailable/timeout errors to Agent so it can replan.

## Market Requirements

- Implement market abstraction before hard-coding Smithery.
- Market entries need id, name, description, publisher, category, rating/downloads if available, required env vars, and install config.
- Installation flow must produce a safe `McpServerConfig`, write secrets to keychain, persist config atomically, start server, and verify `list_tools`.
- Support uninstall/disable without deleting unrelated secrets unless explicitly requested.

## Plugin-Like Extension Points

When defining extension APIs, include:

- Stable id/name/version/source.
- Permission manifest and danger level.
- Tool schema and result schema.
- Lifecycle hooks if needed: install, enable, disable, health, uninstall.
- Audit metadata: who/what invoked the tool, duration, status, and sanitized error.

Official extensions should use the same public contracts as future third-party extensions. Do not special-case official tools except for trusted packaging source.

## Testing Requirements

- Unit test config parsing, keychain ref handling, schema conversion, permission mapping, and registry add/remove.
- Integration test stdio MCP with a small local fixture server when possible.
- Test failed start, crash after start, timeout, disabled server, malformed tool schema, missing env var, and uninstall.
- Test Agent enforcement: tools not enabled or not allowed by a Skill must not be exposed and must be denied if invoked.
- Market tests should use fixtures unless an explicit network-gated test is requested.

## Done Criteria

- A non-UI caller can install/configure/start an MCP server, list normalized tools, invoke a tool through Tool Registry, stop it, and inspect health.
- Permission and audit paths are covered.
- Chinese docs describe config format, lifecycle, security boundaries, test fixtures, and known limits.
