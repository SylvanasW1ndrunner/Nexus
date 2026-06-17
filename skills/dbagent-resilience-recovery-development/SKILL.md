---
name: dbagent-resilience-recovery-development
description: Use when implementing DBAgent/Nexus resilience, autosave, crash recovery, checkpoints, cancellation, retries, diagnostics, atomic persistence, SQLite WAL, database reconnect, LLM stream recovery, MCP health recovery, Python process failure handling, or user-data loss prevention from docs/product/09-error-recovery.md.
---

# DBAgent Resilience And Recovery Development

Use this skill for any work where failure behavior matters. The product standard is: no user work is silently lost, long tasks are recoverable, and external dependency failures degrade instead of crashing the app.

## Required Product Docs

- `docs/product/09-error-recovery.md`
- `docs/product/03-agent-design.md` for Agent checkpoints, abort, tool failure, and stream behavior.
- `docs/product/06-classic-features.md` for SQL/table undo and transaction protection.
- `docs/product/08-workspace-design.md` for workspace and Python process recovery.
- `docs/product/04-config-design.md` for config persistence, backups, keychain, and IPC.
- `docs/product/05-development-guide.md` for testing and package boundaries.

## Failure Model

Classify every failure explicitly:

- Retryable transient: network jitter, 429, temporary DB disconnect.
- Degradable: LLM unavailable, MCP unavailable, embedding unavailable.
- User-fixable: bad credentials, SQL syntax error, missing Python env.
- Integrity risk: failed write, failed commit, corrupted config, partial export.
- Crash/restart: renderer crash, main process exception, abnormal previous shutdown.
- Non-recoverable external state: disk full, OS permission denial.

Do not catch and hide errors. Convert them to typed errors with machine-readable codes and Chinese user-facing messages where surfaced.

## Persistence Rules

- Use atomic writes for JSON/config/autosave files.
- Version persisted state and provide migration or safe legacy quarantine.
- Use SQLite WAL where concurrent reads/writes and crash recovery matter.
- Persist Agent/session checkpoints at each iteration boundary and after each tool result.
- Persist stream chunks incrementally so partial LLM output can be recovered or marked incomplete.
- Flush autosave queues before quit when possible.

## Recovery Workflows

Implement service-level workflows before UI:

- Startup recovery scan: last session state, autosave files, running Agent sessions, corrupted config backups.
- SQL/Python autosave: debounce writes and explicit flush.
- Agent resume: continue, restart, or abandon from persisted checkpoints.
- Abort/cancel: propagate `AbortSignal` through LLM, DB, MCP, shell, and Python operations.
- DB reconnect: distinguish user disconnect from abnormal network disconnect; preserve tab/session state.
- Long SQL cancellation: use PostgreSQL cancel path when possible; fall back to connection teardown.
- Diagnostics: collect logs, versions, config metadata, and crash snapshots with redaction.

## External Dependency Resilience

- LLM: retry with backoff only for retryable errors; never retry bad auth or bad request; persist partial streams.
- MCP: isolate server processes, health check, timeout tool calls, restart with cap, and report failure back to Agent.
- Python: isolate child processes, stream stdout/stderr with limits, enforce timeout/cancel, return stderr tail for repair.
- Files: report disk-full/permission failures without corrupting existing state.

## Testing Requirements

- Unit test error classification, retry decisions, atomic write fallback, migration behavior, and redaction.
- Integration test autosave/recovery with temp directories and simulated process interruption where feasible.
- Test Agent checkpoint resume with fake providers and deterministic tools.
- Test DB reconnect/cancel against real PostgreSQL when available.
- Test MCP/Python timeout and failed process isolation with real child processes.
- Add negative tests for corrupted JSON, missing directories, permission-like write failures, and partially written files.

## Done Criteria

- The failure path has an explicit persisted state, recovery choice, or safe discard policy.
- Logs are useful for debugging and contain no secrets.
- Tests prove both normal and failed paths.
- Chinese docs describe recovery state files, lifecycle transitions, and known non-recoverable cases.
