# Task 4 Production Persistence Report

Date: 2026-08-10
Scope: Round-three production persistence hardening for legacy migration, projections, archives, package authority, artifacts, and Task 3 SQLite cleanup.

## Checkpoints

- `2e10db8` — production-persistence design and implementation plan.
- `b4d1f9a` — public production legacy fixtures and complete typed legacy contracts.
- `4815d83` — exhaustive v1 golden upcasting for all legacy discriminants.
- `179f374` — sealed pre-promotion and promoted-file activation validation with rollback.
- `b77e334` — shared writer gates for every manifest producer plus bounded paging/validation and lease renewal.
- `839c619` — reference-scoped archive handles, verified same-descriptor streaming, bounded reads, and unpublished one-shot migration authority.
- `d5c1667` — exact artifact preflight, failure-atomic staging, orphan temporary GC, real child-process mutation exclusion, and SQLite handle cleanup.

No checkpoint was pushed.

## RED evidence

### Production migration contract

- The initial production-only legacy fixture could not reconstruct the complete public Session/Message/Run/preference/checkpoint/subagent contract.
- Historical v1 facts did not exhaustively upcast all eight entity discriminants and message roles.
- A writer entering at the final live-source barrier completed successfully before the shared producer gates were applied.
- Tampering after the live recheck and tampering of the promoted database before activation were not both recoverable.

### Scale and archive authority

- Two archive paths containing identical bytes collapsed to one checksum-derived handle (`expected 2, received 1`).
- A built consumer successfully imported `@dbagent/core-agent/dist/session/legacy-migration-writer.js` and observed the authority factory as a function.
- Validation previously accumulated complete project arrays and rescanned them by Session; carrier ownership was not renewed at every import batch.

### Artifact and SQLite lifecycle

- A non-canonical timestamp (`2026-08-09T12:00:00Z`) was accepted, consumed the source, and returned a staged reference instead of failing before I/O.
- Verification, rename, and metadata-publication failures could escape the complete temporary/blob cleanup scope.
- The full Task 3 fault suite reproduced the Windows leak: a polling prepare raised `database is locked`, followed by `EBUSY` while unlinking the Journal database during cleanup.

## Implemented guarantees

- Migration accepts only facts produced by real public stores, preserves all typed legacy records, validates current v2 facts strictly, and exhaustively upcasts the v1 golden format.
- Activation holds the exclusive project writer gate across the final recheck, Shadow seal, sealed validation, source rename, promotion, promoted-file validation, and active transition. Audit, checkpoint, stream, artifact, and Session producers use the shared gate and are rejected after activation.
- Shadow validation scans each project once in pages of at most 1,000 events. The 1,205-message scale case reports exactly `projectPasses=1`, `maxPageSize=1000`, `importBatches=3`, and `carrierLeaseRenewals=3`.
- Archive reference identity derives from migration ID plus relative path while immutable objects remain checksum-deduplicated. Exact reference lookup includes migration, handle, path, checksum, and size. `openLegacyArchive` verifies and streams one file descriptor; `readLegacyArchive` requires an explicit `maxBytes` bound and rejects an oversized reference before file I/O.
- The package exposes only its root entry. A built consumer receives `ERR_PACKAGE_PATH_NOT_EXPORTED` for the internal authority path and `COMMITTER_REQUIRED` for a forged reserved commit. Authority is persistently one-shot per exact unsealed Shadow and rejects sealed or active state.
- Artifact arguments are validated before gate/filesystem/source I/O. One cleanup owner spans temporary creation, writing, verification, rename, final verification, and metadata publication. GC removes only aged `.stage-*.tmp` orphans and preserves fresh temporaries.
- Real child processes prove commit-versus-GC exclusion and automatic lock release after `SIGKILL`. SQLite acquisition and polling close every partial handle, retry only recognized transient busy/locked conditions to the typed deadline, and allow immediate Windows cleanup.

## Final verification

- Task 4 exact nine-file controller: **9 files / 129 tests**, passed twice after the last production edit. Each run explicitly built `@dbagent/core-agent` before the built-package consumer case and excluded `tmp/**` and `.pnpm-store/**` checkout copies.
- Task 3 exact six-file controller: **6 files / 101 tests**, passed three consecutive full groups after the last production edit. The full 22-test fault file additionally passed ten consecutive runs after the EBUSY fix; the 10-timeout initialization/delete matrix also passed ten consecutive focused runs.
- TypeScript: all four `--noEmit` checks passed for core-agent source, core-agent tests, core-llm source, and core-llm tests.
- ESLint: all 27 Task 4 source/test/fixture files in the `52fbc83..HEAD` scope passed with zero warnings and zero errors.
- Diff checks: the worktree, `8c99d33..HEAD`, and full `52fbc83..HEAD` Task 4 range all passed `git diff --check`.
- Scoped secret scan: no API-key, private-key, AWS-key, or GitHub-token patterns were found.
- The ignored `.superpowers/.../task-4-report.md` ledger was removed so this tracked report is the only Task 4 result record.

The package-consumer controller was first invoked after the Task 3 fixture had intentionally cleaned `dist`; that ordering produced one expected missing-build failure while the other 128 tests passed. Rebuilding before the consumer test resolved the harness precondition, after which both final 129-test runs passed.

No push was performed.
