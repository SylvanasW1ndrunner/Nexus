# Bundled Workspace Search Runtime

**Date:** 2026-09-13
**Status:** accepted for the Alpha 3 release repair

## Decision

`workspace_search` is an always-loaded base Tool. Its normal search path must
work immediately after SchemaNaut is installed; it must not rely on a separately
installed host `rg` executable. `@vscode/ripgrep@1.18.0` is therefore a direct
runtime dependency of `@dbagent/core-tools` and of the published terminal
package. The Tool's ripgrep adapter uses the package's platform-selected
`rgPath` by default.

The adapter continues to accept `options.executable`. This is a Host/test
override, not user configuration: it supports a certified alternative runtime
or deterministic test fixture. If that explicit executable cannot be started,
the established `ripgrep_not_found` / `unavailable` result remains truthful.
This fallback is retained for unsupported or damaged installations; it is not
the ordinary installed-product path.

## Why this is product work

The Tool is in the fixed first-Turn set, not an optional Capability activated
after environment discovery. Returning `unavailable` on a fresh supported
SchemaNaut installation contradicts that product promise. GitHub's Ubuntu
24.04 runner does not include ripgrep, which exposed the hidden host dependency
in the original CI test. Installing an operating-system package only in CI
would make CI green while leaving the same first-use failure possible for
users.

## Alternatives considered

1. **Require users and CI to install `rg`.** Rejected: this is appropriate for
   optional external Capabilities such as Forge or language tools, but not for
   a permanently exposed base Tool.
2. **Install ripgrep with apt/choco/brew in CI.** Rejected as the product fix:
   it verifies a special CI image rather than the npm-distributed runtime and
   is not portable to user installations.
3. **Implement a Node-only search engine.** Rejected for this slice: it would
   duplicate ripgrep's literal/regex, ignore, glob, binary and Unicode
   semantics while increasing maintenance risk.
4. **Bundle `@vscode/ripgrep@1.18.0`.** Chosen: it is MIT licensed, maintained
   by the VS Code ecosystem, publishes platform binary packages through npm,
   and exports the selected executable path without a postinstall hook or
   runtime download.

## Distribution and platform boundary

The small selector package declares optional platform packages for Windows,
Linux and macOS. The release package manager resolves only the matching binary
for the installation platform; it does not ship every platform binary in one
installation. Current unpacked binary sizes are approximately 4.5--5.7 MB per
supported platform (about 5--6 MB in the common case). The supported selector
variants include x64 and arm64 for Windows, Linux and macOS; Linux additionally
has ia32, arm and several server architectures. Unsupported architectures or a
damaged optional dependency retain the explicit unavailable result rather than
silently switching semantics.

All search execution remains local: the selected binary is installed with the
npm package, works after installation without network access, and is launched
with `shell: false` over the existing private workspace snapshot. This change
does not add a remote search service, telemetry, configuration file, runtime
download, or third-party type to a public SchemaNaut contract.

## Verification boundary

The focused Tool test must exercise the default bundled executable and find a
known workspace match. A separate focused adapter test must inject a known
missing executable and assert the existing `ripgrep_not_found` unavailable
contract. npm-package contracts must confirm the selector dependency is present
in the public manifest so the packaged terminal can resolve it offline.

The release installer additionally creates a minimal fixture **after**
installing the generated tarball, imports the installed package's sealed
`dist/internal/core-tools` factory by absolute file URL, and executes the
ordinary default `workspace_search` path against that fixture. The assertion
must find the known text and must not provide an executable override, modify
`PATH`, or invoke a host `rg`. This proves the distributed module can resolve
the npm-selected platform binary from the installed package dependency graph;
it is distinct from the source-workspace Tool test.
