#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const rootManifest = readJson(join(repositoryRoot, 'package.json'));
const serverManifest = readJson(join(repositoryRoot, 'apps', 'server', 'package.json'));
const version = requireString(serverManifest.version, 'apps/server/package.json version');
const registryPackageName = '@nwlworkshop/dbagent';
const esbuildVersion = requireString(
  rootManifest.devDependencies?.esbuild,
  'root devDependencies.esbuild',
).replace(/^[^0-9]*/, '');
const releaseDirectory = join(repositoryRoot, 'release', `HeadlessMVP-v${version}`);
const artifactName = `DBAgent-Headless-MVP-v${version}.tgz`;
const artifactPath = join(releaseDirectory, artifactName);
const checksumPath = join(releaseDirectory, 'SHA256SUMS.txt');
const stagingDirectory = mkdtempSync(join(tmpdir(), 'dbagent-npm-'));

assertInside(join(repositoryRoot, 'release'), releaseDirectory);
mkdirSync(releaseDirectory, { recursive: true });
rmSync(artifactPath, { force: true });
rmSync(checksumPath, { force: true });

try {
  const bundlePath = join(stagingDirectory, 'dbagent-server.mjs');
  const metafilePath = join(stagingDirectory, 'esbuild-meta.json');
  bundleServer(bundlePath, metafilePath);
  chmodSync(bundlePath, 0o755);

  const packageManifest = {
    name: registryPackageName,
    version,
    description: 'Local-first natural-language-to-SQL server with a minimal Web UI.',
    type: 'module',
    bin: {
      dbagent: './dbagent-server.mjs',
    },
    files: ['dbagent-server.mjs', 'README.md', 'THIRD_PARTY_LICENSES.txt'],
    engines: {
      node: '>=20.11.0',
    },
    keywords: ['database', 'postgresql', 'text-to-sql', 'ai', 'cli'],
    license: 'UNLICENSED',
  };

  writeFileSync(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(stagingDirectory, 'README.md'), packageReadme(version), 'utf8');
  writeFileSync(
    join(stagingDirectory, 'THIRD_PARTY_LICENSES.txt'),
    collectThirdPartyLicenses(metafilePath),
    'utf8',
  );

  pack(stagingDirectory, artifactPath);
  if (!existsSync(artifactPath)) {
    throw new Error(`npm 发布包未生成：${artifactPath}`);
  }

  const checksum = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${artifactName}\n`, 'utf8');

  process.stdout.write(`npm 发布包：${artifactPath}\n`);
  process.stdout.write(`SHA256：${checksum}\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

function bundleServer(bundlePath, metafilePath) {
  const esbuild = resolveEsbuildCommand();
  run(
    esbuild.command,
    [
      ...esbuild.args,
      './apps/server/src/cli.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      `--outfile=${bundlePath}`,
      `--metafile=${metafilePath}`,
      '--legal-comments=none',
    ],
    repositoryRoot,
    'esbuild',
    esbuild.env,
  );
}

function resolveEsbuildCommand() {
  const require = createRequire(join(repositoryRoot, 'package.json'));
  try {
    return { command: process.execPath, args: [require.resolve('esbuild/bin/esbuild')] };
  } catch {
    const virtualStore = join(repositoryRoot, 'node_modules', '.pnpm');
    if (existsSync(virtualStore)) {
      const directory = readdirSync(virtualStore).find(
        (entry) =>
          entry === `esbuild@${esbuildVersion}` || entry.startsWith(`esbuild@${esbuildVersion}_`),
      );
      if (directory) {
        const fallback = join(virtualStore, directory, 'node_modules', 'esbuild', 'bin', 'esbuild');
        if (existsSync(fallback)) return { command: process.execPath, args: [fallback] };
      }

      const nativePackage = `${process.platform}-${process.arch}`;
      const nativeDirectory = readdirSync(virtualStore).find(
        (entry) =>
          entry === `@esbuild+${nativePackage}@${esbuildVersion}` ||
          entry.startsWith(`@esbuild+${nativePackage}@${esbuildVersion}_`),
      );
      if (nativeDirectory) {
        const packageDirectory = join(
          virtualStore,
          nativeDirectory,
          'node_modules',
          '@esbuild',
          nativePackage,
        );
        const nativeExecutable =
          process.platform === 'win32'
            ? join(packageDirectory, 'esbuild.exe')
            : join(packageDirectory, 'bin', 'esbuild');
        if (existsSync(nativeExecutable)) {
          const runtimeNodePaths = readdirSync(virtualStore)
            .filter((entry) => /^(pg(@|\+|-)|postgres-|split2@|xtend@)/.test(entry))
            .map((entry) => join(virtualStore, entry, 'node_modules'));
          return {
            command: nativeExecutable,
            args: [],
            env: {
              ...process.env,
              NODE_PATH: runtimeNodePaths.join(delimiter),
            },
          };
        }
      }
    }
    throw new Error('没有找到 esbuild。请先运行 pnpm install。');
  }
}

function pack(cwd, outputPath) {
  const pnpmCli = resolvePnpmCli();
  const generatedName = `${registryPackageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const generatedPath = join(dirname(outputPath), generatedName);
  assertInside(join(repositoryRoot, 'release'), generatedPath);
  rmSync(generatedPath, { force: true });
  run(
    process.execPath,
    [pnpmCli, 'pack', '--pack-destination', dirname(outputPath)],
    cwd,
    'pnpm pack',
  );
  if (!existsSync(generatedPath)) {
    throw new Error(`pnpm 未生成预期文件：${generatedPath}`);
  }
  renameSync(generatedPath, outputPath);
}

function resolvePnpmCli() {
  const fromEnvironment = process.env.npm_execpath;
  if (fromEnvironment && existsSync(fromEnvironment)) return fromEnvironment;

  const bundled = join(
    dirname(dirname(process.execPath)),
    'node_modules',
    'pnpm',
    'bin',
    'pnpm.mjs',
  );
  if (existsSync(bundled)) return bundled;
  throw new Error('没有找到 pnpm CLI。请通过 pnpm package:mvp:npm 运行打包。');
}

function collectThirdPartyLicenses(metafilePath) {
  const metafile = readJson(metafilePath);
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const packageInfo = findPackageInfo(input);
    if (!packageInfo || packageInfo.name.startsWith('@dbagent/')) continue;
    packages.set(`${packageInfo.name}@${packageInfo.version}`, packageInfo);
  }
  if (packages.size === 0) {
    throw new Error('没有从 bundle 元数据中识别到第三方运行时依赖。');
  }

  const sections = [...packages.values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .map((entry) => {
      const licenseFile = readdirSync(entry.directory).find((name) =>
        /^(licen[cs]e|copying)(\..*)?$/i.test(name),
      );
      const licenseText = licenseFile
        ? readFileSync(join(entry.directory, licenseFile), 'utf8').trim()
        : '(上游包未附带独立许可证文件；请以 package.json 的 license 字段为准。)';
      return [
        '-'.repeat(72),
        `${entry.name}@${entry.version}`,
        `License: ${entry.license}`,
        '-'.repeat(72),
        licenseText,
      ].join('\n');
    });

  return [
    'DBAgent Headless MVP - Third-party runtime licenses',
    '',
    'This file is generated from the modules included in the release bundle.',
    '',
    ...sections,
    '',
  ].join('\n');
}

function findPackageInfo(input) {
  const absoluteInput = isAbsolute(input) ? input : resolve(repositoryRoot, input);
  let current = dirname(absoluteInput);
  while (current.startsWith(repositoryRoot)) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (typeof manifest.name === 'string' && current.includes(`${sep}node_modules${sep}`)) {
        return {
          directory: current,
          name: manifest.name,
          version: String(manifest.version ?? 'unknown'),
          license: formatLicense(manifest.license),
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function packageReadme(packageVersion) {
  return `# DBAgent Headless MVP ${packageVersion}

这是一个本地运行的自然语言转 SQL 预览版，包含 CLI、REST API 和极简 WebUI。

## 要求

- Node.js 20.11 或更高版本（Node 官方安装包自带 npm/npx）。
- 一个 PostgreSQL 只读账号。
- 一个 OpenAI-compatible 模型的 Base URL、API Key 和模型名。

## 直接运行下载包

\`\`\`bash
npx --yes ./DBAgent-Headless-MVP-v${packageVersion}.tgz
\`\`\`

启动后打开 <http://127.0.0.1:3721>。如果端口已占用：

\`\`\`bash
npx --yes --package ./DBAgent-Headless-MVP-v${packageVersion}.tgz dbagent --port 3722
\`\`\`

也可以全局安装：

\`\`\`bash
npm install --global ./DBAgent-Headless-MVP-v${packageVersion}.tgz
dbagent
\`\`\`

正式发布到 npm registry 后，可以直接运行：

\`\`\`bash
npx --yes @nwlworkshop/dbagent
\`\`\`

按 \`Ctrl+C\` 停止服务。运行时只监听本机；模型密钥和数据库密码仅保存在当前进程内存，重启后需要重新填写。

## 安全边界

- 当前只支持 PostgreSQL 和只读查询。
- 生成 SQL 后必须由用户显式点击执行。
- 请使用专用只读数据库账号。
- Schema 上下文会发送到你配置的模型服务；不要连接不允许外发元数据的数据库。
- 这是 MVP 试用包，不建议直接用于生产环境。
`;
}

function formatLicense(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') return JSON.stringify(value);
  return 'UNKNOWN';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 缺失。`);
  return value.trim();
}

function assertInside(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new Error(`发布目录越界：${child}`);
  }
}

function run(command, args, cwd, label, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} 失败，退出码 ${result.status ?? 'unknown'}。`);
}
