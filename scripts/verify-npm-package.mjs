#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NPM_ARCHIVE_NAME,
  NPM_PACKAGE_NAME,
  NPM_PACKAGE_VERSION,
  assertChildPath,
  assertSafeTextFiles,
  collectFiles,
  createFileSnapshot,
  externalPackageSpecifiers,
  npmInvocation,
  unresolvedInternalSpecifiers,
  verifyPackagePaths,
  verifyPublicPackageManifest,
} from './lib/npm-package.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = join(repositoryRoot, 'release', `SchemaNaut-v${NPM_PACKAGE_VERSION}`);
const artifactPath = join(releaseDirectory, NPM_ARCHIVE_NAME);
const checksumPath = join(releaseDirectory, 'SHA256SUMS.txt');
const provenancePath = join(releaseDirectory, 'PROVENANCE.json');
const installRoot = mkdtempSync(join(tmpdir(), 'schemanaut-install-'));
const extractRoot = mkdtempSync(join(tmpdir(), 'schemanaut-extract-'));
const configuredNpmCache = process.env.SCHEMANAUT_NPM_CACHE?.trim();
const npmCacheSource = process.env.SCHEMANAUT_NPM_CACHE_SOURCE?.trim();
const npmCacheRoot = configuredNpmCache
  ? resolve(configuredNpmCache)
  : mkdtempSync(join(tmpdir(), 'schemanaut-install-cache-'));
const ownsNpmCache = !configuredNpmCache;

if (!existsSync(npmCacheRoot)) {
  throw new Error(`Configured npm cache does not exist: ${npmCacheRoot}`);
}
if (configuredNpmCache && npmCacheSource) {
  throw new Error('Use SCHEMANAUT_NPM_CACHE or SCHEMANAUT_NPM_CACHE_SOURCE, not both.');
}
if (npmCacheSource) seedNpmCache(resolve(npmCacheSource), npmCacheRoot);

try {
  const artifact = verifyChecksum();
  run('tar', ['-xf', artifactPath, '-C', extractRoot], repositoryRoot);
  const extractedPackage = join(extractRoot, 'package');
  const packageFiles = collectFiles(extractedPackage);
  verifyPackagePaths(packageFiles.map(({ path }) => path));
  assertSafeTextFiles(packageFiles);
  const packageManifest = verifyPublicPackageManifest(
    readJson(join(extractedPackage, 'package.json')),
  );
  verifyNoWorkspaceImports(packageFiles);
  verifyRuntimeDependencies(packageFiles, packageManifest);
  verifyProvenance(packageFiles, artifact);

  const npmInstall = npmInvocation([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    process.env.SCHEMANAUT_NPM_OFFLINE === '1' ? '--offline' : '--prefer-offline',
    '--package-lock=false',
    '--cache',
    npmCacheRoot,
    artifactPath,
  ]);
  run(npmInstall.command, npmInstall.args, installRoot);
  verifyPackageImportBoundary();

  const executable = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'schemanaut.cmd' : 'schemanaut',
  );
  if (!existsSync(executable)) throw new Error(`Installed CLI is missing: ${executable}`);
  if (process.platform !== 'win32' && (statSync(executable).mode & 0o111) === 0) {
    throw new Error(`Installed CLI shim is not executable: ${executable}`);
  }
  const projectRoot = join(installRoot, 'demo-project');
  runInstalledCli(['--help']);
  runInstalledCli(['init', projectRoot]);
  runInstalledCli(['skills', '-C', projectRoot]);
  runInstalledCli(['sessions', '-C', projectRoot]);
  runInstalledCli(['-C', projectRoot], '/exit\n');

  process.stdout.write(
    `Verified local install: ${NPM_PACKAGE_NAME}@${NPM_PACKAGE_VERSION}\n` +
      `Artifact: ${artifactPath}\n`,
  );
} finally {
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(extractRoot, { recursive: true, force: true });
  if (ownsNpmCache) rmSync(npmCacheRoot, { recursive: true, force: true });
}

function verifyChecksum() {
  if (!existsSync(artifactPath) || !existsSync(checksumPath) || !existsSync(provenancePath)) {
    throw new Error('Local npm package is missing. Run `pnpm package:npm` first.');
  }
  const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)\r?\n$/.exec(
    readFileSync(checksumPath, 'utf8'),
  );
  if (!match || match[2] !== NPM_ARCHIVE_NAME) {
    throw new Error('SHA256SUMS.txt has an invalid filename or format.');
  }
  const expected = Buffer.from(match[1], 'hex');
  const artifact = readFileSync(artifactPath);
  const actual = createHash('sha256').update(artifact).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Local npm package checksum does not match SHA256SUMS.txt.');
  }
  return { sha256: actual.toString('hex'), size: artifact.length };
}

function verifyNoWorkspaceImports(files) {
  const findings = [];
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;
    const unresolved = unresolvedInternalSpecifiers(readFileSync(file.absolutePath, 'utf8'));
    if (unresolved.length > 0) findings.push(`${file.path}: ${unresolved.join(', ')}`);
  }
  if (findings.length > 0) throw new Error(`Workspace imports remain:\n${findings.join('\n')}`);
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

function verifyProvenance(packageFiles, artifact) {
  const provenance = readJson(provenancePath);
  if (
    provenance.schemaVersion !== 1 ||
    provenance.package?.name !== NPM_PACKAGE_NAME ||
    provenance.package?.version !== NPM_PACKAGE_VERSION ||
    provenance.distribution !== 'local-npm-tarball' ||
    provenance.remotePublished !== false
  ) {
    throw new Error('PROVENANCE.json has an invalid package identity or distribution boundary.');
  }
  if (
    provenance.artifact?.file !== NPM_ARCHIVE_NAME ||
    provenance.artifact?.sha256 !== artifact.sha256 ||
    provenance.artifact?.size !== artifact.size
  ) {
    throw new Error('PROVENANCE.json does not match the local npm artifact.');
  }
  verifySnapshot('packagePayload', provenance.packagePayload, packageFiles);
  verifyRepositorySnapshot('sourceInputs', provenance.sourceInputs);
  verifyRepositorySnapshot('buildOutputs', provenance.buildOutputs);
  for (const key of ['node', 'npm', 'typescript', 'platform', 'architecture']) {
    if (typeof provenance.buildEnvironment?.[key] !== 'string' || !provenance.buildEnvironment[key]) {
      throw new Error(`PROVENANCE.json is missing buildEnvironment.${key}.`);
    }
  }
  if (
    typeof provenance.sourceControl?.commit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(provenance.sourceControl.commit) ||
    typeof provenance.sourceControl?.dirty !== 'boolean' ||
    !/^[0-9a-f]{64}$/i.test(provenance.sourceControl?.statusSha256 ?? '')
  ) {
    throw new Error('PROVENANCE.json has invalid source-control metadata.');
  }
}

function verifyRepositorySnapshot(label, snapshot) {
  if (!Array.isArray(snapshot?.files)) throw new Error(`PROVENANCE.json is missing ${label}.files.`);
  const files = snapshot.files.map((entry) => {
    if (typeof entry.path !== 'string' || !entry.path) {
      throw new Error(`PROVENANCE.json has an invalid ${label} path.`);
    }
    const absolutePath = resolve(repositoryRoot, ...entry.path.split('/'));
    assertChildPath(repositoryRoot, absolutePath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`PROVENANCE.json ${label} file is missing: ${entry.path}`);
    }
    return { path: entry.path, absolutePath };
  });
  verifySnapshot(label, snapshot, files);
}

function verifySnapshot(label, expected, files) {
  const actual = createFileSnapshot(files);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PROVENANCE.json ${label} snapshot does not match current files.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function seedNpmCache(source, target) {
  if (!existsSync(source)) throw new Error(`npm cache source does not exist: ${source}`);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(target, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

function runInstalledCli(args, input) {
  const invocation = npmInvocation([
    'exec',
    '--offline',
    '--yes=false',
    '--',
    'schemanaut',
    ...args,
  ]);
  run(invocation.command, invocation.args, installRoot, input);
}

function verifyPackageImportBoundary() {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import('${NPM_PACKAGE_NAME}/dist/internal/agent-host/index.js')`,
    ],
    { cwd: installRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status === 0 || !result.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    throw new Error('Installed package does not block internal JavaScript subpath imports.');
  }
}

function run(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}.`);
  }
}
