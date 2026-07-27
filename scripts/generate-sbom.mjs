#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePublicRuntimeDependencies } from './lib/public-dependencies.mjs';
import { createSupplyChainDocuments, SUPPLY_CHAIN_FILES } from './lib/supply-chain.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const outputDirectory = resolve(process.argv[2] ?? join(repositoryRoot, 'reports', 'release'));
const packageManifest = {
  name: '@nwlworkshop/schemanaut',
  version: rootManifest.version,
  dependencies: resolvePublicRuntimeDependencies(repositoryRoot),
};
const documents = createSupplyChainDocuments({ repositoryRoot, packageManifest });
mkdirSync(outputDirectory, { recursive: true });
for (const [key, fileName] of Object.entries(SUPPLY_CHAIN_FILES)) {
  writeFileSync(
    join(outputDirectory, fileName),
    `${JSON.stringify(documents[key], null, 2)}\n`,
    'utf8',
  );
}
process.stdout.write(`Supply-chain metadata written to ${outputDirectory}\n`);
