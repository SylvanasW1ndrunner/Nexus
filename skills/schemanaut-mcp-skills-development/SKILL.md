---
name: schemanaut-mcp-skills-development
description: Implement or review SchemaNaut external MCP Server import, transport, process lifecycle, tool adaptation, health, user-importable Skills, SKILL.md bundles, matching, tool allowlists, or future SchemaNaut MCP Server exposure. Use for core-tools and core-skills extension work.
---

# SchemaNaut MCP and Skills Development

1. Read `docs/architecture/capabilities-tools-skills-mcp.md` and `docs/architecture/model-context-settings.md`.
2. Preserve the distinction: MCP provides tools; Skills provide workflows.
3. Treat imported MCP servers and Skills as untrusted.
4. Namespace MCP tools, infer risk independently, enforce timeouts/health, resolve only Secret refs, and unregister tools on exit.
5. Parse Skill manifests deterministically. Intersect `allowed_tools` with registered tools and Runtime Policy; missing tools make a Skill unavailable.
6. Do not execute scripts found in a Skill bundle automatically.
7. Extension bundles may package MCP config and Skills, but they must enter their separate security boundaries.
8. Add lifecycle, malicious input, collision, permission, and clean shutdown tests.

Document how the internal host publishes contributions and how terminal users discover them.
