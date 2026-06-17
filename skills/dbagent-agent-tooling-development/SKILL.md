---
name: dbagent-agent-tooling-development
description: Use when implementing DBAgent/Nexus Agent runtime, tool registry, permission manager, LLM router, session manager, memory, sub-agent pool, built-in tools, MCP integration, streaming, checkpoints, and agent behavior tests.
---

# DBAgent Agent And Tooling Development

Use this skill for Agent-side runtime and tool work. During the current development mode, implement backend/service behavior first and do not rebuild renderer UI.

## Required Product Docs

- `docs/product/03-agent-design.md`
- `docs/product/02-rag-design.md` when Agent uses schema context
- `docs/product/04-config-design.md` when providers/MCP/settings are involved
- `docs/product/10-usage-and-subscription.md` when LLM calls or rounds are involved
- `docs/product/09-error-recovery.md` for checkpoints and stream recovery

## Product Positioning

- DBAgent Agent is an engineer assistant, not a simple Text2SQL bot.
- The Agent should plan, inspect schema/context, use tools, produce artifacts, and explain risk.
- Agent functionality must be backend-testable before final UI exists.

## Runtime Components

- Orchestrator: owns round lifecycle.
- Strategy layer: ReAct first, then Plan&Execute, Reflexion, and sub-agent parallelism.
- LLM router: BYOK and subscription-managed branches.
- Tool registry: typed tool definitions, permissions, validation, result schemas.
- Permission manager: ask, auto, full-auto, readonly modes.
- Session manager: durable SQLite/local state for conversations and checkpoints.
- Usage tracker: record every round and model/tool usage.
- Skill execution policy: when a run is created from a Skill, enforce its `allowed_tools` as a runtime allowlist, not only as prompt guidance.

## Tooling Boundaries

- Built-in DB tools must use core-db contracts.
- Workspace/file tools must respect workspace boundaries.
- Shell/Python tools need timeouts, output limits, cancellation, and permission gates.
- MCP tools need health checks and explicit enable/disable state.
- Agent must never execute a hidden tool call that was not exposed or allowed for the current run.

## Testing Requirements

- Assert tool calls, permissions, state transitions, checkpoints, and usage records.
- Do not assert exact LLM prose except for stable contract snippets.
- Include aborted rounds, failed tool calls, partial stream recovery, and retry behavior.
- Use fake LLM providers for deterministic orchestration tests; use real provider tests only behind explicit env gates.
- Include tests that assert disallowed tools are not exposed to the model and are denied if a provider still returns them.
