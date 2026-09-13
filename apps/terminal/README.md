# SchemaNaut terminal maintainer notes

`apps/terminal` is the only supported SchemaNaut user entry point. Its workspace package remains private; the public
artifact is assembled as a CLI-only npm package by the repository release scripts. The terminal must not expose the
private Host or internal workspaces as an embedding API.

## Contract to preserve

- `src/cli.ts` owns the top-level parser: `chat` (default), `init`, `skills`, and `sessions`, plus
  `--project`/`-C` and `--help`/`-h`.
- `src/interactive-cli.ts` owns terminal interaction. Keep its help output and the user guide aligned whenever a
  slash command, prompt, approval, recovery, or keyboard behavior changes.
- The terminal creates a bundled private `AgentRuntime`; it must not offer the private Host as a public API or revive
  SDK, HTTP Server, or WebUI entry points.
- The sole global configuration is `~/.schemanaut/config.toml`: it supplies model connections, model defaults,
  default permission mode, and enterprise `allow`/`ask`/`deny` rules. `.schemanaut/settings.json` is limited to
  project MCP declarations and cannot override global policy. The CLI validates and displays configuration but does
  not add a Capability configuration surface.
- The bundled Host registers eight first-party Capability groups. Database remains one of those Capabilities rather
  than a separate terminal connection or query command.

## Local development

From the repository root:

```bash
pnpm build:terminal
node apps/terminal/dist/cli.js --help
node apps/terminal/dist/cli.js init ./scratch-project
node apps/terminal/dist/cli.js chat -C ./scratch-project
```

## Local npm candidate

Run `pnpm release:local` from the repository root. It performs a clean build, creates the CLI-only tarball, verifies
its package contract and checksum/provenance, installs it in a fresh isolated directory, and runs CLI smoke checks.
It does not publish to npm. The source workspace packages remain private, and the assembled package must contain the
complete internal Runtime closure without exposing internal package subpaths.
