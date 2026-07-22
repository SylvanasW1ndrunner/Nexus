import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = [
  'package.json',
  'pnpm-workspace.yaml',
  'apps/server/package.json',
  'packages/sdk/src/runtime.ts',
  'packages/shared/src/runtime-contracts.ts',
  'packages/core-db/src/sql-safety.ts',
  'packages/core-skills/src/skill-registry.ts',
  'packages/core-tools/src/mcp-runtime-manager.ts',
  'docs/product-functional-overview.md',
];

for (const path of required) {
  assert.ok(existsSync(join(root, path)), `missing ${path}`);
}

const sqlSafety = readFileSync(join(root, 'packages/core-db/src/sql-safety.ts'), 'utf8');
for (const keyword of ['DELETE', 'DROP', 'TRUNCATE', 'readOnly']) {
  assert.ok(sqlSafety.includes(keyword), `sql safety should mention ${keyword}`);
}

const contracts = readFileSync(join(root, 'packages/shared/src/runtime-contracts.ts'), 'utf8');
for (const contract of ['SavedConnection', 'QueryRequest', 'QueryExecutionResult', 'QuerySafetyReport']) {
  assert.ok(contracts.includes(contract), `runtime contracts should include ${contract}`);
}

console.log('Smoke checks passed.');
