import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { posix, resolve } from 'node:path';
import { PUBLIC_DOCUMENT_FILES } from '../lib/public-documents.mjs';
import {
  NPM_PACKAGE_NAME,
  NPM_PACKAGE_VERSION,
  PUBLIC_PACKAGE_FIXED_FILES,
  PUBLIC_RUNTIME_DEPENDENCIES,
  RUNTIME_WORKSPACES,
  collectFiles,
  createPublicPackageManifest,
  externalPackageSpecifiers,
  publicPackageFiles,
  rewriteInternalImports,
  unresolvedInternalSpecifiers,
  verifyPackagePaths,
  verifyPublicPackageManifest,
} from '../lib/npm-package.mjs';

const PACKAGE_PATH_FIXTURE = [
  'package.json',
  ...publicPackageFiles(),
  'dist/terminal/cli.js',
  'dist/internal/agent-host/index.js',
  'dist/internal/core-agent/index.js',
  'dist/internal/first-party-capabilities/index.js',
  'dist/internal/core-skills/skills/system/delegate-and-synthesize/SKILL.md',
  'dist/internal/database-capability/skills/query-and-answer/SKILL.md',
];

function inlineMarkdownDocumentTargets(sourcePath, content) {
  const targets = new Set();
  const inlineLink = /\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const match of content.matchAll(inlineLink)) {
    const destination = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/i.test(destination)) continue;
    const pathname = destination.split(/[?#]/, 1)[0];
    if (!pathname.endsWith('.md')) continue;
    targets.add(posix.normalize(posix.join(posix.dirname(sourcePath), pathname)));
  }
  return targets;
}

test('every public document entry resolves to a repository file', () => {
  assert.equal(
    new Set(PUBLIC_DOCUMENT_FILES).size,
    PUBLIC_DOCUMENT_FILES.length,
    'Public document manifest must not contain duplicate paths.',
  );
  for (const document of PUBLIC_DOCUMENT_FILES) {
    assert.equal(existsSync(resolve(document)), true, `Missing public document: ${document}`);
  }
});

test('public package copy plan includes every public document and only fixed package files', () => {
  assert.deepEqual(publicPackageFiles(), [
    ...PUBLIC_DOCUMENT_FILES,
    ...PUBLIC_PACKAGE_FIXED_FILES,
  ]);
});

test('public documents include the transitive closure of local Markdown links', () => {
  const publicDocuments = new Set(PUBLIC_DOCUMENT_FILES);
  for (const sourcePath of PUBLIC_DOCUMENT_FILES) {
    const content = readFileSync(resolve(sourcePath), 'utf8');
    for (const targetPath of inlineMarkdownDocumentTargets(sourcePath, content)) {
      assert.ok(
        publicDocuments.has(targetPath),
        `${sourcePath} links to unpublished Markdown document: ${targetPath}`,
      );
    }
  }
});

test('Markdown document link parsing normalizes local paths and ignores external destinations', () => {
  const content = [
    '[guide](../guides/terminal.md?view=full#sessions)',
    '[fragment](#local-heading)',
    '[website](https://example.com/guide.md)',
    '[contact](mailto:docs@example.com)',
    '[image](../assets/terminal.png)',
  ].join('\n');
  assert.deepEqual(
    [...inlineMarkdownDocumentTargets('docs/product/overview.md', content)],
    ['docs/guides/terminal.md'],
  );
});

test('file collection preserves string paths across nested directories', () => {
  const files = collectFiles(resolve('scripts'));
  assert.ok(files.some((file) => file.path === 'lib/npm-package.mjs'));
  assert.ok(files.every((file) => typeof file.path === 'string' && typeof file.absolutePath === 'string'));
});

test('public manifest is CLI-only and pinned to the alpha local release', () => {
  const manifest = verifyPublicPackageManifest(createPublicPackageManifest('>=22.13.0'));
  assert.equal(manifest.name, NPM_PACKAGE_NAME);
  assert.equal(manifest.version, NPM_PACKAGE_VERSION);
  assert.deepEqual(manifest.bin, { schemanaut: './dist/terminal/cli.js' });
  assert.equal('main' in manifest, false);
  assert.equal('types' in manifest, false);
  assert.deepEqual(manifest.exports, {});
  assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'next' });
  assert.deepEqual(manifest.files, [
    'dist',
    'docs',
    ...publicPackageFiles().filter((path) => !path.includes('/')),
  ]);
});

test('public runtime dependencies exactly match the runtime workspace dependency closure', () => {
  const versionsByDependency = new Map();
  for (const workspace of RUNTIME_WORKSPACES) {
    const packageJsonPath = resolve(workspace.path, 'package.json');
    const { dependencies = {} } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (version.startsWith('workspace:')) continue;
      const existing = versionsByDependency.get(dependency);
      if (existing && existing.version !== version) {
        throw new Error(
          `Runtime dependency version conflict for ${dependency}: ${existing.version} in ${existing.workspace} and ${version} in ${workspace.path}.`,
        );
      }
      versionsByDependency.set(dependency, { version, workspace: workspace.path });
    }
  }

  const runtimeDependencyClosure = Object.fromEntries(
    [...versionsByDependency]
      .map(([dependency, { version }]) => [dependency, version])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(PUBLIC_RUNTIME_DEPENDENCIES, runtimeDependencyClosure);
});

test('bundled workspace search keeps its selector in both runtime dependency boundaries', () => {
  const coreToolsManifest = JSON.parse(readFileSync(resolve('packages/core-tools/package.json'), 'utf8'));
  assert.equal(coreToolsManifest.dependencies['@vscode/ripgrep'], '1.18.0');
  assert.equal(PUBLIC_RUNTIME_DEPENDENCIES['@vscode/ripgrep'], '1.18.0');
});

test('all current workspace imports are rewritten into the local distribution', () => {
  const source = RUNTIME_WORKSPACES.map(({ packageName }) => `import '${packageName}';`).join('\n');
  const dist = resolve('release-test', 'dist');
  const destination = resolve(dist, 'terminal', 'cli.js');
  const rewritten = rewriteInternalImports(source, destination, dist);
  assert.deepEqual(unresolvedInternalSpecifiers(rewritten), []);
  assert.match(rewritten, /\.\.\/internal\/agent-host\/index\.js/);
});

test('first-party capabilities are sealed into the runtime package closure', () => {
  const workspace = RUNTIME_WORKSPACES.find(
    ({ packageName }) => packageName === '@dbagent/first-party-capabilities',
  );
  assert.deepEqual(workspace, {
    path: 'packages/first-party-capabilities',
    packageName: '@dbagent/first-party-capabilities',
    target: 'internal/first-party-capabilities',
  });
  assert.equal(
    RUNTIME_WORKSPACES.indexOf(workspace),
    RUNTIME_WORKSPACES.findIndex(
      ({ packageName }) => packageName === '@dbagent/database-capability',
    ) + 1,
  );
  assert.equal(
    RUNTIME_WORKSPACES[RUNTIME_WORKSPACES.indexOf(workspace) + 1]?.packageName,
    '@dbagent/agent-host',
  );

  const dist = resolve('release-test', 'dist');
  const destination = resolve(dist, 'terminal', 'cli.js');
  assert.equal(
    rewriteInternalImports("import '@dbagent/first-party-capabilities';", destination, dist),
    "import '../internal/first-party-capabilities/index.js';\n",
  );
  assert.doesNotThrow(() => verifyPackagePaths(PACKAGE_PATH_FIXTURE));
  assert.throws(
    () =>
      verifyPackagePaths(
        PACKAGE_PATH_FIXTURE.filter(
          (path) => path !== 'dist/internal/first-party-capabilities/index.js',
        ),
      ),
    /dist\/internal\/first-party-capabilities\/index\.js/,
  );
  for (const document of PUBLIC_DOCUMENT_FILES) {
    assert.throws(
      () => verifyPackagePaths(PACKAGE_PATH_FIXTURE.filter((path) => path !== document)),
      Error,
      `Removing public document ${document} must fail package verification.`,
    );
  }
});

test('external import discovery reduces package subpaths to declared package roots', () => {
  const source = [
    "import { Client } from 'pg';",
    "import schema from '@modelcontextprotocol/sdk/types.js';",
    "await import('@vscode/ripgrep');",
    "import './local.js';",
    "import 'node:path';",
  ].join('\n');
  assert.deepEqual(externalPackageSpecifiers(source), ['@modelcontextprotocol/sdk', '@vscode/ripgrep', 'pg']);
});

test('package allowlist rejects state, source maps, SDK, and Server files', () => {
  for (const forbidden of [
    'state.db',
    '.env',
    'dist/terminal/cli.js.map',
    'packages/sdk/index.js',
    'apps/server/cli.js',
    'dist/internal/source.ts',
    'dist/internal/private.pem',
    '.npmrc',
    'dist/internal/cache.db',
  ]) {
    assert.throws(
      () => verifyPackagePaths([...PACKAGE_PATH_FIXTURE, forbidden]),
      /(?:outside the npm package allowlist|Forbidden files)/,
    );
  }
});
