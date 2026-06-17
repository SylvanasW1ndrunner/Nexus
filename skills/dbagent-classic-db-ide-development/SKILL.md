---
name: dbagent-classic-db-ide-development
description: Use when implementing DBAgent/Nexus traditional database IDE backend capabilities, including schema tree services, SQL editor contracts, result sets, table data browsing/editing, table designer operations, imports/exports, query history, result snapshots, command models, and non-AI database workflows from docs/product/06-classic-features.md.
---

# DBAgent Classic Database IDE Development

Use this skill when building the deterministic database-tooling baseline. AI is additive; these capabilities must work without Agent UI and without LLM calls.

## Required Product Docs

Read only the sections needed for the current change:

- `docs/product/06-classic-features.md` for the traditional database IDE contract.
- `docs/product/04-config-design.md` for connection settings, secrets, IPC, and per-connection behavior.
- `docs/product/09-error-recovery.md` for autosave, undo, transaction protection, cancellation, and recovery.
- `docs/product/05-development-guide.md` for package layout, dependency policy, and testing.
- `docs/product/02-rag-design.md` only when schema metadata must feed RAG.

## Development Mode

- Implement backend/service contracts first. Do not rebuild renderer UI unless the user explicitly reopens frontend work.
- Expose functionality through typed packages, IPC contracts, CLI/test entry points, or pure service APIs.
- Prefer mature libraries for SQL formatting/parsing, spreadsheet export, CSV parsing, virtualized result contracts, and file formats; record license and packaging impact when adding dependencies.
- Keep credentials out of renderer, logs, snapshots, exports, and test output.

## Capability Boundaries

- Database driver behavior belongs in `packages/core-db`.
- User-facing command contracts, history, result snapshots, import/export providers, and table-edit orchestration may live in the current owning package or a new focused core package if justified.
- Agent-facing wrappers belong in `packages/core-tools`, but they must call deterministic services instead of duplicating SQL logic.
- IPC should be a thin typed layer over service methods.

## Required Service Contracts

Design contracts for these deterministic workflows:

- Schema tree: lazy loading, object search, table/view/function/procedure/index metadata, and refresh invalidation.
- SQL execution: full file, selected SQL, current statement, `EXPLAIN`, cancellation, multi-result handling, messages, history, and snapshots.
- Result sets: pagination/streaming, column metadata, search/filter contracts, column visibility, export providers for CSV, Excel, and JSON.
- Table data browsing: default `LIMIT`, filters, sort, column selection, row estimates, and large-table guardrails.
- Table data editing: staged cell/row changes, generated SQL preview, validation, transaction commit, rollback on failure, and undo before commit.
- Table designer: DDL preview for columns, indexes, constraints, foreign keys, and safe apply flow.
- Import/export: parse preview, mapping, batching, transaction mode, progress events, and partial-failure reporting.
- Query history: searchable records with connection, status, duration, error, affected rows, and rerun/open-as-editor data.

## Safety Requirements

- DML edits must execute in transactions and rollback on error.
- Dangerous DDL/DML must be classified before execution and routed through permission policy.
- Large result sets must use pagination or streaming; never require full in-memory materialization.
- Exports must support output limits or streaming to avoid memory spikes.
- User data written to local history/snapshots must stay local and be documented.

## Testing Requirements

- Unit test SQL splitting/current statement detection, result filtering, export formatting, staged table edits, generated SQL preview, and history persistence.
- Integration test against real PostgreSQL for table browsing, DML rollback, DDL preview/apply where safe, `EXPLAIN`, cancellation when feasible, JSONB/array/date/boolean handling, and import/export round trips.
- Include realistic fixtures: users, orders, order_items, indexes, comments, JSONB fields, soft delete, encrypted-field markers, foreign keys, and enough rows to exercise pagination.
- Add regression cases for failed commit preserving staged edits and failed export not corrupting output files.

## Done Criteria

- A non-UI caller can exercise the complete workflow from connection to query/table operation to history/export.
- Typecheck and targeted tests pass.
- Chinese module docs explain API contracts, safety behavior, persistence locations, test fixtures, and known limits.
