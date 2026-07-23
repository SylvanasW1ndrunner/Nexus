#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const version = JSON.parse(
  readFileSync(join(repositoryRoot, 'apps', 'server', 'package.json'), 'utf8'),
).version;
const artifactPath = join(
  repositoryRoot,
  'release',
  `DBAgent-v${version}`,
  `dbagent-v${version}.tgz`,
);
const validationRoot = mkdtempSync(join(tmpdir(), 'dbagent-package-validation-'));

try {
  if (!existsSync(artifactPath)) throw new Error(`npm 包不存在：${artifactPath}`);
  run('tar', ['-xf', artifactPath, '-C', validationRoot], repositoryRoot);

  const packageRoot = join(validationRoot, 'package');
  assertInternalImportsArePortable(join(packageRoot, 'dist'));
  assertLegacyArtifactsAreAbsent(packageRoot);
  linkRuntimeDependency(packageRoot, 'pg', join(repositoryRoot, 'packages', 'core-db', 'package.json'));
  linkRuntimeDependency(packageRoot, 'ajv', join(repositoryRoot, 'packages', 'core-llm', 'package.json'));

  const sdk = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
  for (const exportedName of [
    'DatabaseAgentRuntime',
    'DatabaseAccessRuntime',
    'PostgresConnector',
    'LlmGateway',
    'ResourceRegistry',
    'InMemoryResourceSnapshotStore',
    'JsonFileResourceSnapshotStore',
    'ContractValidationError',
    'stringifyPublicJson',
    'parsePublicJson',
    'assertResourceDescriptor',
  ]) {
    if (typeof sdk[exportedName] !== 'function') {
      throw new Error(`npm SDK 缺少导出：${exportedName}`);
    }
  }
  const runtime = new sdk.DatabaseAgentRuntime();
  const postgres = runtime.database.connectors
    .list()
    .find((connector) => connector.engine === 'postgres');
  if (!postgres || !postgres.capabilities['sql.query']) {
    throw new Error('npm SDK 未注册完整的 PostgreSQL 参考连接器。');
  }
  if (sdk.CURRENT_CONTRACT_VERSION !== '1.0') {
    throw new Error('npm SDK 未导出当前公共合同版本。');
  }
  if (runtime.resources !== runtime.database.resources) {
    throw new Error('npm SDK 公开了彼此分离的资源运行时。');
  }
  runtime.resources.upsertResource({
    id: 'npm-resource-verification',
    kind: 'database',
    nativeId: 'npm-resource-verification',
    canonicalName: 'npm-resource-verification',
    version: 1,
    firstSeenAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    sources: [
      {
        sourceId: 'npm-verifier',
        sourceType: 'manual',
        observedAt: '2026-07-23T00:00:00.000Z',
      },
    ],
  });
  if (
    runtime.resources.query({ kinds: ['database'] }).items[0]?.id !==
    'npm-resource-verification'
  ) {
    throw new Error('npm SDK 资源运行时无法完成真实写入与查询。');
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
    throw new Error('npm SDK 公共传输编码无法无损往返。');
  }
  await runtime.close();

  const cli = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist', 'server', 'cli.js'), '--help'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cli.stdout.includes('用法：dbagent')) {
    throw new Error(`npm CLI 功能验证失败：${cli.stderr || cli.stdout}`);
  }

  verifyTypeDeclarations(packageRoot);
  process.stdout.write(
    `npm package functional verification passed: SDK exports, connector registration, CLI and TypeScript declarations (${version}).\n`,
  );
} finally {
  rmSync(validationRoot, { recursive: true, force: true });
}

function linkRuntimeDependency(packageRoot, name, requiringManifest) {
  const requireFromPackage = createRequire(requiringManifest);
  const dependencyRoot = dirname(requireFromPackage.resolve(`${name}/package.json`));
  const target = join(packageRoot, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(dependencyRoot, target, 'junction');
}

function assertInternalImportsArePortable(distRoot) {
  for (const path of runtimeFiles(distRoot)) {
    const content = readFileSync(path, 'utf8');
    if (content.includes('@dbagent/')) {
      throw new Error(`发布包仍包含工作区内部引用：${path}`);
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
    throw new Error(`发布包包含已删除的历史产物：${found.join(', ')}`);
  }
}

function runtimeFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...runtimeFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      result.push(path);
    }
  }
  return result;
}

function verifyTypeDeclarations(packageRoot) {
  const consumerRoot = join(validationRoot, 'consumer');
  const scopeRoot = join(consumerRoot, 'node_modules', '@nwlworkshop');
  mkdirSync(scopeRoot, { recursive: true });
  symlinkSync(packageRoot, join(scopeRoot, 'dbagent'), 'junction');
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(consumerRoot, 'consumer.mts'),
    `import {
  DatabaseAgentRuntime,
  CURRENT_CONTRACT_VERSION,
  createContractEnvelope,
  type ConnectionProfile,
  type ResourceScope,
  type QuerySubmission,
} from '@nwlworkshop/dbagent';

const runtime = new DatabaseAgentRuntime();
const profile = {} as ConnectionProfile;
const scope = { tenantId: 'team-a' } satisfies ResourceScope;
const query = { profileId: profile.id, sql: 'select 1', timeoutMs: 1000 } satisfies QuerySubmission;
const envelope = createContractEnvelope('dbagent.test', { version: CURRENT_CONTRACT_VERSION });
void runtime.resources.query({ scope });
void runtime.database.submit(query);
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
    [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(consumerRoot, 'tsconfig.json')],
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
    throw new Error(`${command} 执行失败，退出码 ${result.status ?? 1}。`);
  }
}
