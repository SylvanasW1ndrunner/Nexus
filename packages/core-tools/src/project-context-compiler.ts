import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

const MAX_SCANNED_FILES = 20_000;
const MAX_SCAN_DEPTH = 8;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);
const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const SCHEMANAUT_RUNTIME_DIRECTORIES = new Set(['runtime', 'cache', 'state']);

export type ProjectInstruction = {
  path: string;
  appliesTo: string;
  content: string;
};

export type CompiledProjectModelContext = {
  rootName: string;
  instructions: ProjectInstruction[];
  technologies: {
    languages: string[];
    packageManagers: string[];
    manifests: string[];
  };
};

export type ProjectContextCompilation = {
  /** Internal cache/invalidation identity. Never include this in model prompts. */
  fingerprint: string;
  modelContext: CompiledProjectModelContext;
  compiledInstructions: string;
  scannedFileCount: number;
  truncated: boolean;
};

export async function compileProjectContext(input: {
  rootPath: string;
  maxFiles?: number;
  maxDepth?: number;
}): Promise<ProjectContextCompilation> {
  const rootPath = await canonicalDirectory(input.rootPath);
  const maxFiles = clampPositive(input.maxFiles, MAX_SCANNED_FILES, MAX_SCANNED_FILES);
  const maxDepth = clampPositive(input.maxDepth, MAX_SCAN_DEPTH, 32);
  const files: string[] = [];
  const truncated = await collectProjectFiles(rootPath, rootPath, maxDepth, maxFiles, files);
  files.sort(compareText);

  const instructions = await loadInstructions(rootPath, files);
  const technologies = detectTechnologies(rootPath, files);
  const modelContext: CompiledProjectModelContext = {
    rootName: basename(rootPath),
    instructions,
    technologies,
  };
  return {
    fingerprint: createHash('sha256')
      .update(stableJson({ version: 1, modelContext, truncated }))
      .digest('hex'),
    modelContext,
    compiledInstructions: renderProjectContext(modelContext),
    scannedFileCount: files.length,
    truncated,
  };
}

async function collectProjectFiles(
  rootPath: string,
  directory: string,
  depth: number,
  maxFiles: number,
  files: string[],
): Promise<boolean> {
  if (depth < 0 || files.length >= maxFiles) return true;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) return true;
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (
        directory === resolve(rootPath, '.schemanaut') &&
        SCHEMANAUT_RUNTIME_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      if (entry.name === '.schemanaut' && directory !== rootPath) continue;
      if (await collectProjectFiles(rootPath, absolute, depth - 1, maxFiles, files)) return true;
      continue;
    }
    if (entry.isFile()) files.push(absolute);
  }
  return false;
}

async function loadInstructions(rootPath: string, files: readonly string[]) {
  const candidates = files.filter((path) => {
    const relativePath = displayPath(rootPath, path);
    return relativePath === '.schemanaut/AGENT.md' || INSTRUCTION_NAMES.has(basename(relativePath));
  });
  const instructions: ProjectInstruction[] = [];
  for (const path of candidates) {
    const info = await stat(path);
    if (info.size > MAX_INSTRUCTION_BYTES) continue;
    const relativePath = displayPath(rootPath, path);
    const appliesTo =
      relativePath === '.schemanaut/AGENT.md' || dirname(relativePath) === '.'
        ? '.'
        : dirname(relativePath).replaceAll('\\', '/');
    const content = (await readFile(path, 'utf8')).trim();
    if (content) instructions.push({ path: relativePath, appliesTo, content });
  }
  return instructions.sort((left, right) => compareText(left.path, right.path));
}

function detectTechnologies(rootPath: string, files: readonly string[]) {
  const relativeFiles = files.map((path) => displayPath(rootPath, path));
  const fileNames = new Set(relativeFiles.map((path) => basename(path).toLowerCase()));
  const languages = new Set<string>();
  for (const path of relativeFiles) {
    const lower = path.toLowerCase();
    if (/\.(?:ts|tsx|mts|cts)$/.test(lower)) languages.add('typescript');
    else if (/\.(?:js|jsx|mjs|cjs)$/.test(lower)) languages.add('javascript');
    else if (/\.py$/.test(lower)) languages.add('python');
    else if (/\.java$/.test(lower)) languages.add('java');
    else if (/\.go$/.test(lower)) languages.add('go');
    else if (/\.rs$/.test(lower)) languages.add('rust');
    else if (/\.sql$/.test(lower)) languages.add('sql');
    else if (/\.(?:sh|bash|zsh|ps1)$/.test(lower)) languages.add('shell');
  }
  const packageManagers = new Set<string>();
  if (fileNames.has('pnpm-lock.yaml')) packageManagers.add('pnpm');
  if (fileNames.has('package-lock.json')) packageManagers.add('npm');
  if (fileNames.has('yarn.lock')) packageManagers.add('yarn');
  if (fileNames.has('bun.lock') || fileNames.has('bun.lockb')) packageManagers.add('bun');
  if (
    fileNames.has('pyproject.toml') ||
    fileNames.has('requirements.txt') ||
    fileNames.has('poetry.lock')
  ) {
    packageManagers.add('python');
  }
  if (fileNames.has('cargo.toml')) packageManagers.add('cargo');
  if (fileNames.has('go.mod')) packageManagers.add('go');
  if (fileNames.has('pom.xml')) packageManagers.add('maven');
  if (fileNames.has('build.gradle') || fileNames.has('build.gradle.kts')) {
    packageManagers.add('gradle');
  }
  const manifestNames = new Set([
    'package.json',
    'pnpm-workspace.yaml',
    'pyproject.toml',
    'requirements.txt',
    'cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'docker-compose.yml',
    'docker-compose.yaml',
  ]);
  return {
    languages: [...languages].sort(compareText),
    packageManagers: [...packageManagers].sort(compareText),
    manifests: relativeFiles.filter((path) => manifestNames.has(basename(path).toLowerCase())),
  };
}

function renderProjectContext(context: CompiledProjectModelContext): string {
  const sections = [
    '<project_context>',
    `  <root name="${xmlAttribute(context.rootName)}" />`,
    `  <technologies languages="${xmlAttribute(context.technologies.languages.join(', '))}" package_managers="${xmlAttribute(context.technologies.packageManagers.join(', '))}" />`,
  ];
  for (const instruction of context.instructions) {
    sections.push(
      `  <project_instruction path="${xmlAttribute(instruction.appliesTo)}" source="${xmlAttribute(instruction.path)}">`,
      instruction.content,
      '  </project_instruction>',
    );
  }
  sections.push('</project_context>');
  return sections.join('\n');
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  if (!(await stat(absolute)).isDirectory())
    throw new Error(`Project root is not a directory: ${absolute}.`);
  return await realpath(absolute);
}

function displayPath(rootPath: string, path: string): string {
  return relative(rootPath, path).replaceAll('\\', '/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
