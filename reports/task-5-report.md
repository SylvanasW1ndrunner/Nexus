# Task 5 Tool Invocation Runtime Report

Date: 2026-08-10
Scope: deterministic Tool scheduling, authoritative Invocation lifecycle, approval, execution, bounded results, and crash-safe recovery. Agent Kernel and capability adapters remain outside this task.

## Local checkpoints

- `23fddbe` - pure deterministic scheduler and ordering/barrier tests.
- `8a8fefe` - durable Invocation lifecycle facts, schemas, projections, and Journal commands.
- The final Task 5 implementation commit is created after this report. No checkpoint was pushed.

## RED evidence

- The initial Task 5 controller failed 23 tests because the scheduler, runtime, typed errors, approval binding, and recovery contracts did not exist.
- Mixed read/write windows exposed direct-dispatch bypasses: a caller could target a later read, cross an unresolved write barrier, or exceed configured parallelism.
- Parallel Handlers could publish Observations in completion order instead of model action order.
- Runtime inputs were not yet strict immutable snapshots; caller mutation, accessors, symbols, sparse arrays, cycles, and extra command keys crossed the asynchronous boundary.
- Lease takeover was covered, but natural lease expiry and renewal-extension behavior were initially missing.
- Unknown-outcome lookup and retry-permit lookup initially materialized unbounded history instead of using exact indexed projections.
- Risky equivalent retries without a permit could fall through to the ordinary approval path.
- Large Handler envelopes reached the Journal before projection bounds and secret/local-diagnostic redaction, causing late persistence rejection rather than one safe terminal result.
- Restart recovery initially compared process-local numeric Registry revisions. A new Registry could therefore reuse revision `1` for changed Tool semantics, or reject unchanged semantics after unrelated registrations. RED tests covered identical restart semantics plus independent Schema, effect, and Handler revision changes.
- Invocation fingerprint ingress initially risked traversing accessors, cycles, `undefined`, or a sparse array's declared length. RED tests proved every such descriptor is rejected atomically before registration and without evaluating a getter.
- The first Task 4 regression run passed 183 of 184 tests; the built-package import test correctly failed because `dist` had not been built. After the documented package build prerequisite, the complete controller passed 184 of 184.

## Implemented guarantees

### One scheduler and execution authority

- `decideSchedule(snapshot)` is pure and deterministic. It preserves model order, resolves eligible proposals before dispatch, stops read windows at unresolved write/external barriers, and enforces bounded read concurrency.
- `ToolInvocationRuntime` is the sole new Handler invocation authority. Public direct execution may only select the first Invocation in the current committed scheduler decision; it cannot jump barriers, later reads, or concurrency bounds.
- Handlers may complete concurrently and their terminal facts are committed in real completion order; exactly one Observation per Invocation is then published strictly in model action order. Cancellation stops undispatched work and reaches started Handlers without discarding already committed terminal evidence.

### Strict immutable ingress and durable lifecycle

- All eight Invocation command variants and Journal queries are snapshotted before their first `await` with exact allowed keys and portable nested values. Accessors, proxies, symbols, cycles, sparse arrays, and extraneous action fields are rejected.
- Invocation recovery binds to a stable SHA-256 semantic revision derived from the strict portable Tool descriptor plus an explicit bounded `handlerRevision`; it is independent of Registry insertion order and process lifetime. Unchanged semantics survive restart, while Schema, effect, or Handler implementation changes fail before Handler execution with `TOOL_REVISION_MISMATCH`.
- Descriptor fingerprinting validates actual own keys and bounded collection sizes before canonicalization. It never walks a sparse array by declared length, never invokes an accessor, and rejects cycles and unsupported values before mutating Registry state.
- The lifecycle is Journal-authoritative: `proposed -> validated -> awaiting_approval | authorized | denied -> started -> succeeded | failed | outcome_unknown -> observed`.
- Every transition uses expected revision/CAS and current Run lease fencing. Two Runtime instances racing validation or execution cannot call a Handler prematurely or create duplicate terminal/Observation facts.
- Run aggregate projections rebuild mixed Invocation state from Journal facts; no in-memory Map is durable authority.

### Approval, lease, and recovery

- Approval binds Project, Session, Run, Turn, Invocation, canonical Tool revision, declared effect, argument digest, and proposed revision. Identical decisions replay; conflicts are typed.
- Approval listing is scoped and keyset-paged by opaque `(createdAt, approvalId)` cursor with a hard limit. Waits survive Runtime restart and honor cancellation.
- Lease monitoring reads the authoritative Journal lease, observes owner/fence changes and natural expiry, and respects renewed expiry. Stale completions cannot publish a terminal result or Observation.
- Read/idempotent recovery reuses the persisted idempotency key under a current fence. Transactional/non-idempotent interruption records `outcome_unknown`; equivalent risky retry requires one exact, single-use, Invocation-bound permit.
- Unknown-equivalent and retry-permit lookup use indexed exact queries over `agent_invocations`, including scope, revision, effect, and digest. Resolution removes an Invocation from unknown-equivalent matching.

### Results and errors

- Ajv 2020 validates Tool arguments through a bounded 128-entry compiled-schema cache. Validator diagnostics and Handler failures map to the closed typed error contract; exception text is not execution policy.
- Handler output is sanitized before any durable write. Journal outcome/Observation facts keep bounded portable projections and references; full bounded-independent envelopes are staged in the managed Artifact Store.
- Secret-bearing keys, stack traces, and local filesystem diagnostics are removed from model, durable, user, Journal, and Artifact views. Ordinary business paths remain usable.
- User-safe summaries, approval text, actor identity, reference counts, and artifact handles have explicit bounds and formats. Raw or large outputs are not copied into Session messages or preferences.

## Dependency review

- `ajv@8.20.0` was already present in the repository lockfile. It is MIT-licensed, pure JavaScript, has no native binary or runtime download, and is now an explicit `@dbagent/core-agent` dependency.
- Ajv types and instances remain behind core-agent contracts; only compiled validators enter the bounded private cache.
- The requested `docs/product/05-*` and `docs/product/07-*` references are absent from this repository. Per maintainer approval, implementation used `docs/agent/08-unified-agent-execution-spine.md`, the Task 5 brief, and repository release gates as the controlling fallback.

## Final verification

- Task 5 exact controller: **8 files / 93 tests**, passed after the stable semantic revision change. This covers scheduler windows/barriers, approval, registry atomicity, Journal lifecycle, restart-stable Tool identity, two-Runtime races, cancellation, real child-process crashes, lease expiry/takeover, unknown outcome, retry permits, indexed scale lookup, bounded projections, and result redaction.
- Task 3 exact regression: **6 files / 110 tests**, passed after the final production edit.
- Task 4 exact persistence regression after a clean core-agent build: **9 files / 184 tests**, passed after the final production edit.
- TypeScript `--noEmit`: core-agent source, core-agent tests, core-llm source, and core-llm tests all passed.
- The recovery suite uses real temporary SQLite state, a real external counter, and real child-process crash cuts at `after-started-before-handler`, `after-external-effect-before-terminal`, and `after-terminal-before-observation`.
- No live model, network endpoint, or credential was needed; all Tool adapters are deterministic Task 5 fixtures and all credential-like values are synthetic.

No push was performed.
