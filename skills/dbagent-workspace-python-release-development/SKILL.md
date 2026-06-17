---
name: dbagent-workspace-python-release-development
description: Use when implementing DBAgent/Nexus workspace, Python runtime, script execution, skill loading, plugin-like extension points, terminal/process behavior, packaging, release artifacts, diagnostics, and end-to-end validation before version branches or release folders.
---

# DBAgent Workspace, Python, Release Development

Use this skill for workspace, Python execution, extension packaging, diagnostics, and release readiness. During the current development mode, implement backend/process behavior first and leave renderer UI reconstruction deferred.

## Required Product Docs

- `docs/product/08-workspace-design.md`
- `docs/product/09-error-recovery.md`
- `docs/product/05-development-guide.md`
- `docs/product/07-design-principles.md`

Read plugin/Agent docs when scripts become tools:

- `docs/product/03-agent-design.md`

## Workspace Rules

- Workspace is a real directory with `.dbagent/`, `queries/`, `scripts/`, `skills/`, `docs/`, `outputs/`, and SQL artifacts where relevant.
- Workspace metadata must be portable and avoid absolute paths unless unavoidable.
- Atomic writes and autosave are required for user-authored artifacts.
- Startup should support recent workspaces and crash recovery, but full UI is deferred.

## Python Runtime

- Support system Python, venv, conda, and later embedded/docker modes at the contract level.
- Environment detection and explicit path selection must be separate concepts.
- Script execution needs cwd, env, timeout, output capture, cancellation, and resource limits.
- Python package/dependency handling must consider final app packaging and offline/enterprise users.
- Do not assume Python is globally on PATH; support configured interpreter paths and bundled/runtime discovery.

## Terminal And Process Behavior

- Treat terminal as a process/session service, not a renderer-only text box.
- Support spawn, input, resize, output stream, exit, kill, and multiple sessions.
- Tests should validate process IO without depending on final UI.
- Terminal tests must prove interactive stdin/stdout behavior, not only process creation.

## Release Readiness

- Keep installer/package size and startup performance in mind before adding dependencies.
- Generate release artifacts or release-folder contents according to the current version process.
- Keep version branch behavior consistent: main first, then version branch.
- Include Chinese release notes and test notes.

## Testing Requirements

- Workspace create/open/read/write/recover.
- Python env detection, invalid interpreter, script success/failure/timeout/cancel.
- Terminal spawn/input/output/exit/kill with real shell commands.
- Plugin/skill discovery from workspace folders.
- Packaging smoke test where feasible.
