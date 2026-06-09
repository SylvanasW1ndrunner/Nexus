import { describe, expect, it } from 'vitest';
import { toWorkspaceRelativeDirectory } from './workspace-path.js';

describe('toWorkspaceRelativeDirectory', () => {
  it('returns a workspace relative directory for Windows paths', () => {
    expect(toWorkspaceRelativeDirectory('C:\\Projects\\Analytics\\.venv', 'C:\\Projects\\Analytics')).toBe('.venv');
    expect(toWorkspaceRelativeDirectory('c:\\projects\\analytics\\envs\\Py39', 'C:\\Projects\\Analytics')).toBe('envs/Py39');
  });

  it('returns a workspace relative directory for POSIX paths without changing case', () => {
    expect(toWorkspaceRelativeDirectory('/home/user/Analytics/.venv', '/home/user/Analytics')).toBe('.venv');
    expect(toWorkspaceRelativeDirectory('/home/user/Analytics/Env/Py39', '/home/user/Analytics')).toBe('Env/Py39');
  });

  it('rejects empty roots, project root itself, and directories outside the workspace', () => {
    expect(toWorkspaceRelativeDirectory('/home/user/Analytics/.venv')).toBeUndefined();
    expect(toWorkspaceRelativeDirectory('/home/user/Analytics', '/home/user/Analytics')).toBeUndefined();
    expect(toWorkspaceRelativeDirectory('/home/user/Other/.venv', '/home/user/Analytics')).toBeUndefined();
  });
});
