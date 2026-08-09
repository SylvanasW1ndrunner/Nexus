# Task 4 Round-Two Persistence Hardening Plan

> Execute RED-first. Preserve unrelated worktree changes. Stage and commit only Task 4 files; do not push.

## Required references

The resilience skill routes persistence work through `docs/product`. That directory is absent in this checkout as of 2026-08-10, so this plan uses the review requirements, existing Task 4 tests, and `docs/agent/09-unified-agent-execution-implementation-plan.md` as the available repository contract.

## Root-cause map

- Migration exclusion is a PID JSON sentinel. It is not a kernel-owned lock, can be stolen through stale-process heuristics, and does not gate legacy writers across the checked-to-rename activation window.
- Shadow validation is distributed and incomplete. It does not revalidate all Journal facts, import digests/counts, archive bytes, and build context at each recovery/activation boundary.
- Legacy import uses a public special commit method and custom facts as an acceptance escape hatch. Message variants lose system/tool fields, normal projections do not expose all legacy state, and the carrier Run is not hidden and terminal.
- Projection validators release terminal Run state after cursor filtering. A late cursor can therefore retain every completed Run scanned before the requested page.
- Artifact `open()` verifies by pathname before opening a second handle, so replacement can occur between verification and streaming. Commit/promotion and GC have no cross-process exclusion, and artifact fact comparison omits summary.

## Implementation checkpoints

### 1. Cross-process migration and writer gates

Files: `packages/core-agent/src/session-store.ts`, `packages/core-agent/src/session/state-migrations.ts`, migration fixtures/tests.

1. Add failing two-process tests for a legacy write during the final semantic-check-to-rename barrier, a live migration-owner lock that cannot be stolen, and SIGKILL lock release.
2. Replace the sentinel with SQLite guard databases whose transactions are owned by live OS file handles.
3. Route every legacy store mutation through one shared-gate helper held for the complete `state.db` mutation.
4. Hold the migration activation gate exclusively across the last live-state recheck, source rename, shadow promotion, and directory fsync.
5. Re-run only the new migration-lock tests before moving on.

### 2. Shadow validation and public migrated state

Files: migration runner/writer, Journal session store, event contracts/projections, migration tests.

1. Add failing tests for post-validation Journal-row tampering, archive-byte tampering, exact system/user/assistant/tool round trips, public Session/Run/preference/checkpoint/subagent reads, terminal hidden carrier behavior, verified archive reads after reopen, sealed build context, and package-consumer authority forgery.
2. Centralize `validateShadow` and call it after construction, during intent recovery, and immediately before activation. Validate SQLite integrity, strict event schema/upcasts/causality/public projections, event count, import/validation digests, archive checksum/size, and build-context identity.
3. Import exact legacy discriminants and expose migrated facts through typed public projection APIs. Make historical Runs terminal and mark the synthetic migration carrier hidden and terminal.
4. Remove `commitLegacyImport` from the public Journal class. Issue a module-closure migration writer once, bind it to the build context, and seal/remove that context during activation.
5. Add a typed archive handle/reader that verifies checksum and size from persisted metadata and returns the verified bytes after reopen.

### 3. Bounded terminal projection retention

Files: `packages/core-agent/src/session/session-projection.ts`, projection tests.

1. Add a failing late-cursor test scanning more than 10,000 terminal Runs and assert bounded retained Run state.
2. Capture any terminal data needed by the projection and release validator state before cursor/limit filtering.
3. Re-run projection golden and faults tests.

### 4. Artifact atomicity and GC synchronization

Files: `packages/core-agent/src/artifacts/project-artifact-store.ts`, artifact contracts/tests/fixtures.

1. Add failing deterministic tests for pathname replacement after verification, normalized typed open errors, commit-vs-GC reference races, and summary idempotency/conflicts.
2. Open the object once, verify checksum/size from that file descriptor, and stream from the same descriptor while normalizing storage errors.
3. Serialize journal-reference creation/promotion and GC scan/deletion using a SQLite transaction guard that is safe across processes and released by the OS after death.
4. Include summary in the exact artifact fact match contract.

### 5. Evidence and handoff

1. Update `task-4-report` with RED evidence, design decisions, product-doc absence, and final commands.
2. Run the exact nine-file Task 4 suite (at least 102 tests), the exact six-file Task 3 regression suite (at least 100 tests), four TypeScript checks, scoped lint, and scoped diff/status review.
3. Commit only Task 4 paths with the configured Chandler Niu identity. Do not push.
