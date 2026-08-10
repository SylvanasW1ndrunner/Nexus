# Task 4 Production Persistence Report

Date: 2026-08-10
Scope: Final formal review of production persistence, covering artifact lifecycle integrity, strict legacy semantics, bounded migration, and private migration authority.

## Local checkpoints

Round-three foundation:

- `2e10db8` - production-persistence design and implementation plan.
- `b4d1f9a` - public production legacy fixtures and complete typed legacy contracts.
- `4815d83` - exhaustive v1 golden upcasting for legacy discriminants.
- `179f374` - sealed activation validation and rollback.
- `b77e334` - shared producer gates, paging, validation, and lease renewal.
- `839c619` - reference-scoped archives and unpublished migration authority.
- `d5c1667` - artifact atomicity, child-process exclusion, and SQLite cleanup.
- `68b0321` - round-three verification report.

Final review repairs:

- `6696361` - unified artifact lifecycle locking and same-descriptor streaming integrity.
- `cc788b9` - typed carrier identity, cursor-independent hiding, strict ToolCall correlation, and strict v1 upcasts.
- `c1a705d` - mandatory bounded paging and streaming migration validation.
- `e48792c` - private migration construction authority and opaque public handle.
- `b1a4d51` - stable scale-test budget and retrying Windows cleanup.
- `cf773d5` - type-safe golden-event discriminant narrowing.
- `38a71fd` - durable migration writer-fence FSM, immutable imported prefixes, and typed carrier rebuild.
- `1d7b401` - iterator-based migration validation, bounded diagnostics, and exact combined Session paging.
- `64dfddc` - no-expiry staged-orphan recovery and pinned-descriptor prehash outside lifecycle gates.

No checkpoint was pushed.

## RED evidence

### Artifact lifecycle and streaming

- Same-inode append and truncate mutations exposed that pathname/initial-descriptor verification alone did not prove the bytes consumed by the caller remained exact through EOF.
- The focused six-operation final-cut matrix initially failed 10 of 14 child-process cases: open, expire, delete, and GC could cross the state boundary in both normal-release and holder-SIGKILL cases; live stage versus GC was also not fully excluded. Stage and commit were the four already-protected cases.
- Stage, commit, open, expire, delete, and GC did not all return one typed post-activation rejection.

### Legacy semantics and compatibility

- A request ID beginning with the old carrier prefix could be hidden even when it belonged to a normal user Run, and a late cursor could expose the durable migration carrier.
- Positional ToolCall/ToolResult matching accepted identity errors. Duplicate, orphan, name-mismatched, unordered, and missing results did not have one explicit causal policy.
- Strict v1 negative cases showed four concrete failures: unknown Session mode, unknown Run status, zero checkpoint sequence, and zero subagent depth were accepted. Golden coverage did not prove all eight entity types and all four message roles.

### Paging, streaming, and authority

- Preferences, checkpoints, subagents, archive references, and imported legacy state still exposed unbounded production reads or optional paging.
- Many-small-Session validation retained 75 Sessions and 225 validator accumulators before release was moved to each terminal boundary. The 1,205-message case also required proof that import commits never exceed 500 facts.
- The public migration class remained a constructible runtime authority and the public handle was forgeable as a structural object; deep imports could reach implementation authority.

### Gate-harness findings

- The first default-parallel final controller passed 149 of 150 tests: the 75-Session bounded-diagnostics case took 5.868 seconds under contention, exceeded Vitest's generic five-second budget, and teardown then observed Windows `EBUSY` while the timed-out owner was still closing. The test now has a 30-second scale budget and awaited retrying cleanup; its product assertions remain the structured bounds rather than scheduler time.
- A four-project TypeScript gate found that extracting `.payload` before checking the event discriminant lost static narrowing in the new v1 role golden. Retaining the complete event through the discriminant check fixed the test typing without changing runtime behavior.

### Final formal-review findings

- A migration crash after the source rename released the operating-system lock and allowed legacy writers to re-enter. The writer gate had no durable transition state independent of `state.db`, so recovery could promote an older Shadow and lose the accepted late write.
- Active-state reopen compared the immutable migration count with all later Journal events and rediscovered carriers through a request-ID prefix. Projection rebuild also reset the typed carrier `hidden` bit. These failures made legitimate post-migration activity and rebuilds invalidate the Project.
- Migration extraction still retained full per-Session entity arrays, reassembled a complete `ImportedLegacyState`, retained every causal event ID, and read archives into memory. Session pages counted each output collection independently, so Runs plus Messages could exceed the requested limit.
- Staged artifacts without `expiresAt` had no orphan reclamation boundary. Artifact `open()` also held the state and artifact lifecycle gates while hashing the complete file, unnecessarily blocking migration and unrelated artifact lifecycle work.
- The final artifact controller exposed two compatibility defects in the new durable writer gate: repeated schema DDL collided under concurrent shared holders, and historical `schema_migrations(status)` tables lacked the newer identity columns needed by bootstrap.

## Implemented guarantees

- Every artifact stage, commit, open recovery boundary, expire, delete, and GC operation acquires the shared project-state gate before the artifact gate. Artifact streams are capped to the recorded size, fail on early EOF or trailing bytes, hash incrementally, and recheck descriptor identity and metadata at terminal read.
- Migration carrier ownership is a typed durable visibility field, never a request-ID prefix. Projections consume carrier identity before cursor/output filtering and remove carrier Session, Run, message, and activity state. Ordinary user IDs using the former prefix remain visible.
- Legacy Tool results correlate by ToolCall ID and name. Unordered valid results import; duplicate, orphan, and name-mismatched results fail; a missing result produces explicit `LEGACY_TOOL_OUTCOME_UNKNOWN` interrupted evidence.
- V1 upcasting requires exact allowed keys, exact enum/status values, positive checkpoint sequence and subagent depth, and golden coverage of every legacy entity and message role.
- Production preferences, checkpoints, subagents, archive listing, and imported-state reads require explicit cursor and limit bounds. SQLite message/session reads stream ordered rows, projection uses per-entity indexes and one commit buffer capped at 500 facts, and terminal validation releases all three accumulators immediately.
- Scale diagnostics prove `maxImportBatchSize=500`, `maxActiveProjectionSessions=1`, and `maxActiveProjectionAccumulators=3` for the 1,205-message case; the 75-Session case proves `2`, `1`, and `3` respectively.
- Migration construction is available only through `openProjectStateMigration`. The implementation constructor requires module-private authority and validates all intent paths against canonical migration paths. The package root exposes only the factory, error, archive reference, opaque handle, and options; the old runtime class is absent, deep authority imports are blocked, forged handles fail TypeScript, and forged reserved commits fail at runtime.
- `state.writer-gate.db` now persists a three-phase `legacy-writable -> migration-sealed -> active` fence with migration identity. All legacy writers consult it after every process restart; the fence is committed before the exclusive activation gate is released, and early rollback restores writability only for the same migration identity.
- Active validation is scoped to per-Project immutable prefix watermarks, counts, and digests, so later ordinary Journal events are valid. Carrier visibility is typed, carrier request IDs are opaque hashes, and projection rebuild restores the hidden bit from typed visibility rather than naming conventions.
- Legacy extraction uses ordered SQLite iterators. Source entities are processed one at a time, Journal import batches are capped at 500, per-Project fact hashes are incremental, archive validation streams, and terminal validation releases Run event IDs and all three public accumulators. Recorded scale ceilings are `maxSourceEntityBufferSize=1`, `maxImportBatchSize=500`, `maxImportHashProjects=1`, `maxValidationFactProjects=1`, `maxRetainedValidationScopes=1`, `maxActiveProjectionSessions=1`, and `maxActiveProjectionAccumulators=3`.
- Session paging applies one visible-item budget across Messages, Artifacts, normal Runs, and imported Runs. The 2,000-Run/2,000-message regression pages at a limit of 37 with exact cursor progress and no gaps or duplicates.
- Non-expiring staged metadata is reclaimed after a configurable `stagedOrphanRetentionMs` boundary (24 hours by default); exact-boundary, fresh-stage, Journal-reference, and live-stage gate cases are covered. Artifact open now resolves lifecycle/recovery metadata, opens and `fstat`s one descriptor under the state-to-artifact lock order, releases both gates, then prehashes and terminally verifies that same pinned descriptor. Cancellation and prehash errors close it.
- Writer-fence initialization avoids repeated DDL after schema creation, permitting concurrent shared artifact operations. Historical active migration tables without identity columns still bootstrap to the typed `STATE_MIGRATION_ACTIVE` rejection.

## Final verification

- Clean package build: the package-local clean script followed by `tsc -p packages/core-agent/tsconfig.json` passed before the final built-consumer controller.
- Task 4 exact controller: **9 files / 184 tests**, passed after a clean `@dbagent/core-agent` build. Exact files: `artifact-store.test.ts`, `event-projections.golden.test.ts`, `legacy-migration.test.ts`, `persistence-root-exports.test.ts`, `session-store.test.ts`, `run-store.test.ts`, `subagent-pool.test.ts`, `event-schema-registry.test.ts`, and `agent-journal.test.ts`. The built-package consumer case ran against the clean build with ignored checkout copies excluded.
- Task 3 exact controller: **6 files / 110 tests**, passed after the last production edit. Exact files: `agent-journal.test.ts`, `agent-journal-faults.test.ts`, `run-ingress-idempotency.test.ts`, `model-turn-commit.test.ts`, `event-schema-registry.test.ts`, and `packages/core-llm/test/fault-injection/gateway-attempt-boundary.test.ts`. The 22-test Journal fault suite additionally passed three consecutive runs.
- Group-level final controllers passed: artifact **44/44**, legacy migration **51/51**, event projections plus migration **60/60**, and the new Group C focus **3/3**.
- Focused final-review integrity controller: **2 files / 31 selected tests**, passed twice. It covers real child commit/GC and live-stage/GC behavior, all six state final-cut and holder-SIGKILL operations, typed post-activation rejection, same-inode artifact/archive mutation, ToolCall identity, late-cursor carrier hiding, and both bounded scale shapes.
- TypeScript: all four `--noEmit` checks passed for core-agent source, core-agent tests, core-llm source, and core-llm tests.
- ESLint: all nine TypeScript files changed in `4949851..HEAD` passed with zero warnings and zero errors.
- Diff checks: `4949851..HEAD` and the full Task 4 range `52fbc83..HEAD` passed `git diff --check`.
- Refined credential scan over the final Task 4 scope found zero API keys, AWS keys, private keys, GitHub tokens, or credential assignments.
- Static reverse audit confirmed there is no request-prefix semantic carrier query, imported prefix watermarks/digests are enforced, rebuild restores typed `hidden`, no legacy entity reader uses `.all()`, archive validation does not use `readFile`, and terminal validation releases retained event IDs.
- `git ls-files --others --ignored --exclude-standard` found no stale Task 4 report; this tracked file is the only Task 4 result record.

No push was performed.
