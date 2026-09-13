import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../run-context-compaction-benchmark.mjs', import.meta.url),
);

test('context benchmark measures the bounded journal lifecycle instead of the deleted Session store', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /decideContextLifecycle/);
  assert.match(source, /readBoundedCommittedContext/);
  assert.match(source, /PromptRuntime/);
  assert.match(source, /10_000/);

  assert.doesNotMatch(source, /AgentSessionStore/);
  assert.doesNotMatch(source, /createAgentSession/);
  assert.doesNotMatch(source, /appendMessage/);
  assert.doesNotMatch(source, /buildAgentContext/);
  assert.doesNotMatch(source, /createAgentContextCompactionPlan/);
});
