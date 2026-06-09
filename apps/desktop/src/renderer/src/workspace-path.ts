export function toWorkspaceRelativeDirectory(selectedPath: string, workspaceRoot?: string): string | undefined {
  if (!workspaceRoot?.trim()) return undefined;
  const root = normalizePortablePath(workspaceRoot);
  const selected = normalizePortablePath(selectedPath);
  const comparableRoot = root.toLowerCase();
  const comparableSelected = selected.toLowerCase();
  if (comparableSelected === comparableRoot) return undefined;
  if (!comparableSelected.startsWith(`${comparableRoot}/`)) return undefined;
  return selected.slice(root.length + 1);
}

function normalizePortablePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
}
