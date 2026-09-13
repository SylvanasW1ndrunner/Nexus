import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../run-context-compaction-live-test.mjs', import.meta.url),
);

test('context compaction live command exercises the canonical lifecycle without legacy Session APIs', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /ContextLifecycle/);
  assert.match(source, /ModelExecutionGateway/);
  assert.match(source, /prepareModelSessionBundle/);
  assert.match(source, /TEST_SILICONFLOW_API_KEY/);
  assert.match(source, /Live summary quality only/);

  assert.doesNotMatch(source, /loadEnvFile/);
  assert.doesNotMatch(source, /DBAGENT_/);
  assert.doesNotMatch(source, /compactAgentSession/);
  assert.doesNotMatch(source, /runtime\.sessions/);
  assert.doesNotMatch(source, /createAgentSession/);
  assert.doesNotMatch(source, /agentContextCheckpoints/);
});
