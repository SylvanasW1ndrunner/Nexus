# SchemaNaut terminal guide

## Run from source

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

## Model and project settings

Global ~/.schemanaut/config.toml holds model connections, model defaults,
permission modes, and organization rules. Project settings only declare MCP
servers. Model selection belongs to the Session.

    /models
    /model 1

## Commands

| Command | What it does |
| --- | --- |
| /settings [show\|path\|validate] | View, locate, or validate project MCP settings. |
| /config [show\|path\|validate] | View, locate, or validate global configuration. |
| /models | Refresh models from global connections. |
| /model [list\|current\|number\|model-id] | List, inspect, or choose the Session model. |
| /new, /resume, /sessions, /run resume | Create or restore durable work. |
| /skills | Inspect or reload Markdown Skills. |
| /mcp [list\|start\|stop\|doctor] | Inspect or control configured MCP servers. |
| /doctor | Check global configuration, models, Skills, and MCP. |
| /compact, /cancel, /trace | Control the active Run. |

## Prepare a browser automation session

Browser Automation v1 uses a local CDP connection, not a Claude browser
extension. Start Chrome or Edge yourself with remote debugging enabled on
local port `9222`, using a dedicated browser profile; recent Chrome versions
can require a non-default user-data directory for remote debugging. Sign in
within that profile and leave the browser running before retrying a browser
task.

SchemaNaut connects only to `http://127.0.0.1:9222` and always opens its own
`about:blank` tab. It reuses only that profile's sign-in state, does not attach
to or take over existing tabs, and cannot automatically attach to an ordinary
browser session that was not started with remote debugging. A future extension
or native bridge can replace the local CDP setup without changing the
Agent-facing browser-session/page contract.

## Authorization and responsibility

default requires approval for internet access and edits outside the workspace.
auto requires approval only for statically declared high-risk actions and
organization rules. full-access does not automatically block actions for
approval. There is no project-level override.

SchemaNaut does not redact configuration views, command arguments, command
output, or provider errors; it does not inspect them for Secrets or decide
whether external CLIs, Skills, MCP servers, or Capabilities are trustworthy.
Those values may enter Agent results and local retention with general size and
lifecycle limits. You are responsible for their sensitivity and for keeping
real credentials out of Git.

The BrowserSession Host Port/browser connector reuses the user's existing
browser session signed in outside SchemaNaut and is narrowly isolated from Cookie
values. Under its product contract, the Agent receives only opaque browser session/page
references; Agent-facing schemas accept no Cookie, API Header, or
Authorization, and browser protocol/session Cookie/Set-Cookie fields and values are absent from prepared intents, results,
and the Journal. It does not inspect page bodies, external command output, or
user browser-test code output. This CLI has no embedded Chromium. External
Playwright is only an unauthenticated screenshot/test backend or user-maintained
test configuration, not a shared-login-state guarantee.
