# Diagnostics and sandbox guide

## Global permission modes

Permission is selected globally in ~/.schemanaut/config.toml. A project, Skill,
MCP server, or Capability cannot grant itself more access.

| Mode | Expected behavior |
| --- | --- |
| default | Ordinary workspace work can proceed; external writes, network access, and risky actions ask for approval. |
| auto | Actions proceed unless they are dangerous, destructive, credential-related, administrative, unknown-risk, or restricted by organization policy. |
| full-access | Built-in per-action approval can be removed, but target validation, organization rules, cancellation, recovery, and action records still apply. |

Organization rules can deny or require approval regardless of the selected
mode. Read the action summary before deciding.

## What sandboxing means

Sandboxing is an execution property, not a label. SchemaNaut reports the
isolation the current Host can actually provide for the requested action.

- If isolation is not available but the applicable policy permits a user
  decision, the result is ask-unsandboxed.
- If policy requires isolation that the Host cannot provide, the result is
  unavailable.
- On native Windows without a strong operating-system sandbox, a completed
  command can report its own exit result, but containment and complete process
  tree termination remain unverified. After cancellation or termination, any
  descendant process that cannot be proven stopped remains unknown.

This version does not claim a Windows Job Object containment guarantee. Treat
container daemons, browser runners, notebook execution, and other external
services as their own security boundaries even when an outer command is
restricted.

## Repair, retry, and restart

Diagnostics identify a missing prerequisite and its safe external repair path.
Fix the command, file, connection, service, secure reference, or login state
outside SchemaNaut, then ask the Agent to retry or rediscover it. Changes to
the parent process PATH or environment require restarting the terminal Host so
the new state can be inherited.

## Redaction

Diagnostic text, command output, and reports are bounded and redacted before
they are shown or retained. SchemaNaut does not intentionally reveal secrets,
authorization headers, passwords, URL user information, complete connection
strings, or raw provider error bodies. If you believe a secret was exposed,
stop using it, rotate it through its external provider, and review the affected
local project data.
