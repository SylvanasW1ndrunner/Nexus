# Packaging Strategy

DBAgent is a desktop product, so dependency choices must preserve a reliable Electron package.

## Rules

- Keep runtime dependencies narrow and explicit.
- Keep test, lint, build, and Docker-only dependencies in `devDependencies`.
- Do not bundle backend services into the desktop app.
- Keep native modules isolated behind package boundaries so packaging problems are localized.
- Prefer lazy loading for heavy capabilities such as future RAG embeddings, MCP servers, and Python.
- Treat the packaged Electron app as the release artifact. Development-only success in Vite,
  Vitest, or a renderer browser session does not prove the app bundle can start.

## Current Runtime Dependencies

- Electron and React for the desktop shell.
- `pg` for PostgreSQL access.
- Zustand for lightweight renderer state once UI state grows.

## Electron Dependency Risks

- Electron, preload scripts, and main-process modules run under a different resolution and file
  layout after packaging. Any import that depends on source paths, workspace symlinks, or unbuilt
  packages must be caught before release.
- Native or optional dependencies must be checked in the packaged artifact on each target platform.
  If a dependency requires rebuilds, the rebuild step belongs in the desktop packaging pipeline, not
  in application startup.
- PostgreSQL support should keep `pg` and related code inside the database package boundary so the
  desktop app imports one stable interface instead of spreading driver-specific requirements across
  main and renderer code.
- Docker Compose, PostgreSQL test containers, fixture loaders, and CI-only helpers must never be
  included in the final app bundle.

## Final Bundle Constraints

- The bundle should include compiled application code, production runtime dependencies, static UI
  assets, and Electron metadata only.
- The bundle should exclude source maps intended only for internal debugging, integration-test
  fixtures, Docker files, generated coverage, local database files, `.env` files, and developer
  scripts that are not part of app startup.
- No database server, model server, MCP server, Python runtime, or embedding index should be bundled
  for M0-M1.5. Those capabilities can be installed or configured later through explicit user flows.
- Packaged app verification must check startup, IPC handler registration, auth status, usage status,
  and at least one PostgreSQL connection test from the installed artifact.
- Password storage currently uses Electron `safeStorage`; release QA must verify encryption
  availability on Windows, macOS, and Linux.
- Renderer-only features such as CSV export should remain browser-native and dependency-free unless
  a future export format genuinely requires a runtime package.
- Workspace recovery state is stored as a small JSON file in Electron `userData`; it must stay out
  of the packaged ASAR and should be treated as user data during installer/uninstaller QA.

## Packaging Command

```bash
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop package
```

The current `electron-builder` configuration packages `dist/**` into ASAR and emits platform
installers under `apps/desktop/release`.

## Current Verification

On Windows, `pnpm --filter @dbagent/desktop package` produced:

- `apps/desktop/release/DBAgent Setup 0.1.0.exe`
- Installer size: 71.51 MB

This is below the product target of a sub-200 MB installer for the M0-M1.5 baseline.
