import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from '../src/index.js';

describe('resolveWorkspacePath', () => {
  it('resolves normal relative paths inside the workspace', () => {
    expect(resolveWorkspacePath('C:/workspace/project', 'queries/report.sql')).toBe(
      resolve('C:/workspace/project', 'queries/report.sql'),
    );
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWorkspacePath('C:/workspace/project', 'C:/Users/user/.ssh/id_rsa')).toThrow(
      'Workspace tools only accept relative paths.',
    );
  });

  it('rejects parent traversal outside the workspace', () => {
    expect(() => resolveWorkspacePath('C:/workspace/project', '../secret.txt')).toThrow(
      'Workspace path escapes the active workspace.',
    );
  });
});
