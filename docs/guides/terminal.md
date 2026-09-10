# SchemaNaut terminal guide

SchemaNaut is operated through schemanaut. This guide covers the terminal
workflow; it does not describe an SDK, HTTP API, server, or web interface.

## Run from source

From a repository checkout:

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

## Start a project

    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

chat is the default command. The -C or --project option selects a project
directory; -h and --help print help. The skills command lists available Skills,
and sessions lists saved Sessions.

init creates .schemanaut/AGENT.md, .schemanaut/skills/, and artifacts/ without
overwriting existing starter files. Project settings are only for project MCP
declarations.

## Configure and select a model

Model connections, model defaults, and organization-wide permission policy
are global. Keep them in ~/.schemanaut/config.toml. A model secret must be an
environment-variable name or secure-store reference, not plaintext.

    /models
    /model 1

The selected model belongs to the current Session. /model current shows the
effective model information; /new begins an isolated Session and requires a new
selection. Project settings do not store endpoints, keys, model connections, or
Capability configuration.

## Interactive commands

After starting chat with the source command above, enter /help for the current
command summary.

| Command | What it does |
| --- | --- |
| /settings [show\|path\|validate] | View, locate, or validate project MCP settings. |
| /config [show\|path\|validate] | View, locate, or validate the redacted global configuration. |
| /models | Refresh models from global connections. |
| /model [list\|current\|number\|model-id] | List, inspect, or choose the Session model. |
| /new | Start an isolated Session with no selected model. |
| /resume <session-id> | Restore a Session and its model binding. |
| /sessions | List Sessions in the interactive view. |
| /run resume <run-id> | Continue an interrupted or limited Run. |
| /skills [list\|reload\|info] | List, reload, or inspect Markdown Skills. |
| /mcp [list\|start\|stop\|doctor] | Inspect or control configured MCP servers. |
| /doctor | Check global configuration, models, Skills, and MCP. |
| /<skill> [task] | Invoke a discovered Skill explicitly. |
| /compact | Request context compaction for the current Run. |
| /cancel | Cancel the active Run. |
| /trace on\|off | Show or hide the activity trace. |
| /exit or /quit | Close the terminal. |

An unreserved slash command is treated as a Skill invocation. While a Run is
active, ordinary text becomes a further requirement for that task.

## Sessions, approvals, and recovery

Sessions, Runs, and related state are durable under <project>/.schemanaut/.
Ctrl+C cancels active work and keeps the record. For an interrupted Run, the
terminal shows a /run resume command. The activity trace is bounded: it is not
raw model reasoning or a complete audit record.

When an action needs approval, enter y or yes to approve, n or no to deny, or
write a replacement requirement to deny and redirect the task. For an unknown
result from a non-idempotent external action, use s for success, f for failure,
or r only when you explicitly accept the risk of retrying.

## Permissions and sandboxing

The global configuration selects default, auto, or full-access. A project,
Skill, MCP server, or Capability cannot replace that policy. Organization rules
may impose a stricter decision even in full-access. Review the action summary
before approving an external write, network access, credential operation,
destructive change, or process action.

The available sandbox depends on the host and the action. If the host cannot
provide the isolation a policy requires, SchemaNaut reports that limitation
instead of claiming protection it cannot provide. See the [diagnostics and
sandbox guide](diagnostics-and-sandbox.md).

## Skills and MCP

Project guidance can be discovered from AGENTS.md or CLAUDE.md and from
.schemanaut/AGENT.md. Project Skills are Markdown files under
.schemanaut/skills/<name>/SKILL.md.

Project settings declare MCP servers in mcp.servers. A stdio server needs a
command; sse and streamable-http servers need a URL. A configured, enabled
server marked autoStart starts when the interactive terminal opens. Use /mcp
list, start, stop, and doctor to inspect or control the result.

Review MCP configuration as an external program or service. Headers and
credential-like environment values must use secure-store references; do not
place secrets in a repository, command argument, URL user information, or query
parameter. See [SECURITY.md](../../SECURITY.md).

## Optional capabilities

The first capabilities are in development for this round. Their boundary uses
external prerequisites you have already prepared, rather than another
SchemaNaut settings screen. Once a capability is bundled, ask the Agent for
help with a task, repair a reported prerequisite outside SchemaNaut, then
search or retry. The [capabilities guide](capabilities.md) lists the scope and
dependencies.
