import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = [
  'package.json',
  'pnpm-workspace.yaml',
  'apps/desktop/package.json',
  'packages/shared/src/ipc.ts',
  'packages/core-db/src/sql-safety.ts',
  'docs/product/README.md',
  'docs/engineering/interfaces.md',
  'docs/engineering/test-strategy.md',
];

for (const path of required) {
  assert.ok(existsSync(join(root, path)), `missing ${path}`);
}

const sqlSafety = readFileSync(join(root, 'packages/core-db/src/sql-safety.ts'), 'utf8');
for (const keyword of ['DELETE', 'DROP', 'TRUNCATE', 'readOnly']) {
  assert.ok(sqlSafety.includes(keyword), `sql safety should mention ${keyword}`);
}

const ipc = readFileSync(join(root, 'packages/shared/src/ipc.ts'), 'utf8');
for (const channel of ['connection:test', 'connection:create', 'db:execute-query', 'usage:history']) {
  assert.ok(ipc.includes(channel), `ipc contract should include ${channel}`);
}

console.log('Smoke checks passed.');
