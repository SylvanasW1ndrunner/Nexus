# Task 3 report: durable Agent Event Journal

## Scope and commits

- Initial implementation: `ac86a1e651ecc4be2eb512a546c9b1df12de8489` (`feat(agent): add durable event journal and atomic turn commit`).
- Review repair: pending commit `fix(agent): close journal authority and replay invariants`.
- Scope stayed within Task 3 plus the minimal Task 2 authenticity mint/assertion in `core-llm`. Task 4 Kernel and legacy Session cutover were not implemented.

## Review repair RED evidence

Commands use bundled Node `C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` with `node_modules/vitest/vitest.mjs`.

- Authority/identity RED: `agent-journal.test.ts` reported 9 failed / 4 passed. Failures proved draft identity keys could override Project/Session/Run, generic commits could append seven reserved Run/Turn/Model/Tool facts, and the prepared model persistence primitive was public.
- Authenticity RED: `gateway-attempt-boundary.test.ts` reported 1 failed / 18 passed because no runtime authenticity assertion existed.
- Causal/CAS RED: `model-turn-commit.test.ts` reported 4 failed / 0 passed before typed `startRun`/`startTurn`, Turn causality, and revision CAS existed.
- Event-only replay RED: first 1 failed / 4 passed because Envelope and validated Attempt were absent from replay; then 1 failed / 5 passed because wiped materialized tables could not be rebuilt from events.
- Real contention RED: `agent-journal-faults.test.ts` reported 1 failed / 7 passed because SQLite lock exhaustion leaked raw `ERR_SQLITE_ERROR` instead of typed `JOURNAL_BUSY`.

## Implemented invariants

- `ModelExecutionGateway` mints `ValidatedModelAttempt` objects into a module-private `WeakSet`; only the public assertion is package-exported. Structural clones and handwritten objects are rejected.
- Generic `commit` rejects every authoritative `run.*`, `turn.*`, `model_*`, and `tool.*` fact. `startRun`, `startTurn`, and `RunEventCommitter` are closed typed mutation paths.
- The internal prepared commit uses a non-string symbol capability and is absent as a public method. Prepared content participates in the idempotency digest.
- Commands and event drafts use exact-key runtime whitelists; journal-owned identity is constructed field-by-field and cannot be overwritten by producer objects.
- Run and Turn mutations require expected revisions. Run updates use `(project_id, run_id, revision)` CAS; model commit requires an already-started Turn owned by the same Project/Session/Run and updates its lifecycle by revision CAS.
- `model_attempt_committed` contains the complete validated Attempt, committed Turn, and current Protocol Envelope. `tool.proposed` events contain every Invocation fact. Replay rebuilds exact Turn/Attempt/Envelope/Invocation values, and `rebuildProjectProjections` recreates wiped materialized tables from events alone.
- Event payloads use concrete TypeScript shapes and exact runtime checks for authoritative facts. Payloads are canonical portable JSON, capped at 256 KiB, and scanned for secrets, credential URLs, and credential/header fields. Tool outcomes accept bounded summaries and reference arrays rather than raw results/errors.
- Readers validate stored event type, schema version, JSON, portability, and typed payload before upcasting. Corrupt and unsupported rows raise typed errors; upcasters always return the registry's current schema version.
- WAL, FULL synchronous mode, foreign keys, bounded busy timeout, exact lease-expiry fencing, and project-scoped gap-free sequences remain enabled.

## Final verification

Targeted command:

```powershell
node node_modules/vitest/vitest.mjs run packages/core-agent/test/agent-journal.test.ts packages/core-agent/test/agent-journal-faults.test.ts packages/core-agent/test/run-ingress-idempotency.test.ts packages/core-agent/test/model-turn-commit.test.ts packages/core-llm/test/fault-injection/gateway-attempt-boundary.test.ts --pool=forks
```

Result: 5 files passed, 51 tests passed, exit 0.

- `core-agent` production and test TypeScript: exit 0.
- `core-llm` production and test TypeScript: exit 0.
- scoped ESLint for every touched source/test file: exit 0.
- Fault coverage includes five transaction rollback cuts, exact lease expiry, real `worker_threads` + `node:sqlite` lock contention, and worker termination before commit / after commit-before-return.

The canonical full `core-agent` suite still has the four previously identified legacy `react-agent.test.ts` failures (partial-stream recovery and three compaction/checkpoint cases). They belong to Task 6 legacy cutover and are explicitly not reported as green here.
