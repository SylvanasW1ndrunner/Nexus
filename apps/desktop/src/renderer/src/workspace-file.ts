export type WorkspaceEditorLanguage = 'sql' | 'python' | 'markdown' | 'plaintext';

export function normalizeNewWorkspaceFilePath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\/+/g, '').replace(/\/+/g, '/');
  if (!normalized) throw new Error('File path is required.');
  if (normalized.includes('\0') || /^[a-zA-Z]:\//.test(normalized)) throw new Error('Invalid file path.');
  if (normalized.endsWith('/')) throw new Error('File path must include a file name.');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid file path.');
  }
  const firstSegment = segments[0] ?? '';
  if (firstSegment.startsWith('.') || firstSegment === 'node_modules') {
    throw new Error('File must be inside a managed project directory.');
  }
  return normalized;
}

export function normalizeNewWorkspaceDirectoryPath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\/+/g, '').replace(/\/+/g, '/').replace(/\/+$/g, '');
  if (!normalized) throw new Error('Directory path is required.');
  if (normalized.includes('\0') || /^[a-zA-Z]:\//.test(normalized)) throw new Error('Invalid directory path.');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid directory path.');
  }
  const firstSegment = segments[0] ?? '';
  if (firstSegment.startsWith('.') || firstSegment === 'node_modules') {
    throw new Error('Directory must be inside a managed project directory.');
  }
  const fileName = segments[segments.length - 1] ?? '';
  if (fileName.includes('.')) throw new Error('Directory name should not look like a file.');
  return normalized;
}

export function inferWorkspaceFileLanguage(relativePath: string): WorkspaceEditorLanguage {
  const path = relativePath.toLowerCase();
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
  return 'plaintext';
}

export function createWorkspaceFileTemplate(relativePath: string): string {
  const language = inferWorkspaceFileLanguage(relativePath);
  if (language === 'sql') return '-- New SQL file\n';
  if (language === 'python') return '# New Python script\n';
  if (language === 'markdown') return '# Notes\n';
  return '';
}
