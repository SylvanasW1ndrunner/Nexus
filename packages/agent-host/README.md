# Private Agent Host

`@dbagent/agent-host` is a private workspace composition layer for
`apps/terminal`. It assembles project settings, global model connections, the durable
Agent runtime, Skills, MCP lifecycle, internal Capabilities, and local state.
It is not an SDK and does not promise a stable import path, public types, or
embedding compatibility.

The supported user product is the `schemanaut` terminal. Local release packages
may contain compiled host code as an implementation detail, but only the CLI is
an exposed entry point. Do not add `exports`, document host imports for users,
or reintroduce HTTP, Server, WebUI, or SDK adapters without a separately
approved product boundary.

## Maintainer boundary

- Compose Runtime behavior here; keep terminal presentation and parsing in
  `apps/terminal`.
- Keep Capability registration and lifecycle private. Capabilities do not own
  project or in-program configuration; they probe externally managed
  prerequisites and return bounded actionable failures to the Agent.
- Preserve the single Run/Journal/Tool invocation path for models, Skills,
  MCP, project tools, and Capability tools.
- The bundled database Capability is internal and is not terminal-operable:
  there is no current terminal database configuration, connection, or analysis
  command.
- Do not expose raw registries, module instances, credentials, or internal
  state through user-facing status, errors, or documentation.

Architecture readers should start with [the documentation index](../../docs/README.md)
and the four architecture documents there; contributors should treat package
tests as the behavioral source of truth for internal contracts.
