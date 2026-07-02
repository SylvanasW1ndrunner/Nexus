import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { AgentEvalSuite } from './agent-eval-suite-runner.js';
import {
  parseAgentEvalSuiteManifest,
  type AgentEvalSuiteManifest,
} from './agent-eval-suite-manifest.js';
import { resolveWorkspacePath } from './workspace-sandbox.js';

export type WorkspaceAgentEvalSuiteSource = {
  relativePath: string;
  manifest: AgentEvalSuiteManifest;
  suite: AgentEvalSuite;
};

export type WorkspaceAgentEvalSuiteLoadOptions = {
  workspaceRoot: string;
  evalsDir?: string;
  maxBytesPerManifest?: number;
};

const DEFAULT_EVALS_DIR = '.dbagent/evals';
const DEFAULT_MAX_BYTES_PER_MANIFEST = 256 * 1024;

export async function loadWorkspaceAgentEvalSuiteManifests(
  options: WorkspaceAgentEvalSuiteLoadOptions,
): Promise<WorkspaceAgentEvalSuiteSource[]> {
  const evalsDir = options.evalsDir ?? DEFAULT_EVALS_DIR;
  const maxBytes = options.maxBytesPerManifest ?? DEFAULT_MAX_BYTES_PER_MANIFEST;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Workspace eval manifest maxBytesPerManifest must be a positive integer.');
  }

  const evalsPath = resolveWorkspacePath(options.workspaceRoot, evalsDir);
  const dirStat = await statOrUndefined(evalsPath);
  if (dirStat === undefined) return [];
  if (!dirStat.isDirectory()) {
    throw new Error(`Workspace eval manifest directory is not a directory: ${evalsDir}`);
  }

  const entries = await readdir(evalsPath, { withFileTypes: true });
  const manifests: WorkspaceAgentEvalSuiteSource[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const absolutePath = join(evalsPath, entry.name);
    const relativePath = toWorkspaceRelativePath(options.workspaceRoot, absolutePath);
    const fileStat = await stat(absolutePath);
    if (fileStat.size > maxBytes) {
      throw new Error(`Workspace eval manifest exceeds ${maxBytes} bytes: ${relativePath}`);
    }

    const json = await readFile(absolutePath, 'utf8');
    const manifest = parseManifestWithSource(json, relativePath);
    manifests.push({
      relativePath,
      manifest,
      suite: parseAgentEvalSuiteManifest(manifest),
    });
  }

  assertUniqueSuiteIds(manifests);
  return manifests;
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function parseManifestWithSource(json: string, relativePath: string): AgentEvalSuiteManifest {
  try {
    const parsed = JSON.parse(json) as unknown;
    parseAgentEvalSuiteManifest(parsed);
    return parsed as AgentEvalSuiteManifest;
  } catch (error) {
    throw new Error(`Failed to load workspace eval manifest ${relativePath}: ${errorMessage(error)}`);
  }
}

function assertUniqueSuiteIds(manifests: WorkspaceAgentEvalSuiteSource[]): void {
  const seen = new Map<string, string>();
  for (const item of manifests) {
    const existingPath = seen.get(item.suite.suiteId);
    if (existingPath !== undefined) {
      throw new Error(
        `Duplicate workspace eval suite id ${item.suite.suiteId}: ${existingPath} and ${item.relativePath}`,
      );
    }
    seen.set(item.suite.suiteId, item.relativePath);
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  return relative(resolveWorkspacePath(workspaceRoot, '.'), absolutePath).split(sep).join('/');
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
