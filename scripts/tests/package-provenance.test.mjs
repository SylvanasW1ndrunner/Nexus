import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyPackageProvenance } from '../verify-npm-package.mjs';

const packageName = '@nwlworkshop/schemanaut';
const packageVersion = '0.1.0';
const artifactName = 'schemanaut-v0.1.0.tgz';
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

test('package provenance binds dirty-workspace inputs, payload and archive bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'schemanaut-provenance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repository');
  const packageRoot = join(root, 'package');
  const artifactPath = join(root, artifactName);
  const provenancePath = join(root, 'PROVENANCE.json');
  const sourcePaths = [];
  const buildOutputPaths = [];
  const packagePaths = [];

  for (const path of [
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
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'docs/product-functional-overview.md',
    'docs/test-pipeline.md',
    'docs/agent/README.md',
    'docs/ai-sql/README.md',
    'docs/cli/README.md',
    'docs/cli/README.zh-CN.md',
    'docs/foundation/README.md',
    'docs/sdk/README.md',
  ]) {
    sourcePaths.push(path);
    await writeFixtureFile(repositoryRoot, path, `source:${path}\n`);
  }
  for (const workspace of runtimeWorkspaces) {
    for (const path of [
      `${workspace}/package.json`,
      `${workspace}/tsconfig.json`,
      `${workspace}/src/index.ts`,
    ]) {
      sourcePaths.push(path);
      await writeFixtureFile(repositoryRoot, path, `source:${path}\n`);
    }
    for (const path of [`${workspace}/dist/index.js`, `${workspace}/dist/index.d.ts`]) {
      buildOutputPaths.push(path);
      await writeFixtureFile(repositoryRoot, path, `output:${path}\n`);
    }
  }
  const skillPath = 'packages/core-skills/skills/query-and-answer/SKILL.md';
  sourcePaths.push(skillPath);
  await writeFixtureFile(repositoryRoot, skillPath, '# Query and answer\n');

  for (const path of ['package.json', 'dist/index.js', 'docs/README.md']) {
    packagePaths.push(path);
    await writeFixtureFile(packageRoot, path, `payload:${path}\n`);
  }
  const artifactBytes = Buffer.from('fixture npm archive');
  await writeFile(artifactPath, artifactBytes);

  const provenance = {
    schemaVersion: 1,
    package: { name: packageName, version: packageVersion },
    workspaceIdentity: {
      method: 'sha256-file-manifest',
      workingTreeState: 'not-asserted',
    },
    sourceInputs: await snapshot(repositoryRoot, sourcePaths),
    buildOutputs: await snapshot(repositoryRoot, buildOutputPaths),
    packagePayload: await snapshot(packageRoot, packagePaths),
    artifact: {
      file: artifactName,
      sha256: sha256(artifactBytes),
      size: artifactBytes.length,
    },
  };
  await writeProvenance(provenancePath, provenance);

  const verify = () =>
    verifyPackageProvenance({
      repositoryRoot,
      artifactPath,
      artifactName,
      provenancePath,
      packageRoot,
      packageName,
      packageVersion,
    });

  assert.doesNotThrow(verify);

  const coreSourcePath = join(repositoryRoot, 'packages', 'core-llm', 'src', 'index.ts');
  const originalCoreSource = await readFile(coreSourcePath);
  await writeFile(coreSourcePath, Buffer.concat([originalCoreSource, Buffer.from('// changed\n')]));
  assert.throws(verify, /source inputs.*packages\/core-llm\/src\/index\.ts/i);
  await writeFile(coreSourcePath, originalCoreSource);

  await writeFile(artifactPath, Buffer.from('tampered archive'));
  assert.throws(verify, /archive does not match PROVENANCE/i);
  await writeFile(artifactPath, artifactBytes);

  provenance.workspaceIdentity.workingTreeState = 'clean';
  await writeProvenance(provenancePath, provenance);
  assert.throws(verify, /must not claim a clean working tree/i);
});

async function writeFixtureFile(root, path, content) {
  const destination = join(root, ...path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function snapshot(root, paths) {
  const files = [];
  for (const path of [...paths].sort()) {
    const content = await readFile(join(root, ...path.split('/')));
    files.push({
      path,
      sha256: sha256(content),
      size: content.length,
    });
  }
  return {
    algorithm: 'sha256',
    digest: snapshotDigest(files),
    files,
  };
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function writeProvenance(path, provenance) {
  await writeFile(path, `${JSON.stringify(provenance, null, 2)}\n`);
}
