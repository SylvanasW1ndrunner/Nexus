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
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const version = JSON.parse(
  readFileSync(join(repositoryRoot, 'apps', 'server', 'package.json'), 'utf8'),
).version;
const artifactPath = join(
  repositoryRoot,
  'release',
  `SchemaNaut-v${version}`,
  `schemanaut-v${version}.tgz`,
);
const validationRoot = mkdtempSync(join(tmpdir(), 'schemanaut-package-validation-'));

try {
  if (!existsSync(artifactPath)) throw new Error(`npm archive does not exist: ${artifactPath}`);
  run('tar', ['-xf', artifactPath, '-C', validationRoot], repositoryRoot);

  const packageRoot = join(validationRoot, 'package');
  verifyManifest(packageRoot);
  verifyPublicFiles(packageRoot);
  assertInternalImportsArePortable(join(packageRoot, 'dist'));
  assertExpectedRuntimeModulesExist(packageRoot);
  assertLegacyArtifactsAreAbsent(packageRoot);
  assertPackageContainsNoSecrets(packageRoot);

  linkRuntimeDependency(
    packageRoot,
    'pg',
    join(repositoryRoot, 'packages', 'core-db', 'package.json'),
  );
  linkRuntimeDependency(
    packageRoot,
    'node-sql-parser',
    join(repositoryRoot, 'packages', 'core-db', 'package.json'),
  );
  linkRuntimeDependency(
    packageRoot,
    'ajv',
    join(repositoryRoot, 'packages', 'core-llm', 'package.json'),
  );

  const sdk = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
  verifySdkExports(sdk);
  await verifyRuntimeBehavior(sdk);
  await verifyServerBehavior(packageRoot);
  verifyCliBehavior(packageRoot);
  verifyTypeDeclarations(packageRoot);

  process.stdout.write(
    `SchemaNaut npm package verification passed (${version}): manifest, public files, secret scan, SDK, sessions, server, CLI and TypeScript declarations.\n`,
  );
} finally {
  rmSync(validationRoot, { recursive: true, force: true });
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
  if (manifest.engines?.node !== '>=22.5.0') {
    throw new Error(`Unexpected Node.js engine: ${String(manifest.engines?.node)}`);
  }
  if (manifest.bin?.schemanaut !== './dist/server/cli.js') {
    throw new Error('The public `schemanaut` CLI entry is missing.');
  }
  for (const dependency of ['ajv', 'node-sql-parser', 'pg']) {
    if (typeof manifest.dependencies?.[dependency] !== 'string') {
      throw new Error(`Runtime dependency is missing from package.json: ${dependency}`);
    }
  }
}

function verifyPublicFiles(packageRoot) {
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
  ]) {
    if (typeof sdk[exportedName] !== 'function') {
      throw new Error(`Public SDK export is missing: ${exportedName}`);
    }
  }
  if (sdk.CURRENT_CONTRACT_VERSION !== '1.0') {
    throw new Error('The current public contract version is not exported.');
  }
}

async function verifyRuntimeBehavior(sdk) {
  const sessionDatabasePath = join(validationRoot, 'runtime-data', 'schemanaut.db');
  const runtime = new sdk.DatabaseAgentRuntime({ sessionDatabasePath });
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
    if (runtime.tools.list().length === 0 || runtime.skills.list().length === 0) {
      throw new Error('AI SQL tools or built-in Skills are missing from the packaged runtime.');
    }
    if (
      typeof runtime.runAgent !== 'function' ||
      typeof runtime.compactAgentSession !== 'function' ||
      typeof runtime.agentContextCheckpoints !== 'function'
    ) {
      throw new Error('Agent and context-compaction entrypoints are missing.');
    }

    runtime.resources.upsertResource({
      id: 'npm-resource-verification',
      kind: 'database',
      nativeId: 'npm-resource-verification',
      canonicalName: 'npm-resource-verification',
      version: 1,
      firstSeenAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      sources: [{
        sourceId: 'npm-verifier',
        sourceType: 'manual',
        observedAt: '2026-07-25T00:00:00.000Z',
      }],
    });
    if (
      runtime.resources.query({ kinds: ['database'] }).items[0]?.id !==
      'npm-resource-verification'
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
        strategy: 'react',
        messages: [{
          role: 'user',
          content: 'Inspect the packaged runtime.',
          createdAt: '2026-07-25T00:00:00.000Z',
        }],
        tokenUsage: {
          promptTokens: 5,
          completionTokens: 0,
          totalTokens: 5,
        },
        aborted: false,
      },
    });
    const loaded = await runtime.sessions.load('package-session');
    const listed = await runtime.sessions.list({ userId: 'package-user' });
    if (loaded?.messages.length !== 1 || listed[0]?.id !== 'package-session') {
      throw new Error('The packaged SQLite Session store failed a save/load/list scenario.');
    }
  } finally {
    await runtime.close();
  }
}

async function verifyServerBehavior(packageRoot) {
  const serverModule = await import(
    pathToFileURL(join(packageRoot, 'dist', 'server', 'server.js')).href
  );
  const started = await serverModule.startDatabaseAgentServer({
    host: '127.0.0.1',
    port: 0,
  });
  try {
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
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      started.server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }
}

function verifyCliBehavior(packageRoot) {
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
  if (
    cli.status !== 0 ||
    !cli.stdout.includes('SchemaNaut') ||
    !cli.stdout.includes('Usage: schemanaut')
  ) {
    throw new Error(`Packaged CLI verification failed: ${cli.stderr || cli.stdout}`);
  }
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
}

function assertPackageContainsNoSecrets(packageRoot) {
  const secretPatterns = [
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi,
  ];
  for (const path of allFiles(packageRoot)) {
    const name = basename(path).toLowerCase();
    if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
      throw new Error(`Package contains an environment file: ${path}`);
    }
    const content = readFileSync(path, 'utf8');
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        throw new Error(`Package secret scan matched sensitive material in: ${path}`);
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
  return allFiles(directory).filter(
    (path) => path.endsWith('.js') || path.endsWith('.d.ts'),
  );
}

function verifyTypeDeclarations(packageRoot) {
  const consumerRoot = join(validationRoot, 'consumer');
  const scopeRoot = join(consumerRoot, 'node_modules', '@nwlworkshop');
  mkdirSync(scopeRoot, { recursive: true });
  symlinkSync(packageRoot, join(scopeRoot, 'schemanaut'), 'junction');
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
  createProviderFromPreset,
  type ConnectionProfile,
  type ResourceScope,
  type QuerySubmission,
  type RunAiSqlAgentInput,
} from '@nwlworkshop/schemanaut';

const provider = createProviderFromPreset('ollama');
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
