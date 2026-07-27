#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findLegacyPublicContractMarkers,
  findSecretMatches,
  readPackagePostgresConfig,
  verifyPublicPackageManifest,
  verifyReleaseChecksum,
  verifyReleaseMetadata,
} from './lib/release-gates.mjs';
import {
  assertPublicRuntimeDependencies,
  resolvePublicRuntimeDependencies,
} from './lib/public-dependencies.mjs';
import { assertSupplyChainDocuments, SUPPLY_CHAIN_FILES } from './lib/supply-chain.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const minimumUnflaggedNodeEngine = '>=22.13.0';
const repositoryManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const serverManifest = JSON.parse(
  readFileSync(join(repositoryRoot, 'apps', 'server', 'package.json'), 'utf8'),
);
const version = verifyReleaseMetadata({
  rootManifest: repositoryManifest,
  serverManifest,
  readmeEnglish: readFileSync(join(repositoryRoot, 'README.md'), 'utf8'),
  readmeChinese: readFileSync(join(repositoryRoot, 'README.zh-CN.md'), 'utf8'),
  changelog: readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf8'),
});
const artifactName = `schemanaut-v${version}.tgz`;
const artifactPath = join(repositoryRoot, 'release', `SchemaNaut-v${version}`, artifactName);
const checksumPath = join(repositoryRoot, 'release', `SchemaNaut-v${version}`, 'SHA256SUMS.txt');
const provenancePath = join(repositoryRoot, 'release', `SchemaNaut-v${version}`, 'PROVENANCE.json');
const packageName = '@nwlworkshop/schemanaut';
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
const publicDocDirectories = ['docs/agent', 'docs/ai-sql', 'docs/foundation', 'docs/sdk'];
let validationRoot;

export async function verifyNpmPackage() {
  validationRoot = mkdtempSync(join(tmpdir(), 'schemanaut-package-validation-'));
  try {
    if (!existsSync(artifactPath)) throw new Error(`npm archive does not exist: ${artifactPath}`);
    if (!existsSync(checksumPath)) {
      throw new Error(`Release checksum manifest does not exist: ${checksumPath}`);
    }
    if (!existsSync(provenancePath)) {
      throw new Error(`Release provenance manifest does not exist: ${provenancePath}`);
    }
    verifyReleaseChecksum({ artifactPath, checksumPath, artifactName });
    assertLegacyReleaseDirectoriesAreAbsent();
    const inspectionRoot = join(validationRoot, 'inspection');
    mkdirSync(inspectionRoot, { recursive: true });
    run('tar', ['-xf', artifactPath, '-C', inspectionRoot], repositoryRoot);

    const unpackedPackageRoot = join(inspectionRoot, 'package');
    verifyPackageProvenance({
      repositoryRoot,
      artifactPath,
      artifactName,
      provenancePath,
      packageRoot: unpackedPackageRoot,
      packageName,
      packageVersion: version,
    });
    const nodeEngine = verifyManifest(unpackedPackageRoot);
    verifyPublicFiles(unpackedPackageRoot, nodeEngine);
    verifySupplyChainMetadata(unpackedPackageRoot);
    verifyMarkdownLinks(unpackedPackageRoot);
    assertInternalImportsArePortable(join(unpackedPackageRoot, 'dist'));
    assertExpectedRuntimeModulesExist(unpackedPackageRoot);
    assertLegacyArtifactsAreAbsent(unpackedPackageRoot);
    assertInternalReleaseArtifactsAreAbsent(unpackedPackageRoot);
    assertPackageContainsNoSecrets(unpackedPackageRoot);

    const consumerRoot = installPackageInIsolatedConsumer();
    const packageRoot = join(consumerRoot, 'node_modules', '@nwlworkshop', 'schemanaut');
    if (!existsSync(packageRoot)) {
      throw new Error('The package manager did not install @nwlworkshop/schemanaut.');
    }

    const sdk = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
    verifySdkExports(sdk);
    await verifyRuntimeBehavior(sdk);
    await verifyInstalledPackagePostgres(sdk);
    await verifyServerBehavior(consumerRoot, sdk);
    verifyCliBehavior(consumerRoot);
    verifyTypeDeclarations(consumerRoot);

    process.stdout.write(
      `SchemaNaut npm package verification passed (${version}): checksum, provenance, release metadata, public files, secret scan, isolated SDK/session/server state, optional PostgreSQL, CLI and TypeScript declarations.\n`,
    );
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
    validationRoot = undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await verifyNpmPackage();
}

export function verifyPackageProvenance(options) {
  const provenance = JSON.parse(readFileSync(options.provenancePath, 'utf8'));
  if (provenance.schemaVersion !== 1) {
    throw new Error(
      `Unsupported package provenance schema version: ${String(provenance.schemaVersion)}`,
    );
  }
  if (
    provenance.package?.name !== options.packageName ||
    provenance.package?.version !== options.packageVersion
  ) {
    throw new Error('Package provenance identity does not match the release package.');
  }
  if (
    provenance.workspaceIdentity?.method !== 'sha256-file-manifest' ||
    provenance.workspaceIdentity?.workingTreeState !== 'not-asserted' ||
    Object.hasOwn(provenance.workspaceIdentity, 'clean') ||
    Object.hasOwn(provenance.workspaceIdentity, 'isClean')
  ) {
    throw new Error(
      'Package provenance must use content hashes and must not claim a clean working tree.',
    );
  }

  const artifact = provenance.artifact;
  if (
    artifact?.file !== options.artifactName ||
    !isLowercaseSha256(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0
  ) {
    throw new Error('Package provenance contains invalid archive metadata.');
  }
  const artifactContent = readFileSync(options.artifactPath);
  const actualArtifactHash = createHash('sha256').update(artifactContent).digest('hex');
  if (artifact.sha256 !== actualArtifactHash || artifact.size !== artifactContent.length) {
    throw new Error('Package archive does not match PROVENANCE.json.');
  }

  assertRecordedSnapshot(
    provenance.sourceInputs,
    captureSourceInputs(options.repositoryRoot),
    'source inputs',
  );
  assertRecordedSnapshot(
    provenance.buildOutputs,
    captureBuildOutputs(options.repositoryRoot),
    'compiled build outputs',
  );
  assertRecordedSnapshot(
    provenance.packagePayload,
    captureDirectorySnapshot(options.packageRoot),
    'package payload',
  );
}

function captureSourceInputs(root) {
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
    paths.push(...relativeFiles(root, directory, (path) => path.endsWith('.md')));
  }
  for (const workspace of runtimeWorkspaces) {
    paths.push(`${workspace}/package.json`, `${workspace}/tsconfig.json`);
    paths.push(...relativeFiles(root, `${workspace}/src`));
  }
  paths.push(...relativeFiles(root, 'packages/core-skills/skills'));
  return capturePathsSnapshot(root, paths);
}

function captureBuildOutputs(root) {
  const paths = [];
  for (const workspace of runtimeWorkspaces) {
    paths.push(
      ...relativeFiles(
        root,
        `${workspace}/dist`,
        (path) => path.endsWith('.js') || path.endsWith('.d.ts'),
      ),
    );
  }
  return capturePathsSnapshot(root, paths);
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

function capturePathsSnapshot(root, paths) {
  const absoluteRoot = resolve(root);
  const uniquePaths = [...new Set(paths)].sort();
  return createSnapshot(
    uniquePaths.map((path) => {
      const normalized = normalizeProvenancePath(path);
      const absolutePath = resolve(absoluteRoot, ...normalized.split('/'));
      assertRootFile(absoluteRoot, absolutePath, normalized);
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
  return {
    algorithm: 'sha256',
    digest: snapshotDigest(entries),
    files: entries,
  };
}

function relativeFiles(root, relativeDirectory, predicate = () => true) {
  const absoluteRoot = resolve(root);
  const normalizedDirectory = normalizeProvenancePath(relativeDirectory);
  const absoluteDirectory = resolve(absoluteRoot, ...normalizedDirectory.split('/'));
  if (!existsSync(absoluteDirectory)) {
    throw new Error(`Missing package provenance directory: ${normalizedDirectory}`);
  }
  return collectDirectoryFiles(absoluteDirectory, absoluteRoot)
    .map((path) => relative(absoluteRoot, path).replaceAll('\\', '/'))
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

function assertRecordedSnapshot(recorded, current, label) {
  if (
    !recorded ||
    recorded.algorithm !== 'sha256' ||
    !isLowercaseSha256(recorded.digest) ||
    !Array.isArray(recorded.files)
  ) {
    throw new Error(`Package provenance ${label} snapshot is invalid.`);
  }
  const seen = new Set();
  for (const file of recorded.files) {
    const normalized = normalizeProvenancePath(file?.path);
    if (
      normalized !== file.path ||
      seen.has(normalized) ||
      !isLowercaseSha256(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error(`Package provenance ${label} file entry is invalid: ${String(file?.path)}`);
    }
    seen.add(normalized);
  }
  const ordered = [...recorded.files].sort((left, right) => comparePaths(left.path, right.path));
  if (
    ordered.some((file, index) => file !== recorded.files[index]) ||
    snapshotDigest(ordered) !== recorded.digest
  ) {
    throw new Error(`Package provenance ${label} digest is invalid.`);
  }

  const recordedByPath = new Map(recorded.files.map((file) => [file.path, file]));
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  const paths = [...new Set([...recordedByPath.keys(), ...currentByPath.keys()])].sort();
  const changedPath = paths.find((path) => {
    const expected = recordedByPath.get(path);
    const actual = currentByPath.get(path);
    return (
      expected === undefined ||
      actual === undefined ||
      expected.sha256 !== actual.sha256 ||
      expected.size !== actual.size
    );
  });
  if (
    changedPath ||
    recorded.digest !== current.digest ||
    recorded.files.length !== current.files.length
  ) {
    throw new Error(
      `Package provenance ${label} no longer match` +
        `${changedPath ? `: ${changedPath}` : ''}. Rebuild the release archive.`,
    );
  }
}

function snapshotDigest(files) {
  const digest = createHash('sha256');
  for (const entry of files) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function normalizeProvenancePath(path) {
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

function assertRootFile(root, path, relativePath) {
  const fromRoot = relative(root, path);
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

function isLowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertLegacyReleaseDirectoriesAreAbsent() {
  const releaseRoot = join(repositoryRoot, 'release');
  if (!existsSync(releaseRoot)) return;
  const legacy = readdirSync(releaseRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && /^(?:dbagent|agentdb)(?:[-.]|$)/i.test(entry.name.trim()),
    )
    .map((entry) => entry.name);
  if (legacy.length > 0) {
    throw new Error(`Legacy release directories are still present: ${legacy.join(', ')}`);
  }
}

function verifyManifest(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const expected = {
    name: '@nwlworkshop/schemanaut',
    version,
    license: 'Apache-2.0',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      throw new Error(`Unexpected package.json ${key}: ${String(manifest[key])}`);
    }
  }
  if (repositoryManifest.engines?.node !== minimumUnflaggedNodeEngine) {
    throw new Error(
      `Root package.json must require the first unflagged node:sqlite runtime (${minimumUnflaggedNodeEngine}); received ${String(repositoryManifest.engines?.node)}.`,
    );
  }
  if (manifest.engines?.node !== repositoryManifest.engines.node) {
    throw new Error(
      `Published Node.js engine (${String(manifest.engines?.node)}) does not match root package.json (${String(repositoryManifest.engines.node)}).`,
    );
  }
  verifyPublicPackageManifest(manifest);
  assertPublicRuntimeDependencies(
    manifest.dependencies,
    resolvePublicRuntimeDependencies(repositoryRoot),
  );
  return manifest.engines.node;
}

function verifyPublicFiles(packageRoot, nodeEngine) {
  for (const path of [
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'docs/sdk/README.md',
    'docs/sdk/README.zh-CN.md',
    'docs/sdk/api-reference.md',
    'docs/sdk/api-reference.zh-CN.md',
    'docs/product-functional-overview.md',
    'docs/agent/README.md',
    'docs/test-pipeline.md',
  ]) {
    if (!existsSync(join(packageRoot, path))) {
      throw new Error(`Public package file is missing: ${path}`);
    }
  }
  const english = readFileSync(join(packageRoot, 'README.md'), 'utf8');
  const chinese = readFileSync(join(packageRoot, 'README.zh-CN.md'), 'utf8');
  if (!english.includes('# SchemaNaut') || !english.includes('README.zh-CN.md')) {
    throw new Error('English README does not contain SchemaNaut branding and language navigation.');
  }
  if (!chinese.includes('# SchemaNaut') || !chinese.includes('README.md')) {
    throw new Error('Chinese README does not contain SchemaNaut branding and language navigation.');
  }
  verifyNodeEngineDocumentation(packageRoot, nodeEngine);
}

function verifySupplyChainMetadata(packageRoot) {
  const packageManifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
  const documents = Object.fromEntries(
    Object.entries(SUPPLY_CHAIN_FILES).map(([key, fileName]) => {
      const path = join(packageRoot, fileName);
      if (!existsSync(path)) throw new Error(`Supply-chain metadata is missing: ${fileName}`);
      return [key, JSON.parse(readFileSync(path, 'utf8'))];
    }),
  );
  assertSupplyChainDocuments({
    packageManifest,
    sbom: documents.sbom,
    licenses: documents.licenses,
    vulnerabilities: documents.vulnerabilities,
  });
}

function verifyNodeEngineDocumentation(packageRoot, nodeEngine) {
  const versionMatch = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(nodeEngine);
  if (!versionMatch) {
    throw new Error(`Published Node.js engine is not an exact minimum semver: ${nodeEngine}`);
  }
  const documentedVersion = `${versionMatch[1]}.${versionMatch[2]}`;
  const documentationContracts = [
    {
      path: 'README.md',
      requirement: `Node.js ${documentedVersion} or newer`,
      unflagged: 'the `--experimental-sqlite` startup flag is not required',
      stability: 'Node 22 still labels the module experimental',
    },
    {
      path: 'README.zh-CN.md',
      requirement: `Node.js ${documentedVersion} 或更高版本`,
      unflagged: '无需 `--experimental-sqlite` 启动参数',
      stability: 'Node 22 仍将该模块标为实验性',
    },
    {
      path: 'docs/sdk/README.md',
      requirement: `Node.js ${documentedVersion} or newer`,
      unflagged: 'the `--experimental-sqlite` startup flag is not required',
      stability: 'Node 22 still labels the module experimental',
    },
    {
      path: 'docs/sdk/README.zh-CN.md',
      requirement: `Node.js ${documentedVersion} 或更高版本`,
      unflagged: '无需 `--experimental-sqlite` 启动参数',
      stability: 'Node 22 仍将该模块标为实验性',
    },
  ];
  for (const contract of documentationContracts) {
    const content = readFileSync(join(packageRoot, contract.path), 'utf8');
    if (
      !content.includes(contract.requirement) ||
      !content.includes(contract.unflagged) ||
      !content.includes(contract.stability)
    ) {
      throw new Error(
        `${contract.path} does not document the published Node.js engine ${nodeEngine} and its unflagged node:sqlite requirement.`,
      );
    }
  }

  const badgeContracts = [
    { path: 'README.md', label: `Node.js ${documentedVersion}+` },
    { path: 'README.zh-CN.md', label: `Node.js ${documentedVersion}+` },
  ];
  const encodedEngine = `node-%3E%3D${documentedVersion}`;
  for (const contract of badgeContracts) {
    const content = readFileSync(join(packageRoot, contract.path), 'utf8');
    if (!content.includes(contract.label) || !content.includes(encodedEngine)) {
      throw new Error(`${contract.path} Node.js badge does not match ${nodeEngine}.`);
    }
  }
}

function verifySdkExports(sdk) {
  for (const exportedName of [
    'DatabaseAgentRuntime',
    'DatabaseAccessRuntime',
    'PostgresConnector',
    'OpenAICompatibleProvider',
    'AnthropicProvider',
    'LlmGateway',
    'ResourceRegistry',
    'InMemoryResourceSnapshotStore',
    'JsonFileResourceSnapshotStore',
    'ContractValidationError',
    'DatabaseAgentError',
    'stringifyPublicJson',
    'parsePublicJson',
    'assertResourceDescriptor',
    'createProviderFromPreset',
    'initializeAgentProject',
  ]) {
    if (typeof sdk[exportedName] !== 'function') {
      throw new Error(`Public SDK export is missing: ${exportedName}`);
    }
  }
  if (sdk.CURRENT_CONTRACT_VERSION !== '1.0') {
    throw new Error('The current public contract version is not exported.');
  }
}

function createIsolatedRuntimePaths(scope) {
  if (!validationRoot) {
    throw new Error('Package validation root has not been initialized.');
  }
  const root = join(validationRoot, scope);
  const paths = {
    projectDirectory: join(root, 'project'),
    userSkillsDirectory: join(root, 'user-skills'),
    sessionDatabasePath: join(root, 'state', 'schemanaut.db'),
  };
  for (const path of [
    paths.projectDirectory,
    paths.userSkillsDirectory,
    dirname(paths.sessionDatabasePath),
  ]) {
    assertValidationPath(path);
    mkdirSync(path, { recursive: true });
  }
  assertValidationPath(paths.sessionDatabasePath);
  return paths;
}

function assertValidationPath(path) {
  if (!validationRoot) {
    throw new Error('Package validation root has not been initialized.');
  }
  const fromRoot = relative(resolve(validationRoot), resolve(path));
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Package verification path escapes its validation root: ${path}`);
  }
}

async function verifyRuntimeBehavior(sdk) {
  const paths = createIsolatedRuntimePaths('sdk-runtime');
  const project = await sdk.initializeAgentProject(paths.projectDirectory);
  const runtime = new sdk.DatabaseAgentRuntime({
    projectDirectory: paths.projectDirectory,
    userSkillsDirectory: paths.userSkillsDirectory,
    sessionDatabasePath: paths.sessionDatabasePath,
  });
  try {
    const postgres = runtime.database.connectors
      .list()
      .find((connector) => connector.engine === 'postgres');
    if (!postgres || !postgres.capabilities['sql.query']) {
      throw new Error('The PostgreSQL reference connector is not registered.');
    }
    if (runtime.resources !== runtime.database.resources) {
      throw new Error('The SDK exposed separate product and database resource registries.');
    }
    const skills = await runtime.listAgentSkills();
    if (runtime.tools.list().length === 0 || skills.length < 4) {
      throw new Error('AI SQL tools or packaged system Skills are missing.');
    }
    if ((await runtime.listMcpServers()).length !== 0) {
      throw new Error('A fresh packaged project unexpectedly contains default MCP servers.');
    }
    if (
      typeof runtime.runAgent !== 'function' ||
      typeof runtime.compactAgentSession !== 'function' ||
      typeof runtime.agentContextCheckpoints !== 'function' ||
      typeof runtime.listAgentApprovals !== 'function'
    ) {
      throw new Error('Agent, approval, or context-compaction entrypoints are missing.');
    }

    runtime.resources.upsertResource({
      id: 'npm-resource-verification',
      kind: 'database',
      nativeId: 'npm-resource-verification',
      canonicalName: 'npm-resource-verification',
      version: 1,
      firstSeenAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      sources: [
        {
          sourceId: 'npm-verifier',
          sourceType: 'manual',
          observedAt: '2026-07-25T00:00:00.000Z',
        },
      ],
    });
    if (
      runtime.resources.query({ kinds: ['database'] }).items[0]?.id !== 'npm-resource-verification'
    ) {
      throw new Error('The packaged resource runtime cannot write and query real state.');
    }

    const transported = sdk.parsePublicJson(
      sdk.stringifyPublicJson({
        value: 9_007_199_254_740_993n,
        binary: Uint8Array.from([0, 255]),
      }),
    );
    if (
      transported.value !== 9_007_199_254_740_993n ||
      !(transported.binary instanceof Uint8Array)
    ) {
      throw new Error('Portable JSON did not preserve bigint and binary values.');
    }

    await runtime.sessions.save({
      session: {
        id: 'package-session',
        title: 'Package verification',
        userId: 'package-user',
        mode: 'read',
        messages: [
          {
            role: 'user',
            content: 'Inspect the packaged runtime.',
            createdAt: '2026-07-25T00:00:00.000Z',
          },
        ],
        tokenUsage: {
          promptTokens: 5,
          completionTokens: 0,
          totalTokens: 5,
        },
        project: {
          rootPath: project.rootPath,
          configDirectory: project.configDirectory,
        },
        aborted: false,
      },
    });
    const loaded = await runtime.getAgentSession('package-session');
    const listed = await runtime.listAgentSessions({ userId: 'package-user' });
    if (
      loaded?.messages.length !== 1 ||
      listed[0]?.id !== 'package-session' ||
      listed[0]?.conversationMessageCount !== 1
    ) {
      throw new Error('The packaged public Session APIs failed a save/load/list scenario.');
    }
  } finally {
    await runtime.close();
  }
}

async function verifyInstalledPackagePostgres(sdk) {
  const config = readPackagePostgresConfig(process.env);
  if (!config) return;
  const paths = createIsolatedRuntimePaths('postgres-runtime');
  await sdk.initializeAgentProject(paths.projectDirectory);
  const runtime = new sdk.DatabaseAgentRuntime({
    projectDirectory: paths.projectDirectory,
    userSkillsDirectory: paths.userSkillsDirectory,
    sessionDatabasePath: paths.sessionDatabasePath,
  });
  try {
    await runtime.connect({
      name: 'Isolated package PostgreSQL acceptance',
      ...config,
      readOnly: true,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 15_000,
    });
    const profile = runtime.database.listProfiles()[0];
    if (!profile) throw new Error('The installed package did not retain its PostgreSQL profile.');

    const selected = await runtime.database.submit({
      profileId: profile.id,
      sql: 'SELECT 1::int AS package_probe',
      executionMode: 'sync',
      authorization: { permissionMode: 'read' },
    });
    if (selected.state !== 'succeeded' || !selected.result) {
      throw new Error('The installed package could not execute a PostgreSQL SELECT.');
    }
    const selectedRows = await runtime.database.readResult(selected.result.id, { limit: 2 });
    if (
      selectedRows.rows.length !== 1 ||
      selectedRows.rows[0]?.package_probe !== 1 ||
      selectedRows.complete !== true
    ) {
      throw new Error('The installed package returned an unexpected PostgreSQL SELECT result.');
    }

    const blockedWrite = await runtime.database.submit({
      profileId: profile.id,
      sql: 'CREATE TEMP TABLE schemanaut_package_read_only_probe(id integer)',
      executionMode: 'sync',
      confirmed: true,
      authorization: { permissionMode: 'full' },
    });
    if (blockedWrite.state !== 'failed' || blockedWrite.error?.code !== 'READ_ONLY_VIOLATION') {
      throw new Error('The installed package did not enforce its physical read-only connection.');
    }

    const cancellable = await runtime.database.submit({
      profileId: profile.id,
      sql: 'SELECT pg_sleep(10)',
      executionMode: 'async',
      timeoutMs: 15_000,
      authorization: { permissionMode: 'read' },
    });
    await waitForDatabaseJob(
      runtime.database,
      cancellable.id,
      (job) => job.state === 'running' || isTerminalDatabaseJob(job),
      5_000,
    );
    const cancellation = await runtime.database.cancel(cancellable.id);
    const cancelled = isTerminalDatabaseJob(cancellation)
      ? cancellation
      : await waitForDatabaseJob(runtime.database, cancellable.id, isTerminalDatabaseJob, 5_000);
    if (cancelled.state !== 'cancelled') {
      throw new Error('The installed package did not cancel its PostgreSQL query job.');
    }
  } finally {
    await runtime.close();
  }
}

async function waitForDatabaseJob(database, jobId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let job = await database.getJob(jobId);
  while (!predicate(job)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out while waiting for an installed-package PostgreSQL job.');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    job = await database.getJob(jobId);
  }
  return job;
}

function isTerminalDatabaseJob(job) {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state);
}

async function verifyServerBehavior(consumerRoot, sdk) {
  const consumerRequire = createRequire(join(consumerRoot, 'package.json'));
  const serverEntry = consumerRequire.resolve('@nwlworkshop/schemanaut/server');
  const serverModule = await import(pathToFileURL(serverEntry).href);
  const paths = createIsolatedRuntimePaths('server-runtime');
  await sdk.initializeAgentProject(paths.projectDirectory);
  const runtime = new sdk.DatabaseAgentRuntime({
    projectDirectory: paths.projectDirectory,
    userSkillsDirectory: paths.userSkillsDirectory,
    sessionDatabasePath: paths.sessionDatabasePath,
  });
  let started;
  try {
    started = await serverModule.startDatabaseAgentServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
    });
    const healthResponse = await fetch(`${started.url}/health`);
    const health = await healthResponse.json();
    if (
      healthResponse.status !== 200 ||
      health.status !== 'ok' ||
      health.service !== 'schemanaut-server'
    ) {
      throw new Error(`Packaged REST server health check failed: ${JSON.stringify(health)}`);
    }
    const html = await (await fetch(started.url)).text();
    if (!html.includes('<h1>SchemaNaut</h1>')) {
      throw new Error('Packaged WebUI does not use SchemaNaut branding.');
    }
    const capabilitiesResponse = await fetch(`${started.url}/v1/capabilities`);
    const capabilities = await capabilitiesResponse.json();
    if (
      capabilitiesResponse.status !== 200 ||
      !capabilities.agentOperations?.includes('mcp-lifecycle') ||
      !capabilities.safety?.permissionModes?.includes('full')
    ) {
      throw new Error('Packaged REST capabilities do not describe the Agent runtime.');
    }
    const [skillsResponse, sessionsResponse, mcpResponse] = await Promise.all([
      fetch(`${started.url}/v1/agent/skills`),
      fetch(`${started.url}/v1/agent/sessions`),
      fetch(`${started.url}/v1/agent/mcp`),
    ]);
    const [skills, sessions, mcpServers] = await Promise.all([
      skillsResponse.json(),
      sessionsResponse.json(),
      mcpResponse.json(),
    ]);
    if (
      skillsResponse.status !== 200 ||
      !skills.some((skill) => skill.name === 'query-and-answer') ||
      sessionsResponse.status !== 200 ||
      !Array.isArray(sessions) ||
      sessions.length !== 0 ||
      mcpResponse.status !== 200 ||
      !Array.isArray(mcpServers) ||
      mcpServers.length !== 0
    ) {
      throw new Error('Packaged REST management endpoints are not isolated from host state.');
    }
  } finally {
    if (started) await started.close();
    else await runtime.close();
  }
  if (!existsSync(paths.sessionDatabasePath)) {
    throw new Error('The packaged REST server did not write its isolated state database.');
  }
}

function verifyCliBehavior(consumerRoot) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !existsSync(pnpmCli)) {
    throw new Error('Run CLI verification through pnpm so the locally installed bin can be used.');
  }
  const binPath = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'schemanaut.cmd' : 'schemanaut',
  );
  if (!existsSync(binPath)) {
    throw new Error('The isolated install did not create the local `schemanaut` CLI bin.');
  }
  const projectDirectory = join(validationRoot, 'cli-project');
  const cliHome = join(validationRoot, 'cli-home');
  const cliLocalData = join(validationRoot, 'cli-local-data');
  const cliState = join(validationRoot, 'cli-state');
  mkdirSync(cliHome, { recursive: true });
  mkdirSync(cliLocalData, { recursive: true });
  mkdirSync(cliState, { recursive: true });
  const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
  const env = {
    ...process.env,
    HOME: cliHome,
    USERPROFILE: cliHome,
    LOCALAPPDATA: cliLocalData,
    XDG_DATA_HOME: cliLocalData,
    SCHEMANAUT_STATE_DATABASE_PATH: join(cliState, 'schemanaut.db'),
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = [dirname(process.execPath), inheritedPath].filter(Boolean).join(delimiter);
  const runLocalCli = (args) =>
    runCaptured(process.execPath, [pnpmCli, 'exec', 'schemanaut', ...args], consumerRoot, env);
  const help = runLocalCli(['--help']);
  if (!help.stdout.includes('SchemaNaut') || !help.stdout.includes('Usage:')) {
    throw new Error(`Packaged CLI help verification failed: ${help.stderr || help.stdout}`);
  }
  runLocalCli(['init', projectDirectory]);
  if (
    !existsSync(join(projectDirectory, '.schemanaut', 'mcp.json')) ||
    !existsSync(join(projectDirectory, 'sql'))
  ) {
    throw new Error('Packaged CLI init did not create the expected project structure.');
  }
  const skills = runLocalCli(['skills', '-C', projectDirectory]);
  if (!skills.stdout.includes('query-and-answer')) {
    throw new Error(`Packaged CLI did not load system Skills: ${skills.stderr || skills.stdout}`);
  }
  const sessions = runLocalCli(['sessions', '-C', projectDirectory]);
  if (!sessions.stdout.includes('暂无会话')) {
    throw new Error(`Packaged CLI Session listing failed: ${sessions.stderr || sessions.stdout}`);
  }
}

function installPackageInIsolatedConsumer() {
  const consumerRoot = join(validationRoot, 'consumer');
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@nwlworkshop/schemanaut': `file:${artifactPath.replaceAll('\\', '/')}`,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !existsSync(pnpmCli)) {
    throw new Error('Run verification through pnpm so an isolated install can be created.');
  }
  const installMode =
    process.env.SCHEMANAUT_PACKAGE_VERIFY_INSTALL_MODE?.trim().toLowerCase() || 'offline';
  const installModeArgs =
    installMode === 'offline'
      ? ['--offline']
      : installMode === 'prefer-offline'
        ? ['--prefer-offline']
        : installMode === 'online'
          ? []
          : undefined;
  if (!installModeArgs) {
    throw new Error(
      'SCHEMANAUT_PACKAGE_VERIFY_INSTALL_MODE must be offline, prefer-offline, or online.',
    );
  }
  run(
    process.execPath,
    [pnpmCli, 'install', ...installModeArgs, '--ignore-scripts', '--no-frozen-lockfile'],
    consumerRoot,
  );
  return consumerRoot;
}

function assertInternalImportsArePortable(distRoot) {
  for (const path of runtimeFiles(distRoot)) {
    const content = readFileSync(path, 'utf8');
    if (content.includes('@dbagent/')) {
      throw new Error(`Package still contains a workspace-only import: ${path}`);
    }
  }
}

function assertExpectedRuntimeModulesExist(packageRoot) {
  for (const name of [
    'shared',
    'core-usage',
    'core-llm',
    'core-resource',
    'core-db',
    'core-rag',
    'core-skills',
    'core-agent',
    'core-tools',
  ]) {
    if (!existsSync(join(packageRoot, 'dist', 'internal', name, 'index.js'))) {
      throw new Error(`Packaged runtime module is missing: ${name}`);
    }
  }
  for (const skillName of [
    'query-and-answer',
    'discover-schema-and-shape',
    'write-and-verify',
    'recover-from-sql-error',
  ]) {
    if (
      !existsSync(
        join(packageRoot, 'dist', 'internal', 'core-skills', 'skills', skillName, 'SKILL.md'),
      )
    ) {
      throw new Error(`Packaged system Skill is missing: ${skillName}`);
    }
  }
}

function assertLegacyArtifactsAreAbsent(packageRoot) {
  const legacyPaths = [
    'dist/internal/shared/domain.js',
    'dist/internal/shared/domain.d.ts',
    'dist/internal/shared/result.js',
    'dist/internal/shared/result.d.ts',
    'dist/internal/shared/runtime-contracts.js',
    'dist/internal/shared/runtime-contracts.d.ts',
    'dist/internal/shared/database-access-contracts.js',
    'dist/internal/shared/database-access-contracts.d.ts',
    'dist/internal/core-db/resource-registry.js',
    'dist/internal/core-db/resource-registry.d.ts',
  ];
  const found = legacyPaths.filter((path) => existsSync(join(packageRoot, path)));
  if (found.length > 0) {
    throw new Error(`Package contains deleted legacy artifacts: ${found.join(', ')}`);
  }
  for (const path of allFiles(packageRoot)) {
    if (!/\.(?:[cm]?js|ts|json|md)$/i.test(path)) continue;
    const markers = findLegacyPublicContractMarkers(readFileSync(path, 'utf8'));
    if (markers.length > 0) {
      const relativePath = path.slice(packageRoot.length + 1);
      throw new Error(
        `Package contains legacy public contract marker ${markers[0]} in ${relativePath}.`,
      );
    }
  }
}

function assertInternalReleaseArtifactsAreAbsent(packageRoot) {
  const forbiddenPaths = [
    'docs/superpowers',
    'reports',
    'scripts',
    '.github',
    '.env',
    '.env.local',
  ];
  const found = forbiddenPaths.filter((path) => existsSync(join(packageRoot, path)));
  if (found.length > 0) {
    throw new Error(`Package contains internal release artifacts: ${found.join(', ')}`);
  }
}

function assertPackageContainsNoSecrets(packageRoot) {
  for (const path of allFiles(packageRoot)) {
    const name = basename(path).toLowerCase();
    if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
      throw new Error(`Package contains an environment file: ${path}`);
    }
    const content = readFileSync(path, 'utf8');
    const matches = findSecretMatches(content);
    if (matches.length > 0) {
      const first = matches[0];
      const relativePath = path.slice(packageRoot.length + 1);
      throw new Error(
        `Package secret scan matched ${first.rule} in ${relativePath} at line ${first.line}.`,
      );
    }
  }
}

function verifyMarkdownLinks(packageRoot) {
  for (const path of allFiles(packageRoot).filter((file) => file.endsWith('.md'))) {
    const content = readFileSync(path, 'utf8');
    for (const match of content.matchAll(/!?\[[^\]\n]*\]\(([^)]+)\)/g)) {
      const normalized = match[1]?.trim();
      if (
        !normalized ||
        normalized.startsWith('#') ||
        normalized.startsWith('//') ||
        /^[a-z][a-z0-9+.-]*:/i.test(normalized)
      ) {
        continue;
      }
      const unwrapped =
        normalized.startsWith('<') && normalized.endsWith('>')
          ? normalized.slice(1, -1)
          : normalized;
      const target = unwrapped.split(/[?#]/, 1)[0];
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // Keep the original path so the error reports the broken source text.
      }
      if (!existsSync(resolve(path, '..', decoded))) {
        throw new Error(`Package Markdown link is broken: ${path} -> ${normalized}`);
      }
    }
  }
}

function allFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...allFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function runtimeFiles(directory) {
  return allFiles(directory).filter((path) => path.endsWith('.js') || path.endsWith('.d.ts'));
}

function verifyTypeDeclarations(consumerRoot) {
  writeFileSync(
    join(consumerRoot, 'consumer.mts'),
    `import {
  DatabaseAgentRuntime,
  CURRENT_CONTRACT_VERSION,
  createContractEnvelope,
  createProviderFromPreset,
  type ConnectionProfile,
  type ResourceScope,
  type QuerySubmission,
  type RunAiSqlAgentInput,
} from '@nwlworkshop/schemanaut';

const provider = createProviderFromPreset('ollama');
const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('LLM_API_KEY is required');
const cloudProvider = createProviderFromPreset('siliconflow', { apiKey });
const runtime = new DatabaseAgentRuntime({
  provider,
  model: 'qwen2.5-coder:14b',
  sessionDatabasePath: './data/schemanaut.db',
  approvalProvider: ({ tool }) => tool.readonly === true,
});
const profile = {} as ConnectionProfile;
const scope = { tenantId: 'team-a' } satisfies ResourceScope;
const query = {
  profileId: profile.id,
  sql: 'select 1',
  timeoutMs: 1000,
} satisfies QuerySubmission;
const agentInput = {
  message: 'Count orders',
  mode: 'read',
} satisfies RunAiSqlAgentInput;
const envelope = createContractEnvelope('schemanaut.test', {
  version: CURRENT_CONTRACT_VERSION,
});
void runtime.resources.query({ scope });
void runtime.database.submit(query);
void runtime.runAgent(agentInput);
void runtime.sessions.list({ limit: 10 });
void cloudProvider;
void envelope;
`,
    'utf8',
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
          typeRoots: [join(repositoryRoot, 'node_modules', '@types')],
        },
        include: ['./consumer.mts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  run(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(consumerRoot, 'tsconfig.json'),
    ],
    consumerRoot,
  );
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
    throw new Error(`${command} failed with exit code ${result.status ?? 1}.`);
  }
}

function runCaptured(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? 1}: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}
