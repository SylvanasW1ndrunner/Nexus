# Runtime Result Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add temporary result materialization and explicit persistent result saving so Agents can pass complete Runtime content to local tools without moving pages through model context.

**Architecture:** `ProjectArtifactStore` opens complete content through the same owner ACL used by `result_read`. Core Tools streams that content either to a Run-owned temporary materialization store or through the existing no-replace workspace transaction path. Agent Host owns materialization lifecycle and registers both tools in the immutable baseline; Capabilities remain unaware of consumption and Run completion.

**Tech Stack:** TypeScript, Node.js Web Streams and filesystem APIs, SQLite Agent Journal, existing workspace CAS primitive, Vitest, PostgreSQL, SiliconFlow OpenAI-compatible live model.

**Spec:** `docs/superpowers/specs/2026-09-11-runtime-result-files-design.md`

## Global Constraints

- `result_materialize` creates byte-faithful Run-scoped temporary files; `result_save` creates byte-faithful persistent workspace files only when the user explicitly asks to preserve or export the result.
- Neither Tool belongs to a Capability, registers a verifier, checks Tool order, or influences Agent Run final state.
- Complete content access must validate contentRef format, host/session/run/project ownership, lifecycle and persisted Artifact identity before returning bytes.
- Persistent writes are create-only and no-replace in v1 and use the existing global permission modes and workspace path boundary.
- Runtime does not inspect sensitive content or add a new security/configuration system.
- The implementation does not add format conversion; PostgreSQL retained results stay `application/x-ndjson`.
- The current `dev` checkout contains the full uncommitted architecture migration. Do not reset, clean, commit, or overwrite unrelated changes. Work in place because a new worktree would omit the state this feature depends on.
- Follow the user's requested development order: documentation first, then implementation, then only focused tests proving the original long-result handoff problem is gone. Do not run the full repository regression suite.
- Do not use test-driven development for this slice. Add or update focused tests after the implementation exists.

---

### Task 1: Publish the result-file boundary in architecture and engineering docs

**Files:**

- Modify: `docs/architecture/base-tools-design.md`
- Modify: `docs/architecture/results-artifacts-observability.md`
- Modify: `docs/engineering/base-tools-implementation.md`
- Modify: `docs/engineering/real-model-data-analysis-acceptance.md`
- Modify: `docs/capabilities/database/overview.md`

**Interfaces:**

- Produces the authoritative public/engineering description consumed by Tasks 2–6.
- Fixes the baseline count at 14 and orders `result_materialize` and `result_save` immediately after `result_read`.

- [ ] Add the distinction between bounded model inspection, Run-scoped temporary materialization, and explicit persistent saving.
- [ ] State that temporary materializations are removed at Run terminal state and crash leftovers are reaped on later Host startup.
- [ ] State that persistent saving is an explicit Agent behavior contract, not natural-language policy enforcement or a fourth permission mode.
- [ ] Replace the live-analysis requirement to move every page through `result_read` with one bounded sample read plus full NDJSON materialization for Python.
- [ ] Re-read all five files and run `git diff --check` only for these documentation paths.

### Task 2: Open complete Artifact content through owner-scoped ACL

**Files:**

- Modify: `packages/core-agent/src/artifacts/artifact-store.ts`
- Modify: `packages/core-agent/src/artifacts/content-reference.ts`
- Modify: `packages/core-agent/src/artifacts/project-artifact-store.ts`
- Modify: `packages/core-agent/src/index.ts`
- Modify: `packages/core-agent/test/artifact-store.test.ts`

**Interfaces:**

- Produces `ContentOpenRequest`, `OpenedContent`, and `AgentArtifactStore.openContent(input): Promise<OpenedContent>`.
- `OpenedContent` contains `{stream, contentRef, contentType, byteSize, checksum}` and never exposes a physical Artifact path.
- Task 4 consumes this interface without reimplementing ACL or lifecycle checks.

- [ ] Add the public types and interface method with optional signal/deadline fields matching `ContentReadRequest` ownership scope.
- [ ] Refactor `ProjectArtifactStore` so `readContent` and `openContent` share contentRef resolution, persisted metadata, owner ACL, expiry/deletion and checksum-generation validation.
- [ ] Return the existing verified Artifact stream and metadata after all checks; do not buffer complete content in Core Agent.
- [ ] Add focused tests for same-Run byte reading and cross-Run rejection using existing Artifact test fixtures.
- [ ] Run only the changed Artifact Store test file plus `core-agent` TypeScript checking.

### Task 3: Add streamed no-replace workspace publication

**Files:**

- Modify: `packages/core-tools/src/workspace-mutation-adapter.ts`
- Modify: `packages/core-tools/src/node-workspace-mutation-primitive.ts`
- Modify: `packages/core-tools/test/workspace-tools.test.ts`

**Interfaces:**

- Extends the internal mutation execute input with `desiredSource?: ReadableStream<Uint8Array>` and `maxSourceBytes?: number`; `desiredContent` and `desiredSource` are mutually exclusive.
- Extends the parent fence with a streamed exclusive writer that returns `{digest, sizeBytes}` after write, fsync and byte-limit validation.
- Task 4 uses the same create-only binding, transaction Journal and no-replace publication as `workspace_apply_patch`.

- [ ] Implement bounded streamed temporary-file writing with signal/deadline cancellation, SHA-256 digest and 64 MiB absolute ceiling.
- [ ] Preserve the existing string patch path and its 8 MiB limit unchanged.
- [ ] Make transaction recovery validate the digest recorded after streamed temporary content is complete before publishing.
- [ ] Add focused tests for byte-faithful streamed create, existing-target conflict, and over-limit cleanup.
- [ ] Run only the focused workspace tests plus `core-tools` TypeScript checking.

### Task 4: Implement temporary materialization and explicit persistent save Tools

**Files:**

- Create: `packages/core-tools/src/result-materialization-store.ts`
- Create: `packages/core-tools/src/result-file-tools.ts`
- Modify: `packages/core-tools/src/index.ts`
- Create: `packages/core-tools/test/result-file-tools.test.ts`

**Interfaces:**

- Produces `ResultMaterializationStore`, `createResultMaterializeToolContribution`, `createResultSaveToolContribution`, and a Run-terminal cleanup API.
- `result_materialize.v1` input is `{contentRef}` and output contains `temporaryPath`, media metadata, digest and `lifecycle:'run'`.
- `result_save.v1` input is `{contentRef,path}` and output contains canonical workspace identity, digest and `lifecycle:'persistent'`.
- Tasks 5–6 consume these contributions and temporary paths.

- [ ] Implement a materialization root under `.schemanaut/runtime/materialized`, opaque per-Run directories, atomic partial-file publication, byte/digest verification, and idempotent same-content reuse.
- [ ] Implement terminal cleanup and startup reaping without making a completed Run fail when Windows delays deletion; preserve retryable cleanup records for the next startup.
- [ ] Implement both prepared Tool contracts, owner-scoped `openContent` use, 64 MiB limits, portable outputs and typed content-reference errors.
- [ ] Mark `result_materialize` as safe Runtime read and `result_save` as transactional workspace write; neither definition has completion metadata.
- [ ] Add focused tests for byte fidelity, reuse, lifecycle cleanup, persistent no-replace save and absence of final-state behavior.
- [ ] Run only the new result-file tests plus `core-tools` TypeScript checking.

### Task 5: Register 14 baseline Tools and bind Host lifecycle

**Files:**

- Modify: `packages/core-agent/src/base-tool-manifest.ts`
- Modify: `packages/agent-host/src/agent-runtime.ts`
- Modify: `packages/core-agent/test/tool-catalog-contract.test.ts`
- Modify: `packages/agent-host/test/general-agent-runtime.test.ts`

**Interfaces:**

- Baseline order becomes `ask_user`, `tool_search`, `result_read`, `result_materialize`, `result_save`, `skill`, workspace, process and web Tools.
- Agent Host owns one `ResultMaterializationStore`, initializes startup reaping before Runs are accepted, and schedules cleanup from terminal settlement and close paths.

- [ ] Update the manifest revisions and publish both contributions in exact order.
- [ ] Compose the existing workspace target revalidator with `result_save` prepared targets and reuse the Host-owned mutation adapter instance.
- [ ] Attach materialization cleanup to parent and child terminal settlement without changing the terminal result or Capability state.
- [ ] Add focused manifest/Host tests confirming exposure, owner wiring and terminal cleanup.
- [ ] Run only the touched manifest/Host test files and TypeScript checking for `core-agent`, `core-tools`, and `agent-host`.

### Task 6: Prove the original model workflow no longer moves all pages

**Files:**

- Modify: `packages/agent-host/test/database-analysis-live-fixtures.ts`
- Modify: `packages/agent-host/test/database-analysis-live-fixtures.test.ts`
- Modify: `packages/agent-host/test/database-analysis.live.integration.test.ts`
- Update generated report: `reports/agent-runtime/live-database-churn-ml.json`

**Interfaces:**

- Churn prompt requires one bounded `result_read` sample, then `result_materialize`; Python reads the returned NDJSON temporary path directly.
- Posterior evidence requires at least one successful `result_materialize`, no exhaustive result pagination, a successful Python `process_exec`, and correct `churn_metrics.json`.

- [ ] Update the churn task and Python expectations to consume NDJSON while preserving the independent PostgreSQL oracle and deterministic classifier requirements.
- [ ] Update the fixture contract test to assert sample inspection plus materialization, not page-by-page transfer to EOF.
- [ ] Build only the touched packages so the live test imports current `dist` output.
- [ ] Run the deterministic fixture contract tests.
- [ ] Run only the SiliconFlow `database-churn-ml` live scenario with the user-provided environment-injected key, never printing or persisting the key.
- [ ] Inspect the report to confirm the Run completed, `result_materialize` succeeded, Python ran, metrics beat the majority baseline, and the model did not call `result_read` once per data page.
- [ ] Run the static Capability boundary search for verifier/last-tool/final-tool residue; do not add a separate Capability test suite.
