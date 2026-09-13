# Diagnostics and sandbox guide

## Authorization modes

Authorization comes only from the global ~/.schemanaut/config.toml mode and
organization rules.

| Mode | Behavior |
| --- | --- |
| default | Internet access and edits outside the workspace need approval. |
| auto | Only statically declared high-risk actions and organization rules need approval. |
| full-access | Actions are not automatically blocked for approval. |

A project, Skill, MCP server, or Capability cannot raise this authority.

## Sandbox execution rules

If require_sandbox is configured, it is a global organization execution rule.
It is not a promise to identify sensitive content or make a third-party tool
safe. When an execution Host cannot provide a required sandbox, it reports
unavailable; when policy permits an unsandboxed user decision, it reports
ask-unsandboxed.

On native Windows without strong operating-system isolation, an approved root
command's natural exit can report its command exit result, but containment and
complete process-tree proof are unverified. During cancellation or termination,
descendants whose stop cannot be proved are unknown.

## External state and output

Fix missing commands, files, services, or login state outside SchemaNaut, then
retry. Restart the terminal Host after a parent PATH or environment change.

SchemaNaut does not redact diagnostics, command output, provider errors, or
retained results. They may enter Agent results, logs, Journal, and Artifacts
with general size and lifecycle limits. Users decide whether those inputs and
outputs are sensitive. Keep real credentials out of Git as repository hygiene.

The BrowserSession Host Port/browser connector reuses the user's existing
browser session signed in outside SchemaNaut. It is the narrow exception to
Agent-facing API content: under its product contract, the Agent receives only opaque
browser session/page references; schemas accept no Cookie, API Header, or Authorization,
and browser protocol/session Cookie/Set-Cookie fields and values are omitted from prepared intents, results, and the
Journal. This does not inspect or redact page bodies, external command output,
or user browser-test code output. The CLI has no embedded Chromium. External
Playwright is only an unauthenticated screenshot/test backend or user-maintained
test configuration, not a shared-login-state guarantee.
