import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PUBLIC_RUNTIME_DEPENDENCY_SOURCES = Object.freeze({
  '@modelcontextprotocol/sdk': 'packages/core-tools',
  ajv: 'packages/core-llm',
  'node-sql-parser': 'packages/core-db',
  pg: 'packages/core-db',
  yaml: 'packages/core-skills',
});

export function resolvePublicRuntimeDependencies(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const dependencies = {};
  for (const [name, workspace] of Object.entries(PUBLIC_RUNTIME_DEPENDENCY_SOURCES).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const manifestPath = join(root, ...workspace.split('/'), 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifest.dependencies?.[name];
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error(`${workspace}/package.json is missing public runtime dependency ${name}.`);
    }
    if (version.startsWith('workspace:')) {
      throw new Error(`Public runtime dependency ${name} cannot use the workspace protocol.`);
    }
    dependencies[name] = version;
  }
  return dependencies;
}

export function assertPublicRuntimeDependencies(actual, expected) {
  const actualEntries = Object.entries(actual ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('Published runtime dependencies do not match workspace manifests.');
  }
}
