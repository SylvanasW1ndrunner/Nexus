import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../run-context-compaction-live-test.mjs', import.meta.url),
);

test('context compaction live command binds its Session to the Runtime Project', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /projectDirectory:\s*temporaryDirectory/);
  assert.match(
    source,
    /agentProjectReference\(createAgentProjectContext\(temporaryDirectory\)\)/,
  );
  assert.match(source, /createAgentSession\(\{[\s\S]*project,/);
});
