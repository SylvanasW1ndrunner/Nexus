import { isAbsolute, relative, resolve } from 'node:path';

const managedRoots = new Set(['queries', 'sql', 'scripts', 'skills', 'docs', 'outputs', 'notebooks']);

export function toPortablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function normalizeWorkspaceRelativePath(path: string): string {
  const normalized = toPortablePath(path.trim()).replace(/^\/+/, '');
  if (!normalized) throw new Error('Workspace path is required.');
  if (isAbsolute(path) || normalized.includes('\0')) throw new Error('Invalid workspace path.');
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error('Workspace path escapes are not allowed.');
  const root = normalized.split('/')[0];
  if (!root || !managedRoots.has(root)) {
    throw new Error('Workspace path must be inside a managed project directory.');
  }
  return normalized;
}

export function resolveInsideWorkspace(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return target;
  throw new Error('Workspace path escapes are not allowed.');
}

export function normalizeWorkspaceDirectory(path: string): string {
  return normalizeWorkspaceRelativePath(path).replace(/\/+$/g, '');
}
