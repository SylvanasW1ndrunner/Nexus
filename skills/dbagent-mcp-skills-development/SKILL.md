---
name: dbagent-mcp-skills-development
description: Implement or review DBAgent external MCP Server import, transport, process lifecycle, tool adaptation, health, user-importable Skills, SKILL.md bundles, matching, tool allowlists, or future DBAgent MCP Server exposure. Use for core-tools and core-skills extension work.
---

# DBAgent MCP and Skills Development

1. Read the Agent, MCP, Skills, security, and shared foundation sections in `docs/product-functional-overview.md`.
2. Preserve the distinction: MCP provides tools; Skills provide workflows.
3. Treat imported MCP servers and Skills as untrusted.
4. Namespace MCP tools, infer risk independently, enforce timeouts/health, resolve only Secret refs, and unregister tools on exit.
5. Parse Skill manifests deterministically. Intersect `allowed_tools` with registered tools and Runtime Policy; missing tools make a Skill unavailable.
6. Do not execute scripts found in a Skill bundle automatically.
7. Extension bundles may package MCP config and Skills, but they must enter their separate security boundaries.
8. Add lifecycle, malicious input, collision, permission, and clean shutdown tests.

Document whether a capability is core-only or exposed through SDK/API.
