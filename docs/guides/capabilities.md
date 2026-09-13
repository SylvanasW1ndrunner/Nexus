# Capabilities guide

The first-party capabilities below are built into the bundled Agent Host. They are
task-specific enhancements, not SchemaNaut configuration modules.

The first turn contains only base Tools and the Capability catalog. After
`tool_search` finds and activates a Capability, its complete Tool set is loaded
directly on the next turn; each Tool does not need a second activation. When an
external condition is missing, the Agent reports the preparation required
outside SchemaNaut and can rediscover it after that condition changes.

The base surface is a fixed set of 14 Tools: `ask_user`, `tool_search`,
`result_read`, `result_materialize`, `result_save`, `skill`, `workspace_list`,
`workspace_read`, `workspace_search`, `workspace_apply_patch`, `process_exec`,
`process_control`, `web_search`, and `web_fetch`. Searching can show matching
Capabilities without loading them; selecting a match performs the lazy external
probe and schedules the complete Capability toolset for the next model turn.

One module may use several catalog names to describe different jobs, such as
database querying and Schema lookup. Selecting those names still loads one
module instance; repeated selections are treated as already active, so users do
not need to understand or repair internal bindings.

| Capability | Typical external condition |
| --- | --- |
| Git | A git executable and a Git worktree when needed. |
| Database | `DATABASE_URL` or supported `PG*` connection state managed outside SchemaNaut. |
| Forge | A gh or glab command-line client and its external login state. |
| Containers | A docker or podman command-line client and service when needed. |
| Browser Automation | BrowserSession Host Port/browser connector shares an existing browser login state without Agent Cookie/API Header/Authorization parameters. The CLI has no embedded Chromium; external Playwright is only an unauthenticated screenshot/test backend or user-maintained test configuration. |
| Language Intelligence | Relevant language tools such as tsc, pyright, ruff, cargo, go, or ctags. |
| Documents | pandoc, pdftotext, or pdfinfo for the requested operation. |
| Data & Notebook | Readable data files; Jupyter is needed to run a notebook. |

The Database Capability can support more than a single SQL query. The Agent can use SQL to build a
compact dataset, then combine the always-loaded result-reading, workspace, and process tools to write
and run a Python analysis. This does not add Python or database configuration inside SchemaNaut: the
database connection and Python runtime remain externally prepared. When a Python package is missing,
the Agent should prefer the standard library or report the missing prerequisite instead of treating
package management as Capability configuration.

## Prepare a browser automation session

Browser Automation v1 uses a local CDP connection, not a Claude browser
extension. Before using it, prepare the browser outside SchemaNaut:

1. Start Chrome or Edge with remote debugging enabled on local port `9222` and
   a dedicated browser profile. Recent Chrome versions can require a
   non-default user-data directory for remote debugging, so use a separate
   profile directory rather than your normal default profile.
2. In that profile, sign in to the sites you want to use, then leave the
   browser running.
3. Retry the browser task. SchemaNaut connects only to
   `http://127.0.0.1:9222` and uses that profile's existing sign-in state.

The connector always opens a dedicated `about:blank` tab for its work. It does
not attach to or take over your existing tabs, and it cannot automatically
attach to an ordinary Chrome or Edge session that was not started with remote
debugging. A future extension or native bridge may replace this local CDP
setup without changing the Agent-facing browser-session/page contract.

## Authorization and responsibility

Each Tool statically declares its operation facts, such as workspace write,
network, external write, destructive, or high risk. SchemaNaut does not scan a
user request, command argument, output, or third-party response for Secrets or
credentials, and it does not decide whether the external tool is trustworthy.
The global default, auto, and full-access modes plus organization rules decide
authorization.

External command output and provider errors may enter Agent results and local
retention with general size and lifecycle limits. You are responsible for the
sensitivity of your input, external configuration, model endpoint, local logs,
Journal, Artifacts, and third-party output. Do not commit real credentials to
Git.

The BrowserSession Host Port/browser connector has one narrow API isolation. Under
its product contract, the Agent receives only opaque browser session/page
references. Browser protocol and session Cookie/Set-Cookie fields and values never enter Agent-facing schemas, prepared intents,
results, or the Journal; Cookie, API Header, and Authorization are not Agent
parameters. It does not scan or redact page bodies, external command output, or
user browser-test code output. Navigation validates only that a URL is HTTP(S);
it does not add a separate content policy for URL userinfo.

Repair missing external conditions with their normal external workflow, then
retry or rediscover the task. A changed parent PATH or environment requires a
terminal Host restart.
