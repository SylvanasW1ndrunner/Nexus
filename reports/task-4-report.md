# Task 4 Persistence Report

Date: 2026-08-10
Scope: Artifact Store, Session projections, legacy state migration, and Task 3 Journal regressions.

## Round-two outcome

The round-two persistence review is implemented in four RED-first checkpoints:

- `7f565d7` — replace the PID sentinel with kernel-owned SQLite migration-owner and state-writer transaction gates. Every legacy `AgentSessionStore` database operation holds the shared gate; activation holds the exclusive gate from the final live semantic check through source rename, Shadow promotion, and fsync.
- `160386f` — centralize Shadow semantic validation and remove the public legacy commit escape hatch. The validator runs after build, during intent recovery, and immediately before activation. It checks SQLite integrity, exact Journal schema/upcasts/causality/public projections, event counts, imported-state and validation-report digests, archive metadata/bytes, carrier state, and build context.
- `0ff2ef9` — release trusted projection causal state before cursor and page-limit filtering. Retention is now `O(active target-session Runs and their live causal children)`, independent of completed history.
- `1dc2678` — verify and stream artifact bytes from one file descriptor, compare artifact summaries during idempotency/conflict checks, and serialize commit/promotion against GC with a real SQLite mutation gate.

`docs/product` is absent in this checkout. The implementation therefore used the review contract, existing tests, and `docs/agent/09-unified-agent-execution-implementation-plan.md`; no missing product behavior was invented.

## RED evidence and closed root causes

### Migration/writer gate

Three real child-process tests failed before implementation: a live owner was not represented by an unstealable kernel lock, a legacy writer could enter the checked-to-rename interval, and process death was modeled by a stale PID file rather than OS lock release. After implementation all three pass. SIGKILL releases both SQLite transaction gates automatically.

### Shadow validation and public migrated state

Three focused cases failed before implementation: `commitLegacyImport` remained public, post-validation `agent_events` tampering activated, and system/tool/ToolCall facts were downgraded to assistant messages. The new module-closure writer is issued once and sealed; carriers are terminal and hidden; historical Runs are exposed as terminal public projections; Session, Run, preference, checkpoint, and subagent projections consume the imported facts; verified archive references remain readable after reopen. Non-portable ToolCall arguments fail with a typed migration validation error while the legacy source remains intact.

### Projection retention

The stress test scans 10,050 terminal Runs / 30,150 events behind a late cursor. Before the fix, Session and User accumulators each retained 10,050 Run scopes. After the fix, retained Run, Turn, Attempt, Invocation, and final-text counts are all zero.

### Artifact atomicity

Three deterministic cases failed before implementation: differing summaries replayed as equal, the verify-to-open pathname seam was observable, and GC did not wait for a commit paused after byte verification. The first stream now reads the verified open handle even when its pathname is replaced; later opens reject replacement bytes with typed `CORRUPT`. A 100 ms live-holder test returns typed `STORE_BUSY`.

The artifact guard is intentionally global per artifact root. This is stricter than checksum-local locking: unrelated checksum mutations serialize, reducing write/GC concurrency, but it gives a simple cross-process proof that no GC snapshot/delete can interleave with Journal-reference creation or promotion. Acquisition uses 8–15 ms jittered asynchronous polling, a 10 s default bound (configurable from 100–60,000 ms), and closes every failed, successful, or aborted SQLite handle. Future sharding can optimize concurrency without changing the correctness boundary.

## Verification

Final exact suite, TypeScript, lint, and scoped-diff results:

- Task 4 exact nine-file suite: 9 files passed, 110 tests passed. Vitest was explicitly scoped away from checkout copies under `tmp/**` and `.pnpm-store/**`.
- Task 3 exact six-file regression suite: 6 files passed, 100 tests passed, with the same checkout-copy exclusions.
- TypeScript checks: all four `--noEmit` checks passed for core-agent source, core-agent tests, core-llm source, and core-llm tests.
- Scoped ESLint: all 16 Task 4 source/test files passed with zero warnings and zero errors.
- Scoped status/diff audit: the Task 4 commit range contains only the implementation plan and Task 4 source/tests listed by the plan; unrelated pre-existing worktree changes remain unstaged and uncommitted by Task 4.

No push was performed.
