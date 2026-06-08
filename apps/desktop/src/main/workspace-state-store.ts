import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceState } from '@dbagent/shared';

export class WorkspaceStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<WorkspaceState | undefined> {
    try {
      const state = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<WorkspaceState>;
      return normalizeWorkspaceState(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(state: WorkspaceState): Promise<WorkspaceState> {
    const saved = { ...state, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.filePath, saved);
    return saved;
  }
}

function normalizeWorkspaceState(state: Partial<WorkspaceState>): WorkspaceState | undefined {
  if (typeof state.sqlDraft !== 'string' || typeof state.updatedAt !== 'string') return undefined;
  const restored: WorkspaceState = {
    sqlDraft: state.sqlDraft,
    updatedAt: state.updatedAt,
  };
  if (typeof state.activeConnectionId === 'string') restored.activeConnectionId = state.activeConnectionId;
  return restored;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}
