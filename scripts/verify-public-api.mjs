#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertPublicApiManifest, createPublicApiManifest } from './lib/public-api.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const baselinePath = join(repositoryRoot, 'scripts', 'baselines', 'public-api.json');
const expected = JSON.parse(readFileSync(baselinePath, 'utf8'));
const actual = createPublicApiManifest(repositoryRoot);
assertPublicApiManifest(actual, expected);
process.stdout.write(`Public TypeScript API matches baseline (${actual.digest}).\n`);
