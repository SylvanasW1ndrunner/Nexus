#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPublicApiManifest } from './lib/public-api.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const outputPath = join(repositoryRoot, 'scripts', 'baselines', 'public-api.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(createPublicApiManifest(repositoryRoot), null, 2)}\n`,
  'utf8',
);
process.stdout.write(`Public API baseline updated: ${outputPath}\n`);
