#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPublicPackageManifest, verifyReleaseMetadata } from './lib/release-gates.mjs';
import { resolvePublicRuntimeDependencies } from './lib/public-dependencies.mjs';
import { createSupplyChainDocuments, SUPPLY_CHAIN_FILES } from './lib/supply-chain.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const repositoryManifest = readJson(join(repositoryRoot, 'package.json'));
const serverManifest = readJson(join(repositoryRoot, 'apps', 'server', 'package.json'));
const version = verifyReleaseMetadata({
  rootManifest: repositoryManifest,
  serverManifest,
  readmeEnglish: readFileSync(join(repositoryRoot, 'README.md'), 'utf8'),
  readmeChinese: readFileSync(join(repositoryRoot, 'README.zh-CN.md'), 'utf8'),
  changelog: readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf8'),
});
const nodeEngine = requireString(
  repositoryManifest.engines?.node,
  'root package.json engines.node',
);
const packageName = '@nwlworkshop/schemanaut';
const provenanceFileName = 'PROVENANCE.json';
const runtimeWorkspaces = [
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
];
const publicRootFiles = [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
];
const publicDocFiles = ['docs/product-functional-overview.md', 'docs/test-pipeline.md'];
const publicDocDirectories = [
  'docs/agent',
  'docs/ai-sql',
  'docs/cli',
  'docs/foundation',
  'docs/sdk',
];
const releaseRoot = join(repositoryRoot, 'release');
const releaseDirectory = join(releaseRoot, `SchemaNaut-v${version}`);
const artifactName = `schemanaut-v${version}.tgz`;
const artifactPath = join(releaseDirectory, artifactName);
const checksumPath = join(releaseDirectory, 'SHA256SUMS.txt');
const provenancePath = join(releaseDirectory, provenanceFileName);
const stagingDirectory = mkdtempSync(join(tmpdir(), 'schemanaut-npm-'));

assertChildPath(releaseRoot, releaseDirectory);
mkdirSync(releaseDirectory, { recursive: true });
rmSync(artifactPath, { force: true });
rmSync(checksumPath, { force: true });
rmSync(provenancePath, { force: true });

try {
  const sourceInputs = captureSourceInputs();
  const buildOutputs = captureBuildOutputs();
  const distDirectory = join(stagingDirectory, 'dist');
  mkdirSync(distDirectory, { recursive: true });
  copyPublicRuntime(distDirectory);
  chmodSync(join(distDirectory, 'server', 'cli.js'), 0o755);
  copyPublicFiles(stagingDirectory);

  const packageManifest = {
    name: packageName,
    version,
    description:
      'Embeddable AI SQL agent runtime with durable sessions, Skills, MCP and safe database execution.',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './server': {
        types: './dist/server/index.d.ts',
        import: './dist/server/index.js',
        default: './dist/server/index.js',
      },
    },
    bin: { schemanaut: './dist/server/cli.js' },
    files: [
      'dist',
      'docs',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      ...Object.values(SUPPLY_CHAIN_FILES),
    ],
    engines: { node: nodeEngine },
    dependencies: resolvePublicRuntimeDependencies(repositoryRoot),
    keywords: [
      'ai',
      'agent',
      'database',
      'database-agent',
      'postgresql',
      'nl2sql',
      'text-to-sql',
      'rag',
      'mcp',
      'skills',
      'sdk',
      'cli',
    ],
    author: 'NWLworkshop contributors',
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/SylvanasW1ndrunner/Nexus.git',
    },
    homepage: 'https://github.com/SylvanasW1ndrunner/Nexus#readme',
    bugs: {
      url: 'https://github.com/SylvanasW1ndrunner/Nexus/issues',
    },
    publishConfig: { access: 'public' },
    sideEffects: false,
  };
  verifyPublicPackageManifest(packageManifest);

  writeFileSync(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  writeSupplyChainMetadata(stagingDirectory, packageManifest);
  rewritePackageMarkdownLinks(stagingDirectory);
  pack(stagingDirectory, artifactPath);
  const packagePayload = captureArchivePayload(artifactPath);
  assertSnapshotUnchanged(sourceInputs, captureSourceInputs(), 'source inputs');
  assertSnapshotUnchanged(buildOutputs, captureBuildOutputs(), 'compiled build outputs');
  const checksum = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${artifactName}\n`, 'utf8');
  const provenance = {
    schemaVersion: 1,
    package: {
      name: packageName,
      version,
    },
    workspaceIdentity: {
      method: 'sha256-file-manifest',
      workingTreeState: 'not-asserted',
    },
    sourceInputs,
    buildOutputs,
    packagePayload,
    artifact: {
      file: artifactName,
      sha256: checksum,
      size: statSync(artifactPath).size,
    },
  };
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  process.stdout.write(`npm package: ${artifactPath}\n`);
  process.stdout.write(`SHA256: ${checksum}\n`);
  process.stdout.write(`provenance: ${provenancePath}\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

function copyPublicFiles(targetRoot) {
  for (const name of publicRootFiles) {
    const source = join(repositoryRoot, name);
    if (!existsSync(source)) throw new Error(`Missing public release file: ${source}`);
    copyFileSync(source, join(targetRoot, name));
  }
  const publicDocsTarget = join(targetRoot, 'docs');
  mkdirSync(publicDocsTarget, { recursive: true });
  for (const relativePath of publicDocFiles) {
    const name = relativePath.slice('docs/'.length);
    copyFileSync(join(repositoryRoot, ...relativePath.split('/')), join(publicDocsTarget, name));
  }
  for (const relativePath of publicDocDirectories) {
    const name = relativePath.slice('docs/'.length);
    copyMarkdownDirectory(
      join(repositoryRoot, ...relativePath.split('/')),
      join(publicDocsTarget, name),
    );
  }
}

function writeSupplyChainMetadata(targetRoot, packageManifest) {
  const documents = createSupplyChainDocuments({
    repositoryRoot,
    packageManifest,
  });
  for (const [key, fileName] of Object.entries(SUPPLY_CHAIN_FILES)) {
    writeFileSync(
      join(targetRoot, fileName),
      `${JSON.stringify(documents[key], null, 2)}\n`,
      'utf8',
    );
  }
}

function copyMarkdownDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyMarkdownDirectory(sourcePath, targetPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function rewritePackageMarkdownLinks(packageRoot) {
  for (const markdownPath of markdownFiles(packageRoot)) {
    const relativeMarkdownPath = relative(packageRoot, markdownPath);
    const repositoryMarkdownPath = join(repositoryRoot, relativeMarkdownPath);
    const original = readFileSync(markdownPath, 'utf8');
    const rewritten = original.replace(
      /(!?\[[^\]\n]*\]\()([^)]+)(\))/g,
      (match, prefix, rawTarget, suffix) => {
        const parsed = parseMarkdownTarget(rawTarget);
        if (!parsed || isExternalMarkdownTarget(parsed.target)) return match;
        const packageTarget = resolve(dirname(markdownPath), decodeMarkdownPath(parsed.target));
        if (existsSync(packageTarget)) return match;
        const repositoryTarget = resolve(
          dirname(repositoryMarkdownPath),
          decodeMarkdownPath(parsed.target),
        );
        const repositoryRelative = relative(repositoryRoot, repositoryTarget);
        if (
          repositoryRelative === '..' ||
          repositoryRelative.startsWith('../') ||
          repositoryRelative.startsWith('..\\') ||
          isAbsolute(repositoryRelative)
        ) {
          throw new Error(
            `Markdown link escapes the repository: ${relativeMarkdownPath} -> ${parsed.target}`,
          );
        }
        if (!existsSync(repositoryTarget)) {
          throw new Error(
            `Markdown link target does not exist: ${relativeMarkdownPath} -> ${parsed.target}`,
          );
        }
        const repositoryRelativeTarget = repositoryRelative.replaceAll('\\', '/');
        const encodedTarget = repositoryRelativeTarget
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        const view = statSync(repositoryTarget).isDirectory() ? 'tree' : 'blob';
        const url =
          `https://github.com/SylvanasW1ndrunner/Nexus/${view}/dev/` +
          `${encodedTarget}${parsed.suffix}`;
        return `${prefix}${url}${suffix}`;
      },
    );
    if (rewritten !== original) {
      writeFileSync(markdownPath, rewritten, 'utf8');
    }
  }
}

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function parseMarkdownTarget(rawTarget) {
  const normalized = rawTarget.trim();
  if (!normalized) return undefined;
  const unwrapped =
    normalized.startsWith('<') && normalized.endsWith('>') ? normalized.slice(1, -1) : normalized;
  const suffixIndex = unwrapped.search(/[?#]/);
  return suffixIndex === -1
    ? { target: unwrapped, suffix: '' }
    : {
        target: unwrapped.slice(0, suffixIndex),
        suffix: unwrapped.slice(suffixIndex),
      };
}

function isExternalMarkdownTarget(target) {
  return target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function decodeMarkdownPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function copyPublicRuntime(distDirectory) {
  const runtimePackages = [
    {
      source: join(repositoryRoot, 'packages', 'sdk', 'dist'),
      target: distDirectory,
    },
    ...[
      'shared',
      'core-usage',
      'core-llm',
      'core-resource',
      'core-db',
      'core-rag',
      'core-skills',
      'core-agent',
      'core-tools',
    ].map((name) => ({
      source: join(repositoryRoot, 'packages', name, 'dist'),
      target: join(distDirectory, 'internal', name),
    })),
    {
      source: join(repositoryRoot, 'apps', 'server', 'dist'),
      target: join(distDirectory, 'server'),
    },
  ];
  for (const runtimePackage of runtimePackages) {
    copyRuntimeDirectory(runtimePackage.source, runtimePackage.target, distDirectory);
  }
  copyAssetDirectory(
    join(repositoryRoot, 'packages', 'core-skills', 'skills'),
    join(distDirectory, 'internal', 'core-skills', 'skills'),
  );
}

function copyRuntimeDirectory(source, target, distDirectory) {
  if (!existsSync(source)) {
    throw new Error(`Missing compiled runtime directory: ${source}`);
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDirectory(sourcePath, targetPath, distDirectory);
      continue;
    }
    if (
      !entry.isFile() ||
      (!entry.name.endsWith('.js') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.json'))
    ) {
      continue;
    }
    const moduleSource = rewriteInternalImports(
      readFileSync(sourcePath, 'utf8'),
      targetPath,
      distDirectory,
    );
    writeFileSync(targetPath, moduleSource, 'utf8');
  }
}

function copyAssetDirectory(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Missing runtime asset directory: ${source}`);
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyAssetDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    } else {
      throw new Error(`Unsupported runtime asset entry: ${sourcePath}`);
    }
  }
}

function rewriteInternalImports(content, destinationPath, distDirectory) {
  const packageTargets = {
    '@dbagent/sdk': join(distDirectory, 'index.js'),
    '@dbagent/shared': join(distDirectory, 'internal', 'shared', 'index.js'),
    '@dbagent/core-usage': join(distDirectory, 'internal', 'core-usage', 'index.js'),
    '@dbagent/core-llm': join(distDirectory, 'internal', 'core-llm', 'index.js'),
    '@dbagent/core-resource': join(distDirectory, 'internal', 'core-resource', 'index.js'),
    '@dbagent/core-db': join(distDirectory, 'internal', 'core-db', 'index.js'),
    '@dbagent/core-rag': join(distDirectory, 'internal', 'core-rag', 'index.js'),
    '@dbagent/core-skills': join(distDirectory, 'internal', 'core-skills', 'index.js'),
    '@dbagent/core-agent': join(distDirectory, 'internal', 'core-agent', 'index.js'),
    '@dbagent/core-tools': join(distDirectory, 'internal', 'core-tools', 'index.js'),
  };
  let rewritten = content.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  for (const [specifier, targetPath] of Object.entries(packageTargets)) {
    let pathFromDeclaration = relative(dirname(destinationPath), targetPath).replaceAll('\\', '/');
    if (!pathFromDeclaration.startsWith('.')) pathFromDeclaration = `./${pathFromDeclaration}`;
    rewritten = rewritten
      .replaceAll(`'${specifier}'`, `'${pathFromDeclaration}'`)
      .replaceAll(`"${specifier}"`, `"${pathFromDeclaration}"`);
  }
  return `${rewritten.trimEnd()}\n`;
}

function captureSourceInputs() {
  const paths = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'scripts/clean-public-build.mjs',
    'scripts/package-npm.mjs',
    'scripts/verify-npm-package.mjs',
    'scripts/lib/release-gates.mjs',
    'scripts/lib/public-dependencies.mjs',
    'scripts/lib/public-api.mjs',
    'scripts/lib/supply-chain.mjs',
    'scripts/generate-public-api-baseline.mjs',
    'scripts/verify-public-api.mjs',
    'scripts/generate-sbom.mjs',
    'scripts/baselines/public-api.json',
    'CHANGELOG.md',
    ...publicRootFiles,
    ...publicDocFiles,
  ];
  for (const directory of publicDocDirectories) {
    paths.push(...relativeFiles(directory, (path) => path.endsWith('.md')));
  }
  for (const workspace of runtimeWorkspaces) {
    paths.push(`${workspace}/package.json`, `${workspace}/tsconfig.json`);
    paths.push(...relativeFiles(`${workspace}/src`));
  }
  paths.push(...relativeFiles('packages/core-skills/skills'));
  return capturePathsSnapshot(paths);
}

function captureBuildOutputs() {
  const paths = [];
  for (const workspace of runtimeWorkspaces) {
    paths.push(
      ...relativeFiles(
        `${workspace}/dist`,
        (path) =>
          path.endsWith('.js') || path.endsWith('.d.ts') || path.endsWith('.json'),
      ),
    );
  }
  return capturePathsSnapshot(paths);
}

function captureDirectorySnapshot(directory) {
  const absoluteRoot = resolve(directory);
  const files = collectDirectoryFiles(absoluteRoot, absoluteRoot);
  return createSnapshot(
    files.map((path) => ({
      path: relative(absoluteRoot, path).replaceAll('\\', '/'),
      absolutePath: path,
    })),
  );
}

function captureArchivePayload(path) {
  const inspectionDirectory = mkdtempSync(join(tmpdir(), 'schemanaut-payload-'));
  try {
    run('tar', ['-xf', path, '-C', inspectionDirectory], repositoryRoot);
    const packageRoot = join(inspectionDirectory, 'package');
    if (!existsSync(packageRoot)) {
      throw new Error('Packed archive does not contain the expected package directory.');
    }
    return captureDirectorySnapshot(packageRoot);
  } finally {
    rmSync(inspectionDirectory, { recursive: true, force: true });
  }
}

function capturePathsSnapshot(paths) {
  const uniquePaths = [...new Set(paths)].sort();
  return createSnapshot(
    uniquePaths.map((path) => {
      const normalized = normalizeRepositoryPath(path);
      const absolutePath = resolve(repositoryRoot, ...normalized.split('/'));
      assertRepositoryFile(absolutePath, normalized);
      return { path: normalized, absolutePath };
    }),
  );
}

function createSnapshot(files) {
  const entries = files
    .map(({ path, absolutePath }) => {
      const content = readFileSync(absolutePath);
      return {
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      };
    })
    .sort((left, right) => comparePaths(left.path, right.path));
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\n');
  }
  return {
    algorithm: 'sha256',
    digest: digest.digest('hex'),
    files: entries,
  };
}

function relativeFiles(relativeDirectory, predicate = () => true) {
  const normalizedDirectory = normalizeRepositoryPath(relativeDirectory);
  const absoluteDirectory = resolve(repositoryRoot, ...normalizedDirectory.split('/'));
  if (!existsSync(absoluteDirectory)) {
    throw new Error(`Missing package provenance directory: ${normalizedDirectory}`);
  }
  return collectDirectoryFiles(absoluteDirectory, repositoryRoot)
    .map((path) => relative(repositoryRoot, path).replaceAll('\\', '/'))
    .filter(predicate);
}

function collectDirectoryFiles(directory, root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDirectoryFiles(path, root));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(
        `Package provenance does not support non-file entries: ${relative(root, path)}`,
      );
    }
  }
  return files.sort();
}

function normalizeRepositoryPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path)
  ) {
    throw new Error(`Invalid package provenance path: ${String(path)}`);
  }
  const normalized = path
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
  if (!normalized || normalized.split('/').includes('..') || normalized !== path) {
    throw new Error(`Invalid package provenance path: ${path}`);
  }
  return normalized;
}

function assertRepositoryFile(path, relativePath) {
  const fromRoot = relative(repositoryRoot, path);
  if (
    !fromRoot ||
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot) ||
    !existsSync(path) ||
    !statSync(path).isFile()
  ) {
    throw new Error(`Missing package provenance input: ${relativePath}`);
  }
}

function assertSnapshotUnchanged(before, after, label) {
  if (before.digest === after.digest && before.files.length === after.files.length) return;
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const changedPath = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort()
    .find((path) => {
      const left = beforeByPath.get(path);
      const right = afterByPath.get(path);
      return (
        left?.sha256 !== right?.sha256 ||
        left?.size !== right?.size ||
        left === undefined ||
        right === undefined
      );
    });
  throw new Error(
    `Package ${label} changed while the archive was being created` +
      `${changedPath ? `: ${changedPath}` : ''}. Rebuild from a stable workspace.`,
  );
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pack(cwd, outputPath) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !existsSync(pnpmCli)) {
    throw new Error('Run packaging through `pnpm package:npm` so the pnpm CLI can be located.');
  }
  const generatedName = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const generatedPath = join(dirname(outputPath), generatedName);
  assertChildPath(releaseRoot, generatedPath);
  rmSync(generatedPath, { force: true });
  run(process.execPath, [pnpmCli, 'pack', '--pack-destination', dirname(outputPath)], cwd);
  if (!existsSync(generatedPath)) {
    throw new Error(`pnpm did not produce the expected archive: ${generatedPath}`);
  }
  renameSync(generatedPath, outputPath);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaging command failed with exit code ${result.status ?? 1}.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is missing.`);
  return value.trim();
}

function assertChildPath(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new Error(`Release path escapes the release directory: ${child}`);
  }
}
