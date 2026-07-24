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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const serverManifest = readJson(join(repositoryRoot, 'apps', 'server', 'package.json'));
const version = requireString(serverManifest.version, 'apps/server/package.json version');
const packageName = '@nwlworkshop/schemanaut';
const releaseRoot = join(repositoryRoot, 'release');
const releaseDirectory = join(releaseRoot, `SchemaNaut-v${version}`);
const artifactName = `schemanaut-v${version}.tgz`;
const artifactPath = join(releaseDirectory, artifactName);
const checksumPath = join(releaseDirectory, 'SHA256SUMS.txt');
const stagingDirectory = mkdtempSync(join(tmpdir(), 'schemanaut-npm-'));

assertChildPath(releaseRoot, releaseDirectory);
mkdirSync(releaseDirectory, { recursive: true });
rmSync(artifactPath, { force: true });
rmSync(checksumPath, { force: true });

try {
  const distDirectory = join(stagingDirectory, 'dist');
  mkdirSync(distDirectory, { recursive: true });
  copyPublicRuntime(distDirectory);
  chmodSync(join(distDirectory, 'server', 'cli.js'), 0o755);
  copyPublicFiles(stagingDirectory);

  const packageManifest = {
    name: packageName,
    version,
    description:
      'Embeddable AI database agent runtime for natural-language SQL, governance and operations.',
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
    bin: { schemanaut: './dist/server/cli.js' },
    files: [
      'dist',
      'docs',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
    ],
    engines: { node: '>=22.5.0' },
    dependencies: {
      ajv: '8.20.0',
      'node-sql-parser': '^5.4.0',
      pg: '^8.13.1',
    },
    keywords: [
      'ai',
      'agent',
      'database',
      'database-agent',
      'database-operations',
      'governance',
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

  writeFileSync(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
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

function copyPublicFiles(targetRoot) {
  for (const name of [
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    const source = join(repositoryRoot, name);
    if (!existsSync(source)) throw new Error(`Missing public release file: ${source}`);
    copyFileSync(source, join(targetRoot, name));
  }
  copyMarkdownDirectory(
    join(repositoryRoot, 'docs'),
    join(targetRoot, 'docs'),
  );
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
