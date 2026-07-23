#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const serverManifest = readJson(join(repositoryRoot, 'apps', 'server', 'package.json'));
const version = requireString(serverManifest.version, 'apps/server/package.json version');
const packageName = '@nwlworkshop/dbagent';
const releaseRoot = join(repositoryRoot, 'release');
const releaseDirectory = join(releaseRoot, `DBAgent-v${version}`);
const artifactName = `dbagent-v${version}.tgz`;
const artifactPath = join(releaseDirectory, artifactName);
const checksumPath = join(releaseDirectory, 'SHA256SUMS.txt');
const stagingDirectory = mkdtempSync(join(tmpdir(), 'dbagent-npm-'));

assertChildPath(releaseRoot, releaseDirectory);
mkdirSync(releaseDirectory, { recursive: true });
rmSync(artifactPath, { force: true });
rmSync(checksumPath, { force: true });

try {
  const distDirectory = join(stagingDirectory, 'dist');
  mkdirSync(distDirectory, { recursive: true });
  copyPublicRuntime(distDirectory);
  const cliPath = join(distDirectory, 'server', 'cli.js');
  chmodSync(cliPath, 0o755);

  const packageManifest = {
    name: packageName,
    version,
    description: 'Embeddable AI database runtime with unified database access, NL2SQL, REST API, CLI and WebUI.',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    },
    bin: { dbagent: './dist/server/cli.js' },
    files: ['dist', 'README.md', 'THIRD_PARTY_NOTICES.md'],
    engines: { node: '>=20.11.0' },
    dependencies: {
      ajv: '8.20.0',
      pg: '^8.13.1',
    },
    keywords: [
      'database',
      'postgresql',
      'nl2sql',
      'text-to-sql',
      'ai',
      'llm',
      'dba',
      'sdk',
      'cli',
    ],
    license: 'UNLICENSED',
    publishConfig: { access: 'public' },
    sideEffects: false,
  };

  writeFileSync(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(stagingDirectory, 'README.md'), packageReadme(version), 'utf8');
  writeFileSync(
    join(stagingDirectory, 'THIRD_PARTY_NOTICES.md'),
    thirdPartyNotices(),
    'utf8',
  );

  pack(stagingDirectory, artifactPath);
  const checksum = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${artifactName}\n`, 'utf8');

  process.stdout.write(`npm package: ${artifactPath}\n`);
  process.stdout.write(`SHA256: ${checksum}\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

function pack(cwd, outputPath) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !existsSync(pnpmCli)) {
    throw new Error('请通过 pnpm package:npm 运行打包，以便定位 pnpm CLI。');
  }
  const generatedName = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const generatedPath = join(dirname(outputPath), generatedName);
  assertChildPath(releaseRoot, generatedPath);
  rmSync(generatedPath, { force: true });
  run(process.execPath, [pnpmCli, 'pack', '--pack-destination', dirname(outputPath)], cwd);
  if (!existsSync(generatedPath)) {
    throw new Error(`pnpm 未生成预期文件：${generatedPath}`);
  }
  renameSync(generatedPath, outputPath);
}

function packageReadme(packageVersion) {
  return `# @nwlworkshop/dbagent ${packageVersion}

DBAgent 提供可嵌入的 Node.js SDK，以及 CLI、REST API 和轻量 WebUI。当前包包含统一数据库资源模型、连接器与能力探测、PostgreSQL 连接、资源发现、查询作业、分页/流式结果、事务、取消、超时、观测、受控运维、审计，以及大模型与 NL2SQL 基础能力。

## 安装

\`\`\`bash
npm install @nwlworkshop/dbagent
\`\`\`

## SDK

\`\`\`ts
import { DatabaseAgentRuntime } from '@nwlworkshop/dbagent';

const runtime = new DatabaseAgentRuntime();
const now = new Date().toISOString();

runtime.database.createProfile({
  id: 'local-postgres',
  name: 'Local PostgreSQL',
  connectorId: 'postgres-native',
  engine: 'postgres',
  endpoints: [{
    transport: 'tcp',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
  }],
  principal: 'dbagent',
  purpose: 'read-only',
  readOnly: true,
  createdAt: now,
  updatedAt: now,
});

await runtime.database.connect('local-postgres', {
  username: 'dbagent',
  password: process.env.DB_PASSWORD,
});

await runtime.database.discoverAll('local-postgres');
const job = await runtime.database.submit({
  profileId: 'local-postgres',
  sql: 'select current_database() as database_name',
  timeoutMs: 5_000,
});

if (job.result) {
  console.log((await runtime.database.readResult(job.result.id)).rows);
}

const tables = runtime.resources.query({
  kinds: ['table'],
  engine: 'postgres',
  limit: 100,
});
if (tables.items[0]) {
  console.log(runtime.resources.state(tables.items[0].id));
}

await runtime.close();
\`\`\`

## CLI、REST API 与 WebUI

要求 Node.js 20.11 或更高版本：

\`\`\`bash
npx --yes @nwlworkshop/dbagent
\`\`\`

使用本地下载的 tgz：

\`\`\`bash
npx --yes --package ./dbagent-v${packageVersion}.tgz dbagent
\`\`\`

启动后打开 <http://127.0.0.1:3721>。端口被占用时：

\`\`\`bash
npx --yes --package ./dbagent-v${packageVersion}.tgz dbagent --port 3722
\`\`\`

## 安全边界

- 服务默认只监听本机。
- PostgreSQL 是首个参考连接器；统一合同允许后续接入 MySQL、数仓和集群。
- 生成 SQL 与执行分离；写入、DDL 和运维操作需要对应能力与显式授权。
- Secret 不写入连接档案、资源、错误详情、审计或 API 响应。
- 查询受安全检查、结果限制、数据库端超时和取消机制约束。
- 这是早期试用版本，不建议直接用于生产环境。

完整设计、API 和验收范围请查看 DBAgent 仓库文档。
`;
}

function copyPublicRuntime(distDirectory) {
  const runtimePackages = [
    {
      source: join(repositoryRoot, 'packages', 'sdk', 'dist'),
      target: distDirectory,
    },
    ...['shared', 'core-usage', 'core-llm', 'core-resource', 'core-db', 'core-rag'].map((name) => ({
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
}

function copyRuntimeDirectory(source, target, distDirectory) {
  if (!existsSync(source)) {
    throw new Error(`缺少编译产物目录：${source}`);
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
      (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts'))
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

function rewriteInternalImports(content, destinationPath, distDirectory) {
  const packageTargets = {
    '@dbagent/sdk': join(distDirectory, 'index.js'),
    '@dbagent/shared': join(distDirectory, 'internal', 'shared', 'index.js'),
    '@dbagent/core-usage': join(distDirectory, 'internal', 'core-usage', 'index.js'),
    '@dbagent/core-llm': join(distDirectory, 'internal', 'core-llm', 'index.js'),
    '@dbagent/core-resource': join(distDirectory, 'internal', 'core-resource', 'index.js'),
    '@dbagent/core-db': join(distDirectory, 'internal', 'core-db', 'index.js'),
    '@dbagent/core-rag': join(distDirectory, 'internal', 'core-rag', 'index.js'),
  };
  let rewritten = content.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  for (const [specifier, targetPath] of Object.entries(packageTargets)) {
    let pathFromDeclaration = relative(
      dirname(destinationPath),
      targetPath,
    ).replaceAll('\\', '/');
    if (!pathFromDeclaration.startsWith('.')) pathFromDeclaration = `./${pathFromDeclaration}`;
    rewritten = rewritten
      .replaceAll(`'${specifier}'`, `'${pathFromDeclaration}'`)
      .replaceAll(`"${specifier}"`, `"${pathFromDeclaration}"`);
  }
  return `${rewritten.trimEnd()}\n`;
}

function thirdPartyNotices() {
  return `# Third-party notices

The package declares \`pg\` and \`ajv\` as runtime dependencies. They and their transitive dependencies retain their own licenses in the installed dependency tree. See each dependency's package metadata and license file for the authoritative terms.

The LLM platform uses the following schema-validation dependencies:

- ajv 8.20.0 — MIT
- fast-deep-equal 3.1.3 — MIT
- fast-uri 3.1.4 — BSD-3-Clause
- json-schema-traverse 1.0.0 — MIT
- require-from-string 2.0.2 — MIT

Their copyright notices and license terms remain available in their upstream packages and repositories.

DBAgent itself is currently distributed as UNLICENSED software.
`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm pack 失败，退出码 ${result.status ?? 1}。`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 缺失。`);
  return value.trim();
}

function assertChildPath(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new Error(`发布路径越界：${child}`);
  }
}
