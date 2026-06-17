import { resolve, relative, isAbsolute } from 'node:path';

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  if (!requestedPath.trim()) {
    throw new Error('Workspace path is required.');
  }
  if (isAbsolute(requestedPath)) {
    throw new Error('Workspace tools only accept relative paths.');
  }

  const root = resolve(workspaceRoot);
  const target = resolve(root, requestedPath);
  const relativePath = relative(root, target);

  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return target;
  }

  throw new Error('Workspace path escapes the active workspace.');
}
