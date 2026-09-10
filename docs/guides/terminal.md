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

The built-in HTTP/browser bridge is narrowly isolated from Cookie values: Cookie
and Set-Cookie are absent from Agent-facing schemas, prepared intents, results,
and the Journal. It does not inspect page bodies, external command output, or
user browser-test code output. This CLI has no embedded Chromium; browser work
uses an externally prepared browser/Playwright environment and login state, with
no Cookie parameter.
