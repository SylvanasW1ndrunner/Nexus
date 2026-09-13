import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { PUBLIC_DOCUMENT_FILES } from './public-documents.mjs';

export const NPM_PACKAGE_NAME = '@nwlworkshop/schemanaut';
export const NPM_PACKAGE_VERSION = '0.1.0-alpha.3';
export const NPM_ARCHIVE_NAME = `schemanaut-v${NPM_PACKAGE_VERSION}.tgz`;
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

export function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args };
  const npmCliPath = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCliPath)) {
    throw new Error(`Unable to locate the npm CLI beside Node.js: ${npmCliPath}`);
  }
  return { command: process.execPath, args: [npmCliPath, ...args] };
}

export const RUNTIME_WORKSPACES = Object.freeze([
  { path: 'packages/shared', packageName: '@dbagent/shared', target: 'internal/shared' },
  { path: 'packages/core-usage', packageName: '@dbagent/core-usage', target: 'internal/core-usage' },
  { path: 'packages/core-llm', packageName: '@dbagent/core-llm', target: 'internal/core-llm' },
  { path: 'packages/core-resource', packageName: '@dbagent/core-resource', target: 'internal/core-resource' },
  { path: 'packages/core-db', packageName: '@dbagent/core-db', target: 'internal/core-db' },
  { path: 'packages/core-rag', packageName: '@dbagent/core-rag', target: 'internal/core-rag' },
  { path: 'packages/core-skills', packageName: '@dbagent/core-skills', target: 'internal/core-skills' },
  { path: 'packages/core-agent', packageName: '@dbagent/core-agent', target: 'internal/core-agent' },
  { path: 'packages/core-tools', packageName: '@dbagent/core-tools', target: 'internal/core-tools' },
  {
    path: 'packages/database-capability',
    packageName: '@dbagent/database-capability',
    target: 'internal/database-capability',
  },
  {
    path: 'packages/first-party-capabilities',
    packageName: '@dbagent/first-party-capabilities',
    target: 'internal/first-party-capabilities',
  },
  { path: 'packages/agent-host', packageName: '@dbagent/agent-host', target: 'internal/agent-host' },
  { path: 'apps/terminal', packageName: '@dbagent/terminal', target: 'terminal' },
]);

export const PUBLIC_RUNTIME_DEPENDENCIES = Object.freeze({
  '@modelcontextprotocol/sdk': '^1.29.0',
  '@vscode/ripgrep': '1.18.0',
  ajv: '8.20.0',
  'node-sql-parser': '^5.4.0',
  pg: '^8.13.1',
  'smol-toml': '1.8.0',
  yaml: '^2.8.1',
});

export const PUBLIC_PACKAGE_FIXED_FILES = Object.freeze([
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
]);

export function publicPackageFiles() {
  return [...PUBLIC_DOCUMENT_FILES, ...PUBLIC_PACKAGE_FIXED_FILES];
}

export const FORBIDDEN_PACKAGE_PATTERNS = Object.freeze([
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.schemanaut(?:\/|$)/i,
  /(^|\/)tmp(?:\/|$)/i,
  /(^|\/)test(?:s)?(?:\/|$)/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /(^|\/)apps\/server(?:\/|$)/i,
  /(^|\/)packages\/sdk(?:\/|$)/i,
  /\.d\.ts(?:\.map)?$/i,
  /\.js\.map$/i,
  /\.sqlite(?:3)?$/i,
  /(^|\/)state\.db$/i,
]);

export const ALLOWED_PACKAGE_PATTERNS = Object.freeze([
  /^(?:package\.json|README\.md|README\.zh-CN\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md)$/,
  /^docs\/.+\.md$/,
  /^dist\/.+\.(?:js|json|md)$/,
]);

const SECRET_PATTERNS = Object.freeze([
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
  { rule: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'openai-api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
]);

export function createPublicPackageManifest(nodeEngine) {
  if (typeof nodeEngine !== 'string' || !nodeEngine.trim()) {
    throw new TypeError('A Node.js engine range is required.');
  }
  return {
    name: NPM_PACKAGE_NAME,
    version: NPM_PACKAGE_VERSION,
    description:
      'Terminal-first general Agent with durable sessions, tools, Skills, MCP, and modular capabilities.',
    type: 'module',
    bin: { schemanaut: './dist/terminal/cli.js' },
    exports: {},
    files: [
      'dist',
      'docs',
      ...publicPackageFiles().filter((path) => !path.includes('/')),
    ],
    engines: { node: nodeEngine.trim() },
    dependencies: { ...PUBLIC_RUNTIME_DEPENDENCIES },
    keywords: [
      'ai',
      'agent',
      'cli',
      'terminal',
      'capability',
      'mcp',
      'skills',
      'postgresql',
    ],
    author: 'NWLworkshop contributors',
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/SylvanasW1ndrunner/Nexus.git',
    },
    homepage: 'https://github.com/SylvanasW1ndrunner/Nexus#readme',
    bugs: { url: 'https://github.com/SylvanasW1ndrunner/Nexus/issues' },
    publishConfig: { access: 'public', tag: 'next' },
  };
}

export function verifyPublicPackageManifest(manifest) {
  if (manifest?.name !== NPM_PACKAGE_NAME || manifest?.version !== NPM_PACKAGE_VERSION) {
    throw new Error(`Package identity must be ${NPM_PACKAGE_NAME}@${NPM_PACKAGE_VERSION}.`);
  }
  if (manifest?.bin?.schemanaut !== './dist/terminal/cli.js') {
    throw new Error('The package must expose only the dist/terminal CLI entry.');
  }
  for (const field of ['main', 'module', 'types', 'typings']) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(`CLI-only package must not declare ${field}.`);
    }
  }
  if (
    !manifest.exports ||
    typeof manifest.exports !== 'object' ||
    Array.isArray(manifest.exports) ||
    Object.keys(manifest.exports).length !== 0
  ) {
    throw new Error('CLI-only package must use an empty exports map to block package subpath imports.');
  }
  if (manifest?.publishConfig?.access !== 'public' || manifest?.publishConfig?.tag !== 'next') {
    throw new Error('Future remote publishing must stay explicit: public access and next tag.');
  }
  return manifest;
}

export function rewriteInternalImports(content, destinationPath, distDirectory) {
  let rewritten = content.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  for (const workspace of RUNTIME_WORKSPACES) {
    const targetPath = resolve(distDirectory, ...workspace.target.split('/'), 'index.js');
    let replacement = relative(dirname(destinationPath), targetPath).replaceAll('\\', '/');
    if (!replacement.startsWith('.')) replacement = `./${replacement}`;
    rewritten = rewritten
      .replaceAll(`'${workspace.packageName}'`, `'${replacement}'`)
      .replaceAll(`"${workspace.packageName}"`, `"${replacement}"`);
  }
  return `${rewritten.trimEnd()}\n`;
}

export function unresolvedInternalSpecifiers(content) {
  return [...new Set(content.match(/@dbagent\/[A-Za-z0-9._-]+/g) ?? [])].sort();
}

export function externalPackageSpecifiers(content) {
  const packages = new Set();
  const pattern = /(?:\bfrom\s*|\bimport\s*\(|\bimport\s+|\bexport\s+[^'"\n]*\bfrom\s*)['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) {
    const specifier = match[1];
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('node:') ||
      NODE_BUILTINS.has(specifier.split('/')[0])
    ) continue;
    const parts = specifier.split('/');
    packages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return [...packages].sort();
}

export function collectFiles(directory, root = directory) {
  function collectAbsolutePaths(currentDirectory) {
    const files = [];
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const path = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) files.push(...collectAbsolutePaths(path));
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported filesystem entry: ${path}`);
    }
    return files;
  }

  return collectAbsolutePaths(directory).sort().map((path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    absolutePath: path,
  }));
}

export function createFileSnapshot(files) {
  const entries = files
    .map(({ path, absolutePath }) => {
      const content = readFileSync(absolutePath);
      return {
        path: path.replaceAll('\\', '/'),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const aggregate = createHash('sha256');
  for (const entry of entries) {
    aggregate.update(`${entry.path}\0${entry.sha256}\0${entry.size}\n`);
  }
  return { algorithm: 'sha256', digest: aggregate.digest('hex'), files: entries };
}

export function verifyPackagePaths(paths) {
  const normalized = paths.map((path) => path.replaceAll('\\', '/'));
  const outsideAllowlist = normalized.filter(
    (path) => !ALLOWED_PACKAGE_PATTERNS.some((pattern) => pattern.test(path)),
  );
  if (outsideAllowlist.length > 0) {
    throw new Error(`Files outside the npm package allowlist:\n${outsideAllowlist.join('\n')}`);
  }
  const forbidden = normalized.filter((path) =>
    FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files in npm package:\n${forbidden.join('\n')}`);
  }
  const required = [
    'package.json',
    ...publicPackageFiles(),
    'dist/terminal/cli.js',
    'dist/internal/agent-host/index.js',
    'dist/internal/core-agent/index.js',
    'dist/internal/first-party-capabilities/index.js',
    'dist/internal/core-skills/skills/system/delegate-and-synthesize/SKILL.md',
    'dist/internal/database-capability/skills/query-and-answer/SKILL.md',
  ];
  const missing = required.filter((path) => !normalized.includes(path));
  if (missing.length > 0) throw new Error(`Required npm package files are missing:\n${missing.join('\n')}`);
}

export function findSecretMatches(content) {
  const matches = [];
  for (const { rule, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const value = match[0];
      if (/example|placeholder|replace|dummy|not-a-real/i.test(value)) continue;
      matches.push({ rule, index: match.index ?? 0 });
    }
  }
  return matches;
}

export function assertSafeTextFiles(files) {
  const findings = [];
  for (const file of files) {
    const matches = findSecretMatches(readFileSync(file.absolutePath, 'utf8'));
    for (const match of matches) findings.push(`${file.path}: ${match.rule}`);
  }
  if (findings.length > 0) throw new Error(`Potential secrets in npm package:\n${findings.join('\n')}`);
}

export function assertChildPath(parent, child) {
  const fromParent = relative(resolve(parent), resolve(child));
  if (!fromParent || fromParent.startsWith('..') || isAbsolute(fromParent)) {
    throw new Error(`Path escapes its required parent: ${child}`);
  }
}

export function requireFile(path, label = path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`);
  return path;
}
