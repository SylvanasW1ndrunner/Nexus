#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_WORKSPACES } from './lib/npm-package.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageOnly = process.argv.slice(2).includes('--package-only');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--package-only');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown local release arguments: ${unknownArguments.join(', ')}`);
}

runNode('scripts/clean-build.mjs');
runNode(
  join('node_modules', 'typescript', 'bin', 'tsc'),
  '-b',
  ...RUNTIME_WORKSPACES.map(({ path }) => path),
  '--pretty',
  'false',
);
runNode('scripts/package-npm.mjs');

if (!packageOnly) {
  runNode('--test', 'scripts/tests/npm-package-contract.test.mjs');
  runNode('scripts/verify-npm-package.mjs');
}

function runNode(...args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Local release step failed: node ${args.join(' ')}`);
  }
}
