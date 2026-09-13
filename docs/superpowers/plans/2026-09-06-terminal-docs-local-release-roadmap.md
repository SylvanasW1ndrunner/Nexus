# Terminal Documentation, Local Release, and Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver accurate terminal-first documentation, a verified local npm tarball, and a capability/UX development roadmap without publishing to npm.

**Architecture:** Keep every workspace package private and generate one CLI-only distribution by copying compiled outputs into a release staging tree and rewriting internal package imports to relative paths. Documentation distinguishes the supported terminal product from the private runtime implementation and future capability plans.

**Tech Stack:** TypeScript, Node.js ESM, pnpm workspace, npm pack/install, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-06-terminal-docs-local-release-roadmap-design.md`

## Global Constraints

- Do not restore or expose SDK, HTTP API, Server, or WebUI entry points.
- Publish nothing to a remote Registry in this plan.
- Keep all existing workspace manifests `private: true`.
- Local distribution identity is exactly `@nwlworkshop/schemanaut@0.1.0-alpha.2`.
- The package exposes only the `schemanaut` CLI and no JavaScript API exports.
- Preserve the user's existing dirty worktree and do not commit, reset, push, or clean unrelated files.
- Develop statically first and run verification once after the change set is integrated; do not use TDD.
- Never include credentials, `.env`, `.schemanaut`, state databases, caches, tests, source maps, old SDK/Server archives, or `tmp` in the tarball.

---

### Task 1: Product, architecture, and terminal documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/product/overview.md`
- Modify: `docs/architecture/*.md`
- Create: `docs/guides/terminal.md`
- Create: `docs/guides/terminal.zh-CN.md`
- Delete: `docs/guides/cli.md`
- Delete: `docs/guides/cli.zh-CN.md`
- Modify: `SECURITY.md`
- Create: `apps/terminal/README.md`
- Create: `packages/agent-host/README.md`
- Modify: `scripts/lib/public-documents.mjs`

**Interfaces:**
- Consumes: current CLI command contract from `apps/terminal/src/cli.ts` and `apps/terminal/src/interactive-cli.ts`.
- Produces: one consistent terminal-first documentation surface and the public-document allowlist consumed by packaging.

- [ ] Rewrite both root READMEs around local package installation, source fallback, five-minute first chat, current capabilities, limitations, and documentation links.
- [ ] Rewrite the documentation index and product overview so private Host internals are not described as a supported embedding API.
- [ ] Update the four architecture documents to remove deleted Facade/Server language while preserving Journal, Capability, model/context, and result boundaries.
- [ ] Write the complete bilingual terminal guide from the real command parser and interactive command handler; remove the superseded CLI guide files.
- [ ] Rewrite security guidance for project settings, model endpoints, MCP processes, filesystem/process tools, database credentials, and local state.
- [ ] Add maintainer READMEs for terminal and private agent-host boundaries.
- [ ] Update the public document allowlist to include only current paths.

### Task 2: CLI-only local npm package

**Files:**
- Create: `scripts/package-npm.mjs`
- Create: `scripts/verify-npm-package.mjs`
- Create: `scripts/lib/npm-package.mjs`
- Create: `scripts/tests/npm-package-contract.test.mjs`
- Modify: `package.json`
- Modify: `apps/terminal/package.json`
- Modify: `packages/*/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: compiled `dist` directories from the 12 current runtime workspaces and the public-document allowlist.
- Produces: `release/SchemaNaut-v0.1.0-alpha.2/schemanaut-v0.1.0-alpha.2.tgz`, checksum, provenance record, and an installed `schemanaut` executable.

- [ ] Set every current workspace and root version to `0.1.0-alpha.2` while preserving `private: true`.
- [ ] Implement shared release helpers for strict child-path checks, internal import rewriting, allowed-file validation, checksum calculation, and sensitive/residue scans.
- [ ] Implement staging and packing for a CLI-only `@nwlworkshop/schemanaut` manifest with external runtime dependencies, no `main` or `types`, and an empty `exports` map that blocks package subpath imports.
- [ ] Copy terminal/Host/internal compiled JavaScript, runtime JSON, core system Skills, database Skills, current docs, license, notices, and package metadata into staging.
- [ ] Generate SHA256 and `PROVENANCE.json` from exact package payload and source/build manifests.
- [ ] Implement installed-package verification in a temporary directory with `npm install` and real CLI commands; do not publish to a Registry, and report whether dependencies came from cache or the configured Registry.
- [ ] Add root commands `package:npm`, `verify:npm-package`, and `test:npm-package:contracts`; do not add any remote publish command in this scope.
- [ ] Add contract checks for package identity, CLI-only exports, runtime workspace coverage, forbidden files, import rewriting, and archive naming.
- [ ] Add the `0.1.0-alpha.2` changelog entry describing terminal-only distribution and known database/configuration limitations.

### Task 3: Capability and terminal UX roadmap report

**Files:**
- Create: `docs/product/roadmap.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: current package/code capability inventory and terminal UX audit.
- Produces: prioritized milestones with user scenarios, module ownership, safety boundaries, dependencies, and acceptance criteria.

- [ ] Record the current capability matrix without presenting internal-only database functionality as terminal-delivered.
- [ ] Explain the target terminal-to-private-Host-to-Control-Plane boundary and why SDK/API remain deferred.
- [ ] Prioritize secure first-run configuration and secret references before richer capability operations.
- [ ] Define five milestones: onboarding/configuration, capability/database vertical slice, Skills/MCP/permissions, recovery/observability, release hardening.
- [ ] Give each milestone concrete user workflows, package ownership, safety requirements, and observable acceptance criteria.
- [ ] Add measurable UX targets and a decision list for future planning.
- [ ] Link the report from the documentation index.

### Task 4: Integrated verification and review

**Files:**
- Verify all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: the integrated docs, package scripts, manifests, and tarball.
- Produces: fresh evidence for build, tests, docs, package contents, and installed CLI behavior.

- [ ] Run document-link validation and scans for deleted SDK/API/Server public claims.
- [ ] Run workspace version/private/importer consistency checks.
- [ ] Run the full terminal build and affected TypeScript typechecks.
- [ ] Run npm-package script contracts and existing script contracts.
- [ ] Run terminal and agent-host focused tests once after integration.
- [ ] Generate the local package and inspect its complete archive allowlist.
- [ ] Install the tarball in a fresh temporary project and execute all CLI smoke scenarios.
- [ ] Run a final independent review against the spec and fix every Critical or Important finding before reporting completion.
