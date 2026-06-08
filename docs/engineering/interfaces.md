# Interfaces

## IPC Boundary

Renderer code must call main-process capabilities through the typed IPC map in
`packages/shared/src/ipc.ts`.

Current M1 channels:

- `connection:list`
- `connection:test`
- `connection:create`
- `connection:update`
- `connection:remove`
- `connection:connect`
- `connection:disconnect`
- `db:execute-query`
- `db:query-history`
- `db:explain-query`
- `db:list-tables`
- `auth:login`
- `auth:logout`
- `auth:status`
- `usage:current-quota`
- `usage:history`
- `app:load-workspace-state`
- `app:save-workspace-state`

All responses use `Result<T>` from `packages/shared/src/result.ts` so UI code handles operational
failures explicitly instead of catching untyped exceptions.

## Database Driver Boundary

`IDatabaseDriver` is the stable boundary for M1. PostgreSQL is the only implemented engine, but
the interface is deliberately engine-neutral:

- `test(config)` checks reachability.
- `connect(config)` creates or restores an active pool.
- `disconnect(connectionId)` shuts down resources.
- `execute(request, connection)` runs SQL and returns rows, fields, elapsed time, and safety data.
- `listTables(connectionId)` provides the initial Schema tree substrate for M1.5 and M2.

## Workspace State

M1.5 persists the active connection id and SQL editor draft through `app:*workspace-state` IPC
channels. The state file lives under Electron `userData/data/workspace-state.json` and is written
atomically through a temporary file plus rename.

This is intentionally small: it restores the daily SQL editing path without introducing a heavier
workspace database before sessions, tabs, and Agent checkpoints exist.

## Result Export

`queryResultToCsv(result)` in `packages/shared/src/csv.ts` converts query results into RFC-friendly
CSV for spreadsheet import. It preserves the returned column order and escapes commas, quotes,
newlines, JSON values, and `NULL` values.

## SQL Safety

`analyzeSqlSafety(sql, { readOnly })` classifies statements before execution.

- Read-only connections allow `SELECT`, `WITH`, `SHOW`, `EXPLAIN`, and `VALUES`.
- Read-only connections block `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CALL`, and DDL.
- Write and DDL statements require confirmation when the connection is not read-only.
- Multiple statements require review because they increase blast radius.

This safety report is stored with query history and returned to the renderer.

## Credential Handling

Connection metadata is stored separately from passwords. The desktop main process persists passwords
in an encrypted local credential file using Electron `safeStorage` when available. Renderer code
never receives stored passwords after creation, and deleting a connection also deletes its stored
credential.

This is an M1 implementation step. Before public release, this boundary should move behind an OS
keychain adapter so Windows Credential Manager, macOS Keychain, and Linux secret storage can be
tested independently from IPC and UI code.
