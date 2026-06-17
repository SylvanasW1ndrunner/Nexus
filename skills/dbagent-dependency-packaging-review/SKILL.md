---
name: dbagent-dependency-packaging-review
description: Use when adding, upgrading, or evaluating DBAgent/Nexus dependencies, open-source libraries, native modules, runtime binaries, UI/editor/terminal components, database drivers, packaging assets, or release build changes.
---

# DBAgent Dependency And Packaging Review

Use this skill before introducing or changing a dependency that affects build size, licensing, offline use, native packaging, cross-platform behavior, or final installation experience.

## Required Reading

- `docs/product/05-development-guide.md` §5.0 and §13.
- `docs/product/07-design-principles.md` for lightweight and modular constraints.
- Feature-specific product docs.
- Current package manifests and builder configuration.

## Review Checklist

1. Purpose: what product capability the dependency enables.
2. Alternative: existing repo code, platform API, or smaller library.
3. License: compatible with closed-source commercial distribution.
4. Package impact: install size, bundled size, native binaries, optional dependencies.
5. Runtime impact: startup time, memory, CPU, background processes.
6. Cross-platform: Windows, Linux, macOS assumptions; path and shell behavior.
7. Offline behavior: can the packaged app work without network after install.
8. Security: credential handling, sandbox escape risk, supply-chain posture.
9. Test plan: integration tests proving the product path, not only library import.

## Decision Rules

- Prefer mature open-source libraries for commodity capabilities.
- Reject dependencies that make packaging brittle unless the feature cannot be delivered otherwise.
- Do not add UI libraries during the backend-first phase unless they are needed by retained non-UI utilities or future packaging tests.
- For native modules, require a packaging smoke test plan.
- For downloads at runtime, document cache, mirror, timeout, and offline failure behavior.

## Documentation

Record the decision in the relevant Chinese module doc or release note:

- Dependency name and version.
- License.
- Why it is used.
- Packaging and offline considerations.
- Known fallback or replacement path.
