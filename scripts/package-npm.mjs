#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
  const cliPath = join(distDirectory, 'cli.js');

  await build({
    entryPoints: [join(repositoryRoot, 'apps', 'server', 'src', 'cli.ts')],
    outfile: cliPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    external: ['pg'],
    logLevel: 'info',
  });
  chmodSync(cliPath, 0o755);

  const packageManifest = {
    name: packageName,
    version,
    description: 'Local-first NL2SQL service with a CLI, REST API and lightweight WebUI.',
    type: 'module',
    bin: { dbagent: './dist/cli.js' },
    files: ['dist/cli.js', 'README.md', 'THIRD_PARTY_NOTICES.md'],
    engines: { node: '>=20.11.0' },
    dependencies: { pg: '^8.13.1' },
    keywords: ['database', 'postgresql', 'nl2sql', 'text-to-sql', 'ai', 'cli'],
    license: 'UNLICENSED',
    publishConfig: { access: 'public' },
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

这是 DBAgent 当前的本地试用包，提供 CLI、REST API 和轻量 WebUI。当前能力是连接 PostgreSQL 只读账号、索引 Schema、自然语言生成 SQL、安全检查，以及用户显式确认后的只读执行。

## 直接运行

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
- 当前只支持 PostgreSQL，只接受只读查询。
- 生成 SQL 与执行分离，不会自动执行模型输出。
- 模型密钥和数据库密码仅保存在当前进程内存。
- 这是早期试用版本，不建议直接用于生产环境。

完整源码、SDK 进度和模块设计请查看 DBAgent 仓库文档。
`;
}

function thirdPartyNotices() {
  return `# Third-party notices

The CLI package declares \`pg\` as a runtime dependency. The PostgreSQL client and its transitive dependencies retain their own licenses in the installed dependency tree. See each dependency's package metadata and license file for the authoritative terms.

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
