import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const PUBLIC_DECLARATION_WORKSPACES = Object.freeze([
  'packages/shared',
  'packages/core-usage',
  'packages/core-llm',
  'packages/core-resource',
  'packages/core-db',
  'packages/core-rag',
  'packages/core-skills',
  'packages/core-agent',
  'packages/core-tools',
  'packages/sdk',
  'apps/server',
]);

export function createPublicApiManifest(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const files = [];
  for (const workspace of PUBLIC_DECLARATION_WORKSPACES) {
    const dist = join(root, ...workspace.split('/'), 'dist');
    if (!existsSync(dist)) {
      throw new Error(`Missing declaration build output: ${workspace}/dist`);
    }
    collectDeclarations(root, dist, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    algorithm: 'sha256-normalized-typescript-declaration',
    files,
    digest: digestManifest(files),
  };
}

export function assertPublicApiManifest(actual, expected) {
  if (
    actual?.schemaVersion !== 1 ||
    actual?.algorithm !== expected?.algorithm ||
    actual?.digest !== expected?.digest ||
    JSON.stringify(actual?.files) !== JSON.stringify(expected?.files)
  ) {
    throw new Error(
      'Public TypeScript API differs from scripts/baselines/public-api.json. Review the contract change and regenerate the baseline intentionally.',
    );
  }
}

function collectDeclarations(root, directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectDeclarations(root, path, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
    const content = normalizeDeclaration(readFileSync(path, 'utf8'));
    output.push({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
  }
}

function normalizeDeclaration(content) {
  return `${content
    .replace(/\r\n?/gu, '\n')
    .replace(/^\/\/# sourceMappingURL=.*$/gmu, '')
    .trimEnd()}\n`;
}

function digestManifest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\n');
  }
  return hash.digest('hex');
}
