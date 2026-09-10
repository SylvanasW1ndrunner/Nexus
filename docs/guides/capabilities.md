# Capabilities guide

Capabilities are optional task-specific toolsets. The first-party set below is
in development for this round; individual toolsets become usable only when they
are bundled into the terminal. They use external conditions that you already
manage, such as installed commands, files, environment variables, login state,
or an available service. They do not add a SchemaNaut project setting or an
in-app setup form.

## First-party scope

| Capability | Typical external prerequisite |
| --- | --- |
| Git | A git executable and a Git worktree for operations that need one. |
| Database | DATABASE_URL or standard PostgreSQL environment variables. |
| Forge | An authenticated gh or glab command-line client. |
| Containers | A docker or podman command-line client and, when needed, its service. |
| Browser Automation | An installed Playwright CLI and a browser environment prepared outside SchemaNaut. |
| Language Intelligence | Relevant tools such as tsc, pyright, ruff, cargo, go, or ctags. |
| Documents | The required pandoc, pdftotext, or pdfinfo utility for the requested operation. |
| Data & Notebook | Readable JSON, JSONL, CSV, or notebook files; Jupyter is needed to run a notebook. |

When bundled, the Agent discovers an appropriate capability when the task needs
it. A missing one does not prevent the general Agent, Skills, or MCP servers
from working.

## No Capability configuration in SchemaNaut

The global ~/.schemanaut/config.toml is only for model connections, model
defaults, and organization-wide permissions. Project settings are
only for project MCP declarations. Do not add a database URL, a Forge token,
container settings, browser profile, or other Capability configuration to these
files.

Manage each prerequisite with its normal external tool, file, secure reference,
environment, or login workflow. Never ask the Agent to put a secret in a
project file.

## Ask in natural language

You can tell the Agent what you want to accomplish, for example:

- Check the current Git changes and prepare a commit for review.
- Explain why the database connection is unavailable and what I should fix.
- Run the project diagnostics using the tools already installed here.
- Convert this document to PDF and save the result at this explicit path.

The Agent may use general tools or an available capability to assist with a
user-requested external step. Every action remains subject to the same global
permission policy and approval flow.

## When a dependency is missing

A useful diagnostic identifies the missing prerequisite, the capability it
affects, a safe place to repair it outside SchemaNaut, and a retry action.
Repair the external condition, then ask the Agent to search again or retry the
task. A changed command, file, login, service, or environment can be checked
again; if the parent process environment itself changed, restart the terminal
Host before retrying.

Diagnostics are bounded and redacted. They do not intentionally display tokens,
passwords, authorization headers, complete connection strings, or raw provider
responses. See the [diagnostics and sandbox guide](diagnostics-and-sandbox.md).
