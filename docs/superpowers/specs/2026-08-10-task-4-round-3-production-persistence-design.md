# Task 4 Round Three Production Persistence Design

## Status

The round-three review contract is the approved design input. This document records the production-path interpretation used for implementation; it does not introduce behavior beyond that contract.

## Root causes

The existing acceptance fixture creates tables and sidecar files by hand, so it validates a schema that the public stores do not produce. The migration reader compounds that problem by selecting a small fixed column subset and by projecting lossy, migration-specific records. Carrier Runs are recognized through a `clientRequestId` prefix, and their IDs can leak into message and activity views.

Activation currently validates the Shadow before the final live-source barrier, seals it afterward, and does not validate the promoted file before changing the migration row to active. Only `AgentSessionStore` uses the state writer gate. Audit, checkpoint, stream, and legacy artifact producers can therefore mutate the source manifest during activation. Shadow validation also materializes complete project event arrays and repeats full event scans per Session.

Archive handles currently identify a checksum, which aliases multiple source references that contain identical bytes. Archive reads reopen the pathname after verification. The migration authority factory remains importable through a source deep import because the package has no explicit exports map.

Artifact staging validates `expiresAt` with permissive parsing, and its cleanup scope ends before verification, rename, and metadata publication. Orphan stage-temporary files are not collected. SQLite gate and Journal initialization paths require explicit handle ownership and bounded busy polling to prevent the observed Windows `EBUSY` cleanup failure.

## Architecture

### Production legacy contract

Acceptance state is produced only by root exports: `AgentSessionStore`, `AgentAuditLogStore`, `AgentCheckpointStore`, `AgentStreamStore`, and the legacy artifact producer. The migration reader detects real historical layouts with `PRAGMA table_info`, strictly parses every persisted JSON payload, and normalizes supported schema generations into a versioned legacy snapshot.

Legacy facts carry complete public records rather than selected fields: Session metadata and summary timestamps, exact Messages, complete Run records, preferences including evidence and timestamps, complete context checkpoints, and complete subagent records. Tool calls are portable, uniquely identified, name-matched to their Tool result, and consumed in assistant-call order. A malformed relationship aborts before activation and preserves the source.

Carrier ownership is explicit in Journal storage with migration metadata and a hidden flag. Public projections obtain the original legacy Run identity from the fact payload, never from carrier naming. Session messages, Run lists, User Activity, Audit, preferences, checkpoints, subagents, and archive views are verified through the public package root after reopen.

### Activation and project writer gate

One crash-released SQLite project gate provides shared leases for every legitimate legacy producer and an exclusive lease for migration activation. Final live-source validation, Shadow sealing, sealed-Shadow validation, source rename, Shadow promotion, promoted-file validation, and activation-state transition all occur while the exclusive lease is held. Active state is rejected unless the build context is sealed.

If promoted validation fails, recovery keeps or restores the immutable source backup and never marks the new file active. Test barriers occur before the validation they are intended to challenge. Child processes exercise every producer at the final cut and SIGKILL proves OS lock release.

Shadow validation streams each project once in bounded pages. It maintains one causal validator and per-Session bounded public accumulators without storing complete project arrays or rescanning by Session. Carrier leases are renewed before each import batch. Preferences, checkpoints, and subagents return cursor/limit pages with stable source-sequence cursors.

### Archive and authority boundary

Archive reference identity is derived from `(migrationId, relativePath)` while immutable object storage remains checksum-deduplicated. Exact reference lookup includes migration ID, reference ID, path, checksum, and size. The public stream opens one file descriptor, verifies it, and streams that same descriptor. A bounded convenience read rejects requests above its explicit byte limit.

The migration authority factory moves outside the published source tree used for package exports. An explicit package `exports` whitelist exposes only the root API. The one-shot authority is bound to one Shadow and rejects use after sealing or activation. Built-package consumer tests prove that deep import and forged reserved commits are unavailable.

### Artifact and SQLite failure behavior

Artifact arguments, including canonical ISO timestamps, are validated before directory creation or source iteration. A single cleanup scope owns the temporary handle and `.stage-*.tmp` path through byte verification, rename, final verification, and metadata publication. Every failure is normalized to `ArtifactStoreError`; GC removes aged orphan temporary files while holding the mutation gate.

Commit-versus-GC and lock-release tests use real child processes. SQLite gate acquisition owns a possibly opened handle from construction through initialization; any constructor/pragma/prepare/transaction failure closes it. Busy acquisition retries only recognized transient busy errors with a deadline and jitter, returning the existing typed busy error when exhausted.

## Verification contract

Each group starts with focused tests that fail for the diagnosed production gap, then receives the minimal production change. The exact Task 4 and Task 3 controller suites run repeatedly after the final code change. Four TypeScript checks, scoped ESLint, `git diff --check`, a scoped secret scan, report reconciliation, and a Task 4-only staged audit precede the final local commit. No push is performed.
