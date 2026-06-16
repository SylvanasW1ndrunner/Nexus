---
name: dbagent-feature-first-development
description: Use when developing DBAgent/Nexus under the current feature-first path: read product docs, choose the next backend capability, avoid rebuilding frontend UI, update Chinese engineering docs, run verification, commit under Chandler Niu, and preserve release discipline.
---

# DBAgent Feature-First Development

Use this skill before starting a new DBAgent/Nexus development task when the task is not purely cosmetic.

## Sources

Read only the documents needed for the requested feature:

- Product entry: `docs/product/README.md`
- Development rules: `docs/product/05-development-guide.md`
- Classic IDE features: `docs/product/06-classic-features.md`
- Workspace/Python: `docs/product/08-workspace-design.md`
- Error recovery: `docs/product/09-error-recovery.md`
- Usage/subscription: `docs/product/10-usage-and-subscription.md`
- Latest implementation notes: `docs/engineering/`

## Current Direction

- Implement all backend/core capabilities first.
- Keep renderer UI as a minimal health host until the final UI rebuild phase.
- Do not reintroduce the old IDE UI, old project tree, old agent panel, old terminal UI, or old login modal.
- Prefer reusable core packages over Electron-bound code.
- Keep docs in Chinese until the user asks for English docs.

## Development Flow

1. Check branch and worktree with `git status --short --branch`.
2. Identify the relevant product docs and existing package boundaries.
3. Implement in core packages first; expose through typed IPC only when desktop integration is required.
4. Add or update Chinese module docs before or with the code change.
5. Write tests that reflect real user workflows, not only unit-level happy paths.
6. Run the narrow test first, then the package/app-level verification.
7. Commit meaningful slices with author `Chandler Niu`.

## Quality Gates

- No core package may depend on Electron.
- IPC types must remain typed and stable.
- Feature behavior must be accessible without relying on final UI.
- Tests must include error paths, cancellation/timeouts, persistence, and recovery where relevant.
- Packaging implications must be considered before adding dependencies.

## Commit Discipline

- Use concise commit messages that describe the product change.
- Do not mention Codex or AI authorship in commit messages, docs, or release notes unless the user explicitly asks.
- If a version branch is involved, commit on `main`, then create or update the version branch according to the project's release rule.
