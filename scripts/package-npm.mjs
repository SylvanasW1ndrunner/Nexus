#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_DOCUMENT_FILES } from './lib/public-documents.mjs';
import {
  NPM_ARCHIVE_NAME,
  NPM_PACKAGE_NAME,
  NPM_PACKAGE_VERSION,
  RUNTIME_WORKSPACES,
  assertChildPath,
  assertSafeTextFiles,
  collectFiles,
  createFileSnapshot,
  createPublicPackageManifest,
  externalPackageSpecifiers,
  npmInvocation,
  publicPackageFiles,
  rewriteInternalImports,
  unresolvedInternalSpecifiers,
  verifyPackagePaths,
  verifyPublicPackageManifest,
} from './lib/npm-package.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const releaseRoot = join(repositoryRoot, 'release');
const releaseDirectory = join(releaseRoot, `SchemaNaut-v${NPM_PACKAGE_VERSION}`);
const stagingDirectory = mkdtempSync(join(tmpdir(), 'schemanaut-npm-'));
const npmCacheDirectory = mkdtempSync(join(tmpdir(), 'schemanaut-npm-cache-'));

assertChildPath(releaseRoot, releaseDirectory);
mkdirSync(releaseRoot, { recursive: true });
const pendingReleaseDirectory = mkdtempSync(
  join(releaseRoot, `.SchemaNaut-v${NPM_PACKAGE_VERSION}-pending-`),
);
const artifactPath = join(pendingReleaseDirectory, NPM_ARCHIVE_NAME);
const checksumPath = join(pendingReleaseDirectory, 'SHA256SUMS.txt');
const provenancePath = join(pendingReleaseDirectory, 'PROVENANCE.json');
const finalArtifactPath = join(releaseDirectory, NPM_ARCHIVE_NAME);
const finalProvenancePath = join(releaseDirectory, 'PROVENANCE.json');

try {
  verifyWorkspaceVersions();
  const sourceInputs = captureSourceInputs();
  const buildOutputs = captureBuildOutputs();
  const buildEnvironment = captureBuildEnvironment();
  const sourceControl = captureSourceControl();
  const distDirectory = join(stagingDirectory, 'dist');
  mkdirSync(distDirectory, { recursive: true });

  copyRuntime(distDirectory);
  copyRuntimeAssets(distDirectory);
  copyPublicFiles(stagingDirectory);

  const rootManifest = readJson(join(repositoryRoot, 'package.json'));
  const packageManifest = verifyPublicPackageManifest(
    createPublicPackageManifest(rootManifest.engines?.node),
  );
  writeFileSync(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  chmodSync(join(distDirectory, 'terminal', 'cli.js'), 0o755);
  rewritePackageMarkdownLinks(stagingDirectory);

  const stagedFiles = collectFiles(stagingDirectory);
  verifyPackagePaths(stagedFiles.map(({ path }) => path));
  assertSafeTextFiles(stagedFiles);
  verifyNoInternalSpecifiers(stagedFiles);
  verifyRuntimeDependencies(stagedFiles, packageManifest);

  pack(stagingDirectory, artifactPath, npmCacheDirectory);
  const packagePayload = inspectArchive(artifactPath, packageManifest);
  verifyPackagePaths(packagePayload.files.map(({ path }) => path));

  const artifact = readFileSync(artifactPath);
  const checksum = createHash('sha256').update(artifact).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${NPM_ARCHIVE_NAME}\n`, 'utf8');
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        package: { name: NPM_PACKAGE_NAME, version: NPM_PACKAGE_VERSION },
        distribution: 'local-npm-tarball',
        remotePublished: false,
        buildCommand: 'node scripts/release-local.mjs',
        buildEnvironment,
        sourceControl,
        sourceInputs,
        buildOutputs,
        packagePayload,
        artifact: {
          file: NPM_ARCHIVE_NAME,
          sha256: checksum,
          size: statSync(artifactPath).size,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  promoteRelease(pendingReleaseDirectory, releaseDirectory);
  process.stdout.write(`Local npm package: ${finalArtifactPath}\n`);
  process.stdout.write(`SHA256: ${checksum}\n`);
  process.stdout.write(`Provenance: ${finalProvenancePath}\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
  rmSync(npmCacheDirectory, { recursive: true, force: true });
  rmSync(pendingReleaseDirectory, { recursive: true, force: true });
}

function verifyWorkspaceVersions() {
  const rootManifest = readJson(join(repositoryRoot, 'package.json'));
  if (rootManifest.version !== NPM_PACKAGE_VERSION || rootManifest.private !== true) {
    throw new Error(`Root manifest must be private at version ${NPM_PACKAGE_VERSION}.`);
  }
  for (const workspace of RUNTIME_WORKSPACES) {
    const manifest = readJson(join(repositoryRoot, workspace.path, 'package.json'));
    if (
      manifest.name !== workspace.packageName ||
      manifest.version !== NPM_PACKAGE_VERSION ||
      manifest.private !== true
    ) {
      throw new Error(
        `${workspace.path}/package.json must remain private with identity ` +
          `${workspace.packageName}@${NPM_PACKAGE_VERSION}.`,
      );
    }
  }
}

function copyRuntime(distDirectory) {
  for (const workspace of RUNTIME_WORKSPACES) {
    const source = join(repositoryRoot, workspace.path, 'dist');
    const target = join(distDirectory, ...workspace.target.split('/'));
    copyRuntimeDirectory(source, target, distDirectory);
  }
}

function copyRuntimeDirectory(source, target, distDirectory) {
  if (!existsSync(source)) throw new Error(`Missing compiled runtime directory: ${source}`);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDirectory(sourcePath, targetPath, distDirectory);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.json'))) {
      const content = readFileSync(sourcePath, 'utf8');
      writeFileSync(
        targetPath,
        entry.name.endsWith('.js')
          ? rewriteInternalImports(content, targetPath, distDirectory)
          : content,
        'utf8',
      );
    }
  }
}

function copyRuntimeAssets(distDirectory) {
  copyDirectory(
    join(repositoryRoot, 'packages', 'core-skills', 'skills'),
    join(distDirectory, 'internal', 'core-skills', 'skills'),
  );
  copyDirectory(
    join(repositoryRoot, 'packages', 'database-capability', 'skills'),
    join(distDirectory, 'internal', 'database-capability', 'skills'),
  );
}

function copyPublicFiles(targetRoot) {
  for (const path of publicPackageFiles()) {
    copyFile(sourcePath(path), join(targetRoot, ...path.split('/')));
  }
}

function copyDirectory(source, target) {
  if (!existsSync(source)) throw new Error(`Missing runtime asset directory: ${source}`);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
    else throw new Error(`Unsupported runtime asset entry: ${sourcePath}`);
  }
}

function copyFile(source, target) {
  if (!existsSync(source)) throw new Error(`Missing release file: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function rewritePackageMarkdownLinks(packageRoot) {
  for (const { path: relativePath, absolutePath } of collectFiles(packageRoot)) {
    if (!relativePath.endsWith('.md')) continue;
    const repositoryDocument = sourcePath(relativePath);
    const original = readFileSync(absolutePath, 'utf8');
    const rewritten = original.replace(
      /(!?\[[^\]\n]*\]\()([^)]+)(\))/g,
      (match, prefix, rawTarget, suffix) => {
        const target = parseMarkdownTarget(rawTarget);
        if (!target || isExternalTarget(target.path)) return match;
        const packageTarget = resolve(dirname(absolutePath), decodePath(target.path));
        if (existsSync(packageTarget)) return match;
        if (!existsSync(repositoryDocument)) return match;
        const repositoryTarget = resolve(dirname(repositoryDocument), decodePath(target.path));
        const fromRoot = relative(repositoryRoot, repositoryTarget).replaceAll('\\', '/');
        if (!fromRoot || fromRoot.startsWith('../') || !existsSync(repositoryTarget)) return match;
        const view = statSync(repositoryTarget).isDirectory() ? 'tree' : 'blob';
        const encoded = fromRoot.split('/').map(encodeURIComponent).join('/');
        return `${prefix}https://github.com/SylvanasW1ndrunner/Nexus/${view}/dev/${encoded}${target.suffix}${suffix}`;
      },
    );
    if (rewritten !== original) writeFileSync(absolutePath, rewritten, 'utf8');
  }
}

function verifyNoInternalSpecifiers(files) {
  const findings = [];
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;
    const unresolved = unresolvedInternalSpecifiers(readFileSync(file.absolutePath, 'utf8'));
    if (unresolved.length > 0) findings.push(`${file.path}: ${unresolved.join(', ')}`);
  }
  if (findings.length > 0) {
    throw new Error(`Unresolved workspace imports in npm package:\n${findings.join('\n')}`);
  }
}

function verifyRuntimeDependencies(files, manifest) {
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const findings = [];
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;
    const content = readFileSync(file.absolutePath, 'utf8');
    for (const packageName of externalPackageSpecifiers(content)) {
      if (!declared.has(packageName)) findings.push(`${file.path}: ${packageName}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`Undeclared runtime package imports:\n${[...new Set(findings)].join('\n')}`);
  }
}

function captureSourceInputs() {
  const files = [];
  const addFile = (path) => files.push({ path, absolutePath: sourcePath(path) });
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'scripts/clean-build.mjs',
    'scripts/release-local.mjs',
    'CHANGELOG.md',
    'README.md',
    'README.en.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'scripts/package-npm.mjs',
    'scripts/verify-npm-package.mjs',
    'scripts/lib/npm-package.mjs',
    'scripts/lib/public-documents.mjs',
  ]) addFile(path);
  for (const path of PUBLIC_DOCUMENT_FILES) {
    if (!files.some((file) => file.path === path)) addFile(path);
  }
  for (const workspace of RUNTIME_WORKSPACES) {
    addFile(`${workspace.path}/package.json`);
    addFile(`${workspace.path}/tsconfig.json`);
    for (const folder of ['src', ...(workspace.path === 'packages/core-skills' || workspace.path === 'packages/database-capability' ? ['skills'] : [])]) {
      const directory = sourcePath(`${workspace.path}/${folder}`);
      for (const file of collectFiles(directory)) {
        files.push({ path: `${workspace.path}/${folder}/${file.path}`, absolutePath: file.absolutePath });
      }
    }
  }
  return createFileSnapshot(files);
}

function captureBuildEnvironment() {
  const npm = npmInvocation(['--version']);
  return {
    node: process.version,
    npm: runCapture(npm.command, npm.args, repositoryRoot).trim(),
    typescript: readJson(join(repositoryRoot, 'node_modules', 'typescript', 'package.json')).version,
    platform: process.platform,
    architecture: process.arch,
  };
}

function captureSourceControl() {
  const commit = runCapture('git', ['rev-parse', 'HEAD'], repositoryRoot).trim();
  const status = runCapture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    repositoryRoot,
  ).trimEnd();
  return {
    commit,
    dirty: status.length > 0,
    statusSha256: createHash('sha256').update(status).digest('hex'),
  };
}

function captureBuildOutputs() {
  const files = [];
  for (const workspace of RUNTIME_WORKSPACES) {
    const directory = sourcePath(`${workspace.path}/dist`);
    for (const file of collectFiles(directory)) {
      if (!file.path.endsWith('.js') && !file.path.endsWith('.json')) continue;
      files.push({ path: `${workspace.path}/dist/${file.path}`, absolutePath: file.absolutePath });
    }
  }
  return createFileSnapshot(files);
}

function inspectArchive(path, manifest) {
  const inspectionRoot = mkdtempSync(join(tmpdir(), 'schemanaut-inspect-'));
  try {
    run('tar', ['-xf', path, '-C', inspectionRoot], repositoryRoot);
    const packageRoot = join(inspectionRoot, 'package');
    if (!existsSync(packageRoot)) throw new Error('Archive does not contain package/.');
    const files = collectFiles(packageRoot);
    verifyPackagePaths(files.map(({ path: packagePath }) => packagePath));
    assertSafeTextFiles(files);
    verifyNoInternalSpecifiers(files);
    verifyRuntimeDependencies(files, manifest);
    return createFileSnapshot(files);
  } finally {
    rmSync(inspectionRoot, { recursive: true, force: true });
  }
}

function promoteRelease(pendingDirectory, finalDirectory) {
  assertChildPath(releaseRoot, pendingDirectory);
  assertChildPath(releaseRoot, finalDirectory);
  const backupDirectory = join(
    releaseRoot,
    `.SchemaNaut-v${NPM_PACKAGE_VERSION}-backup-${process.pid}-${Date.now()}`,
  );
  assertChildPath(releaseRoot, backupDirectory);
  const hadPreviousRelease = existsSync(finalDirectory);
  if (hadPreviousRelease) renameSync(finalDirectory, backupDirectory);
  try {
    renameSync(pendingDirectory, finalDirectory);
  } catch (error) {
    if (hadPreviousRelease && existsSync(backupDirectory)) {
      renameSync(backupDirectory, finalDirectory);
    }
    throw error;
  }
  if (hadPreviousRelease) rmSync(backupDirectory, { recursive: true, force: true });
}

function pack(cwd, outputPath, cacheDirectory) {
  const invocation = npmInvocation([
    'pack',
    '--ignore-scripts',
    '--json',
    '--cache',
    cacheDirectory,
    '--pack-destination',
    dirname(outputPath),
  ]);
  const result = spawnSync(
    invocation.command,
    invocation.args,
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  const generatedName = report[0]?.filename;
  if (typeof generatedName !== 'string') throw new Error('npm pack did not report an archive name.');
  const generatedPath = join(dirname(outputPath), generatedName);
  assertChildPath(releaseRoot, generatedPath);
  renameSync(generatedPath, outputPath);
}

function parseMarkdownTarget(rawTarget) {
  const value = rawTarget.trim().replace(/^<|>$/g, '');
  if (!value) return undefined;
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1
    ? { path: value, suffix: '' }
    : { path: value.slice(0, suffixIndex), suffix: value.slice(suffixIndex) };
}

function isExternalTarget(path) {
  return path.startsWith('#') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path);
}

function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function sourcePath(path) {
  const resolvedPath = resolve(repositoryRoot, ...path.split('/'));
  assertChildPath(repositoryRoot, resolvedPath);
  return resolvedPath;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}.`);
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
