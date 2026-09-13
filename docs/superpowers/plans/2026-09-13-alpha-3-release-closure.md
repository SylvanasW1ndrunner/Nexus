# SchemaNaut 0.1.0-alpha.3 Release Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a committed, internally consistent, locally verified `0.1.0-alpha.3` npm candidate that is ready for the maintainer's remote release step.

**Architecture:** Preserve the CLI-only product boundary and existing release pipeline. Documentation establishes the release identity first; mechanical version metadata follows; the complete accumulated product baseline is then audited, committed, rebuilt from a clean HEAD, and reviewed.

**Tech Stack:** Markdown, TypeScript, Node.js 22+, pnpm, Turbo, Vitest, Node test runner, npm tarballs.

**Spec:** `docs/superpowers/specs/2026-09-13-alpha-3-release-closure-design.md`

## Global Constraints

- Documentation changes precede version-code changes.
- The release identity is exactly `@nwlworkshop/schemanaut@0.1.0-alpha.3`, CLI `schemanaut`, npm tag `next`.
- The public package remains CLI-only and exposes no SDK, Server, HTTP API, or Agent WebUI.
- Do not add compatibility layers or alter Capability, Tool, permission, result, or configuration behavior.
- Preserve unrelated local files; do not delete `.codex_work/`, `output/`, or `HANDOFF-2026-09-05.md`.
- Do not publish to npm. Do not push until the branch-finishing decision is explicit.
- Use the existing deterministic and package gates; paid live-model tests are not repeated for a metadata-only closure.

---

### Task 1: Close release-facing documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/engineering/verification.md`
- Modify: `docs/engineering/README.md`
- Modify: `reports/pre-release-audit/00-traceability-matrix.md`
- Modify: `reports/pre-release-audit/01-legacy-residue.md`
- Modify: `reports/pre-release-audit/02-functional-pipeline.md`
- Modify: `reports/pre-release-audit/03-security-reliability.md`
- Modify: `reports/pre-release-audit/04-release-gates.md`

**Interfaces:**
- Consumes: the current 14-base-Tool, eight-Capability, global-config and CLI-only product contracts.
- Produces: one unambiguous Alpha 3 release story and a historical marker for the superseded July audit.

- [x] **Step 1:** Move the completed `Unreleased` entries into a dated `0.1.0-alpha.3` section, retain an empty `Unreleased` heading, and list the current Alpha limitations without rewriting the historical Alpha 2 entry.
- [x] **Step 2:** Add `npm install --global @nwlworkshop/schemanaut@next` as the public Alpha installation path in both READMEs, while keeping source checkout instructions as the contributor/development path.
- [x] **Step 3:** Add a 2026-09-13 Alpha 3 closure section to `docs/engineering/verification.md` that records the current deterministic counts, the successful isolated package smoke path, the failed churn-ML live evidence, and the external tests not repeated in this metadata-only closure.
- [x] **Step 4:** Add a prominent superseded/historical notice to each 2026-07 pre-release audit document without rewriting its historical evidence.
- [x] **Step 5:** Link this spec and plan from `docs/engineering/README.md` and run a focused text scan for contradictory current-version claims.

### Task 2: Align release metadata and repository hygiene

**Files:**
- Modify: `package.json`
- Modify: `apps/terminal/package.json`
- Modify: `packages/agent-host/package.json`
- Modify: `packages/core-agent/package.json`
- Modify: `packages/core-db/package.json`
- Modify: `packages/core-llm/package.json`
- Modify: `packages/core-rag/package.json`
- Modify: `packages/core-resource/package.json`
- Modify: `packages/core-skills/package.json`
- Modify: `packages/core-tools/package.json`
- Modify: `packages/core-usage/package.json`
- Modify: `packages/database-capability/package.json`
- Modify: `packages/first-party-capabilities/package.json`
- Modify: `packages/shared/package.json`
- Modify: `scripts/lib/npm-package.mjs`
- Modify: `scripts/lib/public-documents.mjs`
- Modify: `scripts/tests/npm-package-contract.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Alpha 3 identity established by Task 1.
- Produces: one package version across every workspace and a release provenance that ignores unrelated local artifacts.

- [x] **Step 1:** Change every current workspace and root version from `0.1.0-alpha.2` to `0.1.0-alpha.3` without changing package names, dependency ranges, private flags, CLI name, or npm tag.
- [x] **Step 2:** Change `NPM_PACKAGE_VERSION` and package-contract expectations to `0.1.0-alpha.3`.
- [x] **Step 2a:** Add the Alpha 3 spec and plan to `PUBLIC_DOCUMENT_FILES` because the already-public engineering index links to them; preserve the transitive public Markdown closure.
- [x] **Step 3:** Ignore `.codex_work/`, `output/`, `HANDOFF-*.md`, root `state.db` and nested `state.db` runtime files; retain the existing files on disk and verify they cannot enter the candidate.
- [x] **Step 4:** Run version-consistency, package-contract and `git diff --check` checks.

### Task 3: Audit and commit the accumulated product baseline

**Files:**
- Review and stage: all intended product source, test, documentation, workflow, script, Skill and report changes already present in the workspace.
- Exclude: `.codex_work/**`, `output/**`, `HANDOFF-2026-09-05.md`, `release/**`, `.superpowers/**`, runtime databases and environment files.

**Interfaces:**
- Consumes: Tasks 1-2 and the previously implemented Agent/Capability baseline.
- Produces: a Git commit that exactly owns the source used for Alpha 3 packaging.

- [x] **Step 1:** Inspect all untracked and deleted paths by category and confirm that only product files are staged.
- [x] **Step 2:** Run the repository credential-pattern hygiene check without printing credential values; classify synthetic test fixtures separately from real findings.
- [x] **Step 3:** Review the staged stat and staged path list, then commit with message `release: prepare SchemaNaut 0.1.0-alpha.3`.
- [x] **Step 4:** Confirm `git status --porcelain` is empty and capture the resulting commit SHA.

### Task 4: Build and verify the clean Alpha 3 candidate

**Files:**
- Generated and ignored: `release/SchemaNaut-v0.1.0-alpha.3/*`

**Interfaces:**
- Consumes: the clean Alpha 3 commit from Task 3.
- Produces: tarball, checksum, provenance and isolated-install evidence bound to that commit.

- [x] **Step 1:** Run `corepack pnpm typecheck`, `corepack pnpm lint`, forced full workspace tests, script contracts, Capability runtime tests and npm package contracts.
- [x] **Step 2:** Run `corepack pnpm release:local` serially.
- [x] **Step 3:** Verify the installed CLI `--help`, `init`, `skills`, `sessions` and interactive exit smoke results from the release command.
- [x] **Step 4:** Assert the provenance version is `0.1.0-alpha.3`, `sourceControl.commit` equals `git rev-parse HEAD`, `sourceControl.dirty` is `false`, and the checksum matches the tarball.

### Task 5: Final release review and branch handoff

**Files:**
- Review only: the Alpha 3 commit and generated candidate.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a release/no-release judgment and an explicit branch integration choice.

- [ ] **Step 1:** Review the complete staged/committed baseline against the spec, including version, docs, package closure, CLI-only boundary and known limitations.
- [ ] **Step 2:** Confirm no Critical or Important findings remain and no npm publish occurred.
- [ ] **Step 3:** Apply the branch-finishing workflow: keep locally, or push and trigger CI only after the selected integration action is authorized.
