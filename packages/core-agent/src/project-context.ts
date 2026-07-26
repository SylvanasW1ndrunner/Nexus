import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { AgentProjectContext, AgentProjectReference } from './types.js';

const CONFIG_DIRECTORY = '.schemanaut';

export async function findAgentProject(
  startPath: string = process.cwd(),
): Promise<AgentProjectContext | undefined> {
  let current = await canonicalDirectory(startPath);
  const root = parse(current).root;
  while (true) {
    const context = await readProjectAt(current);
    if (context) return context;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

export async function openAgentProject(
  startPath: string = process.cwd(),
): Promise<AgentProjectContext> {
  const existing = await findAgentProject(startPath);
  if (existing) return existing;
  const rootPath = await canonicalDirectory(startPath);
  return projectContext(rootPath);
}

export async function initializeAgentProject(
  directory: string = process.cwd(),
): Promise<AgentProjectContext> {
  const rootPath = await canonicalDirectory(directory);
  const context = projectContext(rootPath);
  await mkdir(context.configDirectory, { recursive: true });
  await mkdir(context.skillsDirectory, { recursive: true });
  await mkdir(context.sqlDirectory, { recursive: true });
  await mkdir(context.artifactsDirectory, { recursive: true });
  await writeIfMissing(
    context.instructionsPath,
    [
      '# SchemaNaut Project Guidance',
      '',
      'Add concise project conventions and recurring database guidance here.',
      'Keep database facts in the knowledge catalog and credentials outside this file.',
      '',
    ].join('\n'),
  );
  await writeIfMissing(context.settingsPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  await writeIfMissing(
    context.mcpConfigPath,
    `${JSON.stringify({ version: 1, servers: [] }, null, 2)}\n`,
  );
  return await loadAgentProject(context);
}

export function defaultAgentStateDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    platform() === 'win32'
      ? env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
      : env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(base, 'SchemaNaut', 'schemanaut.db');
}

export function defaultAgentUserSkillsDirectory(): string {
  return join(homedir(), '.schemanaut', 'skills');
}

export function createAgentProjectContext(rootPath: string = process.cwd()): AgentProjectContext {
  const absolute = isAbsolute(rootPath) ? rootPath : resolve(rootPath);
  return projectContext(absolute);
}

export function agentProjectReference(context: AgentProjectContext): AgentProjectReference {
  return {
    rootPath: context.rootPath,
    configDirectory: context.configDirectory,
  };
}

export function assertSameAgentProject(
  reference: AgentProjectReference | undefined,
  context: AgentProjectReference,
): void {
  if (!reference) {
    throw new Error('Session has no Project ownership and cannot be opened by a Project Runtime.');
  }
  if (!agentProjectPathsEqual(reference.rootPath, context.rootPath)) {
    throw new Error(`Session belongs to a different project: ${reference.rootPath}.`);
  }
}

export function agentProjectStorageIdentity(
  reference: AgentProjectReference,
  operatingSystem: NodeJS.Platform = platform(),
): { projectKey: string; projectRoot: string } {
  const projectRoot = normalizeAgentProjectRoot(reference.rootPath, operatingSystem);
  return {
    projectKey: `project:${createHash('sha256').update(projectRoot).digest('hex')}`,
    projectRoot,
  };
}

export function normalizeAgentProjectRoot(
  rootPath: string,
  operatingSystem: NodeJS.Platform = platform(),
): string {
  const normalized = resolve(rootPath);
  return operatingSystem === 'win32' ? normalized.toLowerCase() : normalized;
}

export function agentProjectPathsEqual(
  left: string,
  right: string,
  operatingSystem: NodeJS.Platform = platform(),
): boolean {
  return (
    normalizeAgentProjectRoot(left, operatingSystem) ===
    normalizeAgentProjectRoot(right, operatingSystem)
  );
}

async function readProjectAt(rootPath: string): Promise<AgentProjectContext | undefined> {
  const context = projectContext(rootPath);
  try {
    if (!(await stat(context.configDirectory)).isDirectory()) return undefined;
    return await loadAgentProject(context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadAgentProject(context: AgentProjectContext): Promise<AgentProjectContext> {
  let instructions: string | undefined;
  try {
    instructions = (await readFile(context.instructionsPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    ...context,
    ...(instructions ? { instructions } : {}),
  };
}

function projectContext(rootPath: string): AgentProjectContext {
  const configDirectory = join(rootPath, CONFIG_DIRECTORY);
  return {
    rootPath,
    configDirectory,
    instructionsPath: join(configDirectory, 'AGENT.md'),
    settingsPath: join(configDirectory, 'settings.json'),
    localSettingsPath: join(configDirectory, 'settings.local.json'),
    mcpConfigPath: join(configDirectory, 'mcp.json'),
    skillsDirectory: join(configDirectory, 'skills'),
    sqlDirectory: join(rootPath, 'sql'),
    artifactsDirectory: join(rootPath, 'artifacts'),
  };
}

async function canonicalDirectory(input: string): Promise<string> {
  const absolute = isAbsolute(input) ? input : resolve(input);
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${absolute}.`);
  return await realpath(absolute);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
