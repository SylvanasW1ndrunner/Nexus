---
name: dbagent-release-version-discipline
description: Use when preparing DBAgent/Nexus commits, version branches, release folders, packaged artifacts, release notes, validation records, or beta delivery according to the project rule that main is committed first and version branches mirror release names.
---

# DBAgent Release Version Discipline

Use this skill for version-level work, release package preparation, or any task that touches branch/release policy.

## Release Rules

- Commit meaningful slices frequently.
- Author identity must remain `Chandler Niu`.
- Do not mention AI/Codex authorship in commits, docs, packages, release notes, or metadata.
- For each new version: commit on `main` first, then create or update a branch named exactly as the version.
- Keep release artifacts under `release/<version>/` or the project-approved release folder when automated upload is unavailable.

## Pre-Release Gate

Run or document:

- Typecheck for touched packages and desktop app if IPC/shared contracts changed.
- Targeted package tests.
- Full test suite when preparing an installable beta.
- Secret scan.
- Packaging smoke test when release artifacts are produced.
- App startup smoke test with minimal renderer host.

## Release Note Requirements

Write Chinese notes covering:

- Version name.
- New capabilities.
- Fixed defects.
- Known limitations.
- Test commands and results.
- Packaging output paths.
- Migration or configuration notes.

## Artifact Discipline

- Include only files a tester needs to install or unzip and run.
- Avoid committing transient caches, logs, local databases, credentials, or build temp directories.
- Verify artifact paths and checksums where practical.
- If automated upload is blocked, create the version folder and place the expected package contents there.

## Branch Discipline

Before branching or pushing:

1. `git status --short --branch`
2. Confirm no unrelated user changes are included.
3. Commit only the intended files.
4. Push the target branch.
5. Report commit hash, branch, artifact path, and validation status.
