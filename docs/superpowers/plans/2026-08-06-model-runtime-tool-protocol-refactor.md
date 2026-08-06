# Model Runtime And Tool Protocol Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fabricated model limits and textual Tool Calls with a metadata-driven, protocol-correct model runtime, configurable generation options, deterministic Tool execution, and durable CLI traces.

**Architecture:** `core-llm` owns the canonical message, generation and model-catalog contracts plus Provider-specific wire adapters. `core-agent` consumes only canonical messages, performs run-scoped Tool Call idempotency, and bases automatic compaction on known physical limits. `sdk` and `apps/server` expose one generation configuration and preserve the existing independent database-result pipeline.

**Tech Stack:** TypeScript 5.7, Node.js 22+, Vitest, native Fetch, models.dev snapshot, PostgreSQL integration fixtures, SiliconFlow OpenAI-compatible API.

## Global Constraints

- Do not add LiteLLM or a mandatory runtime metadata network call.
- Do not serialize Tool Calls as XML, DSML, Markdown, or ordinary assistant text.
- Do not use a fabricated context-window fallback.
- Do not store complete database rows in Session or user preferences.
- Do not change read/edit/full database permission semantics.
- Do not print or persist API keys in reports, logs, fixtures, docs, or commits.
- Preserve the user's existing README and `scripts/dev-db/schemanaut-demo.sql` working-tree changes.

---

### Task 1: Model catalog, unknown limits, and generation contracts

**Files:**
- Create: `packages/core-llm/src/model-catalog.ts`
- Create: `packages/core-llm/src/model_prices_and_context_window.json`
- Create: `scripts/update-model-catalog.mjs`
- Modify: `packages/core-llm/src/types.ts`
- Modify: `packages/core-llm/src/model-registry.ts`
- Modify: `packages/core-llm/src/index.ts`
- Modify: `packages/core-llm/tsconfig.json`
- Modify: `scripts/package-npm.mjs`
- Test: `packages/core-llm/test/model-catalog.test.ts`
- Test: `packages/core-llm/test/model-routing.test.ts`

**Interfaces:**
- Produces `LlmGenerationConfig`, `LlmGenerationParameterSupport`, nullable `LlmModelLimits`, `ModelCatalog`, and `resolveModelCatalogMetadata()`.
- Consumed by every later task through `LlmModelRegistry.registerModel()` and `RegisteredLlmModel`.

- [ ] **Step 1: Write failing catalog and unknown-limit tests**

```ts
it('keeps unknown physical limits unknown', () => {
  const model = registry.registerModel({ providerId: 'proxy', model: 'renamed-model' });
  expect(model.limits).toEqual({
    contextTokens: null,
    maxInputTokens: null,
    maxOutputTokens: null,
  });
});

it('resolves canonical metadata and lets endpoint fields win', () => {
  const model = registry.registerModel({
    providerId: 'proxy',
    model: 'renamed-model',
    canonicalModel: 'deepseek/deepseek-chat',
  });
  registry.applyModelMetadata(model.id, endpointMetadata({ contextTokens: 96_000 }));
  expect(registry.model(model.id)?.limits.contextTokens).toBe(96_000);
});
```

- [ ] **Step 2: Run the tests and confirm they fail because limits still default to 32K and no catalog resolver exists**

Run: `pnpm --filter @dbagent/core-llm exec vitest run test/model-catalog.test.ts test/model-routing.test.ts`

- [ ] **Step 3: Implement the contracts and resolver**

```ts
export type LlmGenerationConfig = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  seed?: number;
  stop?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high';
};

export type LlmModelLimits = {
  contextTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrency?: number;
};
```

The resolver must merge snapshot and endpoint fields independently and record all contributing metadata sources.

- [ ] **Step 4: Add and run the catalog update script**

The script fetches `https://models.dev/api.json`, validates every retained field, writes deterministic sorted JSON, records source URL and generation time, and never runs at package startup.

Run: `node scripts/update-model-catalog.mjs`

- [ ] **Step 5: Run catalog, registry, package-copy, typecheck and size assertions**

Run: `pnpm --filter @dbagent/core-llm test && pnpm --filter @dbagent/core-llm typecheck`

### Task 2: Lossless canonical Tool messages

**Files:**
- Modify: `packages/core-llm/src/types.ts`
- Modify: `packages/core-llm/src/prompt-runtime.ts`
- Modify: `packages/core-llm/src/response-cache.ts`
- Modify: `packages/core-agent/src/context-manager.ts`
- Modify: `packages/core-agent/src/session-store.ts` only if the existing representation cannot round-trip the new fields
- Test: `packages/core-agent/test/context-manager.test.ts`
- Test: `packages/core-agent/test/session-store.test.ts`
- Test: `packages/core-llm/test/response-cache.test.ts`

**Interfaces:**
- Extends `LlmMessage` with `toolCalls` and typed Tool result status.
- Produces a complete Assistant -> Tool message group for Provider adapters.

- [ ] **Step 1: Write a failing round-trip test**

```ts
expect(buildAgentContext(sessionWithToolCall, [], options).messages).toContainEqual({
  role: 'assistant',
  content: 'I will inspect the schema.',
  toolCalls: [{ id: 'call-7', name: 'schema_describe', arguments: { table: 'orders' } }],
});
expect(JSON.stringify(messages)).not.toContain('<tool_calls>');
```

- [ ] **Step 2: Verify the current implementation fails by emitting XML text**

Run: `pnpm --filter @dbagent/core-agent exec vitest run test/context-manager.test.ts`

- [ ] **Step 3: Preserve typed Tool Calls through context, token estimation, cache keys and persistence**

`toLlmMessage()` must copy redacted structured calls, not append markup. Token estimates and cache fingerprints must include call names, IDs and arguments.

- [ ] **Step 4: Run context, Session and cache tests**

Run: `pnpm --filter @dbagent/core-agent exec vitest run test/context-manager.test.ts test/session-store.test.ts`

Run: `pnpm --filter @dbagent/core-llm exec vitest run test/response-cache.test.ts`

### Task 3: Provider protocol adapters and parameter errors

**Files:**
- Create: `packages/core-llm/src/openai-responses-provider.ts`
- Create: `packages/core-llm/src/ollama-provider.ts`
- Create: `packages/core-llm/src/tool-protocol.ts`
- Modify: `packages/core-llm/src/openai-compatible-provider.ts`
- Modify: `packages/core-llm/src/anthropic-provider.ts`
- Modify: `packages/core-llm/src/provider-protocol-profile.ts`
- Modify: `packages/core-llm/src/provider-presets.ts`
- Modify: `packages/core-llm/src/index.ts`
- Test: `packages/core-llm/test/provider-tool-protocols.test.ts`
- Test: `packages/core-llm/test/openai-compatible-provider.test.ts`
- Test: `packages/core-llm/test/provider-adapters.test.ts`
- Test: `packages/core-llm/test/stream-safety.test.ts`

**Interfaces:**
- Consumes canonical `LlmMessage` and `LlmGenerationConfig`.
- Produces typed `LlmChatResponse` or `LlmProviderError('TOOL_PROTOCOL_MISMATCH' | 'LLM_PARAMETER_UNSUPPORTED')`.

- [ ] **Step 1: Write failing request-shape tests for all four protocols**

```ts
expect(openAiBody.messages[1]).toMatchObject({
  role: 'assistant',
  tool_calls: [{ id: 'call-1', type: 'function' }],
});
expect(anthropicBody.messages[1].content[0]).toMatchObject({
  type: 'tool_result',
  tool_use_id: 'call-1',
});
expect(ollamaBody.messages[1]).toMatchObject({ role: 'tool', tool_name: 'query_database' });
expect(responsesBody.input).toContainEqual(expect.objectContaining({ type: 'function_call_output' }));
```

- [ ] **Step 2: Verify the tests fail because OpenAI drops Assistant calls and Anthropic flattens results into text**

Run: `pnpm --filter @dbagent/core-llm exec vitest run test/provider-tool-protocols.test.ts`

- [ ] **Step 3: Implement exact wire mappings, parallel calls and fragmented streaming arguments**

OpenAI/vLLM use Chat Completions objects, Responses uses item objects, Anthropic groups adjacent Tool Results in the immediate User message, and Ollama uses native `/api/chat` names. Missing provider IDs receive deterministic adapter-local IDs.

- [ ] **Step 4: Add protocol mismatch and unsupported-parameter normalization**

```ts
if (toolsRequested && hasTextualToolMarkup(response.text) && response.toolCalls.length === 0) {
  throw new LlmProviderError(
    'TOOL_PROTOCOL_MISMATCH',
    'The endpoint returned textual tool markup instead of a structured Tool Call.',
    false,
  );
}
```

Known unsupported generation parameters fail before Fetch; unknown parameters are sent and upstream 400 responses preserve a sanitized, typed cause.

- [ ] **Step 5: Run all core-llm tests and typecheck**

Run: `pnpm --filter @dbagent/core-llm test && pnpm --filter @dbagent/core-llm typecheck`

### Task 4: Metadata-aware context compression and shared generation config

**Files:**
- Modify: `packages/core-agent/src/types.ts`
- Modify: `packages/core-agent/src/context-manager.ts`
- Modify: `packages/core-agent/src/react-agent.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/runtime.ts`
- Test: `packages/core-agent/test/context-manager.test.ts`
- Test: `packages/core-agent/test/react-agent.test.ts`
- Test: `packages/sdk/test/runtime.test.ts`

**Interfaces:**
- Consumes nullable model limits and `LlmGenerationConfig`.
- Produces automatic compression only when a physical input capacity is known; preserves manual compression.

- [ ] **Step 1: Write failing unknown-window and generation-inheritance tests**

```ts
expect(buildAgentContext(longSession, [], {}).requiresCompaction).toBe(false);
expect(buildAgentContext(longSession, [], {}).compression.modelContextTokens).toBeNull();
expect(capturedAgentRequest.temperature).toBe(0.35);
expect(capturedCompactionRequest.temperature).toBe(0.35);
```

- [ ] **Step 2: Verify the tests fail because Agent defaults to 32K and compaction hardcodes temperature zero**

Run: `pnpm --filter @dbagent/core-agent exec vitest run test/context-manager.test.ts test/react-agent.test.ts`

- [ ] **Step 3: Implement nullable-window branches and one merged generation config**

Unknown windows skip automatic masking/compaction. Manual compaction uses a documented internal batch ceiling without claiming it is the model limit. Runtime defaults merge with per-run overrides and apply to Agent, NL2SQL and compaction; internal calls may only reduce `maxOutputTokens`.

- [ ] **Step 4: Run core-agent and SDK tests**

Run: `pnpm --filter @dbagent/core-agent test && pnpm --filter @dbagent/sdk test`

### Task 5: Run-scoped Tool Call idempotency and convergence

**Files:**
- Create: `packages/core-agent/src/tool-call-ledger.ts`
- Modify: `packages/core-agent/src/react-agent.ts`
- Modify: `packages/core-agent/src/types.ts`
- Test: `packages/core-agent/test/tool-call-ledger.test.ts`
- Test: `packages/core-agent/test/react-agent.test.ts`

**Interfaces:**
- Produces `AgentToolCallLedger.observe(call)` returning `fresh`, `replay`, or `conflict`.
- Consumed before read-only pre-execution and before permission checks.

- [ ] **Step 1: Write failing exactly-once tests**

```ts
expect(handlerCalls).toBe(1);
expect(result.toolExecutions).toHaveLength(1);
expect(modelHistory.filter(isToolResultFor('same-id'))).toHaveLength(2);
```

Also assert that the same arguments with `new-id` can execute twice and that reusing one ID with changed arguments fails as a protocol conflict.

- [ ] **Step 2: Verify repeated IDs currently execute more than once**

Run: `pnpm --filter @dbagent/core-agent exec vitest run test/tool-call-ledger.test.ts test/react-agent.test.ts`

- [ ] **Step 3: Add the ledger, remove textual-markup retry instructions, and raise the default emergency limit to 100**

Every success, failure and denial is recorded in the ledger. Replay appends the saved Tool Result to the next model context without invoking the Tool. A `TOOL_PROTOCOL_MISMATCH` is surfaced immediately. Max iteration exhaustion remains checkpointed and resumable.

- [ ] **Step 4: Run Agent tests, behavior evaluations and performance benchmark**

Run: `pnpm --filter @dbagent/core-agent test`

Run: `pnpm test:agent-runtime:performance`

### Task 6: Project settings, SDK/API configuration, and CLI trace interaction

**Files:**
- Create: `apps/server/src/project-settings.ts`
- Modify: `apps/server/src/interactive-cli.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/cli.ts`
- Modify: `packages/core-agent/src/user-events.ts`
- Modify: `packages/core-agent/src/react-agent.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/runtime.ts`
- Test: `apps/server/test/project-settings.test.ts`
- Test: `apps/server/test/interactive-cli.test.ts`
- Test: `apps/server/test/server.test.ts`
- Test: `packages/sdk/test/runtime.test.ts`

**Interfaces:**
- Reads `.schemanaut/settings.json` plus `SCHEMANAUT_LLM_*` overrides.
- Exposes SDK runtime defaults and per-run generation overrides.
- Produces a buffered `CliTraceRenderer.finish()` and `toggleExpanded()` API.

- [ ] **Step 1: Write failing configuration and trace tests**

```ts
expect(config.generation).toEqual({ temperature: 0.2, topP: 0.9 });
expect(() => parseSettings({ llm: { contextWindow: 123 } })).toThrow(/read-only/i);

trace.start();
trace.render(sqlPreparedEvent);
trace.finish(summary);
trace.toggleExpanded();
expect(stripAnsi(output)).toContain('select * from orders');
```

- [ ] **Step 2: Verify the current CLI deletes TTY traces and ignores project model settings**

Run: `pnpm --filter @dbagent/server exec vitest run test/project-settings.test.ts test/interactive-cli.test.ts`

- [ ] **Step 3: Implement strict settings merge and protocol-aware Provider creation**

Supported protocols are `openai-chat`, `openai-responses`, `anthropic`, `ollama`, and `vllm`. Environment values override project settings. Secrets remain environment-only.

- [ ] **Step 4: Implement meaningful structured progress and Ctrl+O**

Tool descriptions include relevant resource/query/path but exclude IDs, hashes, scores and secrets. TTY traces are buffered, collapsed after finalization and re-openable; non-TTY logs remain durable.

- [ ] **Step 5: Run server, SDK and public-entrypoint tests**

Run: `pnpm --filter @dbagent/server test && pnpm --filter @dbagent/sdk test`

### Task 7: Database-result pipeline and regression gates

**Files:**
- Modify only if a regression test exposes a bug: `packages/core-agent/src/tool-result.ts`, `packages/core-tools/src/ai-sql-tools.ts`, `packages/sdk/src/runtime.ts`
- Test: `packages/sdk/test/postgres.integration.test.ts`
- Test: `packages/sdk/test/postgres-scenarios.integration.test.ts`
- Test: `packages/core-agent/test/react-agent.test.ts`
- Test: `scripts/run-agent-protocol-live-test.mjs`

**Interfaces:**
- Verifies existing `AgentToolResultEnvelope`, `InteractiveQueryResult`, and Result Handle contracts remain unchanged.

- [ ] **Step 1: Add regression assertions for 100-row model projection, 1,000-row user payload and zero durable full-row copies**

The expected values are literal and derived from a PostgreSQL fixture larger than both boundaries.

- [ ] **Step 2: Run with real PostgreSQL and confirm the tests exercise database execution rather than mocks**

Run: `pnpm test:postgres`

- [ ] **Step 3: Run AI SQL, database and context performance suites**

Run: `pnpm test:database-platform:performance`

Run: `pnpm test:ai-sql:performance`

### Task 8: SiliconFlow multi-model live acceptance

**Files:**
- Create: `scripts/run-agent-protocol-live-test.mjs`
- Create: `docs/test-model-runtime-tool-protocol.md`
- Modify: `package.json`

**Interfaces:**
- Reads credentials only from the current process or local `.env`.
- Writes sanitized JSON reports under ignored `.test-logs/`.

- [ ] **Step 1: Discover currently available SiliconFlow models without printing credentials**

Select at least three different model families that advertise Tool Calling. The report records exact IDs and metadata sources; it does not hardcode future availability as a test invariant.

- [ ] **Step 2: Run direct protocol continuation against each model**

Each model must issue a structured Tool Call, receive the typed Tool Result, and produce a final answer without markup leakage. Capture TTFT when streaming is supported, total latency, tokens and finish reason.

- [ ] **Step 3: Run real Agent scenarios**

- Simple Schema listing: target at most 2 model calls and 1 relevant metadata tool.
- E-commerce analysis: database performs aggregation; final answer cites the independent result payload.
- Kafka JSON inspection: bounded samples, structured SQL, no duplicate Tool Call IDs.
- Context reading: recover hand-checked markers from a bounded multi-section prompt and report the resolved model context; never label unknown as 32K.

- [ ] **Step 4: Inspect every report for prior failures**

Assert zero textual Tool Calls, zero conflicting/repeated executions, no incomplete final wording, no hidden full result in Session, and no API key patterns. Any model incompatibility must be classified as model/endpoint/protocol/code with raw sanitized evidence.

### Task 9: Documentation, packaging, and final verification

**Files:**
- Modify: `docs/foundation/01-llm-platform.md`
- Modify: `docs/agent/02-adaptive-loop-planning-verification.md`
- Modify: `docs/agent/03-tools-results-artifacts.md`
- Modify: `docs/agent/05-cli-user-experience.md`
- Modify: `docs/cli/README.md`
- Modify: `docs/cli/README.zh-CN.md`
- Modify: `docs/sdk/api-reference.md`
- Modify: `docs/sdk/api-reference.zh-CN.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`

**Interfaces:**
- Documents exact configuration names, precedence, error modes, protocol selection and test evidence.

- [ ] **Step 1: Update human and engineering documentation with runnable examples**

Examples show one generation block, a canonical model alias, protocol selection, unknown context behavior, `/trace`, Ctrl+O, and Result Handle boundaries. No real credentials are included.

- [ ] **Step 2: Run touched-package typechecks, lint and tests**

Run: `pnpm --filter @dbagent/core-llm typecheck && pnpm --filter @dbagent/core-agent typecheck && pnpm --filter @dbagent/sdk typecheck && pnpm --filter @dbagent/server typecheck`

Run: `pnpm --filter @dbagent/core-llm lint && pnpm --filter @dbagent/core-agent lint && pnpm --filter @dbagent/sdk lint && pnpm --filter @dbagent/server lint`

Run: `pnpm --filter @dbagent/core-llm test && pnpm --filter @dbagent/core-agent test && pnpm --filter @dbagent/sdk test && pnpm --filter @dbagent/server test`

- [ ] **Step 3: Build, package and verify the public archive**

Run: `pnpm build:server`

Run: `pnpm test:npm-package:functional`

- [ ] **Step 4: Run secret and stale-pattern scans**

Scan tracked files for live credential formats and runtime-generated `<tool_calls>` serialization. Test fixtures may contain clearly synthetic placeholders only.

- [ ] **Step 5: Re-read the design and record exact evidence for every acceptance item**

Report commands, pass/fail counts, live model IDs, metrics, skipped tests and residual risks. Do not claim completion from partial output.
