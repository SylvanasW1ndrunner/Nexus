# Task 4 Round Three Production Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synthetic persistence acceptance with public production paths and close the remaining migration, authority, archive, artifact, and SQLite failure seams.

**Architecture:** Normalize real legacy store generations into complete versioned facts, guard every source producer with one crash-released project gate, and activate only a sealed Shadow that passes both pre-promotion and promoted-file validation. Keep archive reference identity separate from blob identity and make artifact/SQLite resource ownership explicit across every failure path.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Node filesystem handles, Vitest child-process integration tests, pnpm package builds.

## Global Constraints

- Strict RED-first development; record the expected failing assertion before production edits.
- Use `apply_patch` for every source, test, documentation, and report edit.
- Preserve all unrelated worktree changes and stage only Task 4 files.
- Do not push.
- Use public root imports for migration acceptance and built-package consumer tests.
- Normalize integrity failures to existing typed persistence errors; never hide or silently discard them.

---

### Task 1: Real legacy contract and complete public projections

**Files:**
- Modify: `packages/core-agent/test/legacy-migration.test.ts`
- Modify: `packages/core-agent/src/session/state-migrations.ts`
- Modify: `packages/core-agent/src/events/agent-event.ts`
- Modify: `packages/core-agent/src/events/event-schema-registry.ts`
- Modify: `packages/core-agent/src/events/event-upcasters.ts`
- Modify: `packages/core-agent/src/session/session-projection.ts`
- Modify: `packages/core-agent/src/journal-session-store.ts`

**Interfaces:**
- Consumes: public legacy producers exported by `packages/core-agent/src/index.ts`.
- Produces: complete versioned `legacy.imported` facts and bounded public legacy projection pages.

- [ ] Replace `createLegacyProject` hand-built DDL/files with public-store calls and prove the fixture contains no `ALTER TABLE` or direct acceptance inserts.
- [ ] Run the focused production-fixture acceptance and capture its failure on the current fixed-column reader.
- [ ] Add `PRAGMA table_info` layout detection and strict JSON parsing for real Session and Run payloads.
- [ ] Expand versioned facts to carry complete Session summary/metadata, Run, preference, checkpoint, and subagent records.
- [ ] Add RED cases for duplicate/missing/name-mismatched/out-of-order Tool results, then enforce exact ToolCall causality.
- [ ] Add explicit carrier metadata and public Session/Run/Activity/Audit assertions proving no carrier identity leaks after reopen.
- [ ] Run the focused legacy, schema, upcaster, and projection suites and commit the group.

### Task 2: Atomic activation, all writers, paging, and bounded validation

**Files:**
- Modify: `packages/core-agent/src/session/state-writer-gate.ts`
- Modify: `packages/core-agent/src/session/state-migrations.ts`
- Modify: `packages/core-agent/src/session-store.ts`
- Modify: `packages/core-agent/src/audit-log-store.ts`
- Modify: `packages/core-agent/src/checkpoint-store.ts`
- Modify: `packages/core-agent/src/stream-store.ts`
- Modify: `packages/core-agent/src/journal-session-store.ts`
- Modify: `packages/core-agent/test/legacy-migration.test.ts`
- Modify: `packages/core-agent/test/fixtures/migration-lock-worker.ts`

**Interfaces:**
- Consumes: `acquireSharedProjectStateGate(projectDir)` and `acquireExclusiveProjectStateGate(projectDir)`.
- Produces: sealed pre-promotion validation, promoted-file validation, crash-safe rollback, and cursor pages.

- [ ] Add post-live-recheck and post-promote-before-active tamper tests; verify both reach active state before the fix.
- [ ] Move each barrier before its challenged validation, seal then validate the Shadow, validate the promoted file, and require `sealed = 1` for active state.
- [ ] Add child writer modes for Session, audit append, checkpoint save, stream write, and legacy artifact write; observe each enter the final cut without the shared gate.
- [ ] Route every producer through the shared project gate and verify every child blocks and then fails safely after activation; add SIGKILL release cases.
- [ ] Add cursor/limit/page contracts for preferences, checkpoints, and subagents with invalid-boundary tests.
- [ ] Replace full project arrays and per-Session rescans with one bounded streaming validation pass; expose diagnostics used only by scale tests.
- [ ] Renew the fenced carrier lease before every import batch and add a multi-page scale migration.
- [ ] Run focused migration/store/projection suites and commit the group.

### Task 3: Reference-scoped archives and unpublishable authority

**Files:**
- Modify: `packages/core-agent/src/session/state-migrations.ts`
- Move/delete: `packages/core-agent/src/session/legacy-migration-writer.ts`
- Modify: `packages/core-agent/src/events/sqlite-agent-journal.ts`
- Modify: `packages/core-agent/package.json`
- Modify: `packages/core-agent/test/legacy-migration.test.ts`
- Modify: `packages/core-agent/test/persistence-root-exports.test.ts`

**Interfaces:**
- Produces: `openLegacyArchive(ref)` verified stream and `readLegacyArchive(ref, { maxBytes })` bounded convenience read.
- Hides: the one-shot migration authority factory from published package paths.

- [ ] Add equal-checksum/different-path archive references and prove checksum handles alias before the fix.
- [ ] Add pathname replacement and bounded-read RED cases.
- [ ] Derive reference IDs from migration/path while retaining checksum object dedup; exact-query the reference and stream the verified descriptor.
- [ ] Add built-package root-import, forbidden deep-import, and forged-authority consumer tests; verify current package permits the deep path.
- [ ] Add an explicit exports whitelist, move the factory behind the unpublished boundary, and enforce per-Shadow one-shot plus sealed/active rejection.
- [ ] Build the package, run consumer/archive tests, and commit the group.

### Task 4: Artifact failure atomicity and Task 3 SQLite cleanup

**Files:**
- Modify: `packages/core-agent/src/artifacts/project-artifact-store.ts`
- Modify: `packages/core-agent/src/artifacts/artifact-mutation-gate.ts`
- Modify: `packages/core-agent/src/events/sqlite-agent-journal.ts`
- Modify: `packages/core-agent/test/artifact-store.test.ts`
- Create: `packages/core-agent/test/fixtures/artifact-mutation-worker.ts`
- Modify: `packages/core-agent/test/agent-journal-faults.test.ts`

**Interfaces:**
- Produces: exact pre-I/O validation, failure-atomic staging, orphan-temp GC, child-process mutation exclusion, and leak-free bounded SQLite polling.

- [ ] Add a non-canonical ISO test that asserts no directory/source I/O.
- [ ] Inject verify, rename, metadata, and filesystem failures and assert no `.stage-*.tmp` remains with a typed error.
- [ ] Add aged/fresh orphan temporary files and verify GC reaps only aged orphans.
- [ ] Add real child commit-versus-GC and SIGKILL lock-release workers and observe the current in-process-only proof gap.
- [ ] Put the complete staging pipeline under one cleanup/error-normalization scope and implement orphan GC.
- [ ] Add a deterministic initialization/prepare busy regression that repeatedly opens, times out, closes, and deletes the SQLite database on Windows.
- [ ] Make gate/Journal acquisition close every partial handle and poll recognized transient busy errors until the typed deadline.
- [ ] Run artifact and Task 3 fault suites repeatedly and commit the group.

### Task 5: Final verification and reports

**Files:**
- Modify: `reports/task-4-report.md`
- Modify or remove: any ignored duplicate Task 4 ledger discovered by `git ls-files --others --ignored`.

- [ ] Run the exact nine-file Task 4 suite at least twice after the last production edit.
- [ ] Run the exact six-file Task 3 suite at least twice after the last production edit.
- [ ] Run `tsc --noEmit` for core-agent source/tests and core-llm source/tests.
- [ ] Run scoped ESLint, `git diff --check`, and a scoped secret-pattern scan.
- [ ] Reconcile the current report and ignored ledger, recording RED evidence, scale bounds, child-process evidence, counts, and all checkpoint SHAs.
- [ ] Audit staged paths against the Task 4 plan, commit the final report locally, and verify no Task 4 path remains dirty.
