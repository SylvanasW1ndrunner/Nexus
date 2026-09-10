# Capabilities guide

The first-party capabilities below are in development for this round. They are
task-specific enhancements, not SchemaNaut configuration modules.

| Capability | Typical external condition |
| --- | --- |
| Git | A git executable and a Git worktree when needed. |
| Database | Database connection information managed outside SchemaNaut. |
| Forge | A gh or glab command-line client and its external login state. |
| Containers | A docker or podman command-line client and service when needed. |
| Browser Automation | BrowserSession Host Port/browser connector shares an existing browser login state without Agent Cookie/API Header/Authorization parameters. The CLI has no embedded Chromium; external Playwright is only an unauthenticated screenshot/test backend or user-maintained test configuration. |
| Language Intelligence | Relevant language tools such as tsc, pyright, ruff, cargo, go, or ctags. |
| Documents | pandoc, pdftotext, or pdfinfo for the requested operation. |
| Data & Notebook | Readable data files; Jupyter is needed to run a notebook. |

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
references. Cookie and Set-Cookie never enter Agent-facing schemas, prepared intents,
results, or the Journal; Cookie, API Header, and Authorization are not Agent
parameters. It does not scan or redact page bodies, external command output, or
user browser-test code output. Base web_fetch is stateless; web_search API
credentials remain HTTPS-only.

Repair missing external conditions with their normal external workflow, then
retry or rediscover the task. A changed parent PATH or environment requires a
terminal Host restart.
