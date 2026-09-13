import { describe, expect, it } from 'vitest';
import {
  agentProjectPathsEqual,
  agentProjectStorageIdentity,
  normalizeAgentProjectRoot,
} from '../src/project-context.js';

describe('Agent project platform normalization', () => {
  it('uses the supplied platform to make Windows project identity case-insensitive', () => {
    const upper = 'C:\\Workspace\\Nexus';
    const lower = 'c:\\workspace\\nexus';

    expect(normalizeAgentProjectRoot(upper, 'win32'))
      .toBe(normalizeAgentProjectRoot(lower, 'win32'));
    expect(agentProjectPathsEqual(upper, lower, 'win32')).toBe(true);
    expect(agentProjectStorageIdentity({ rootPath: upper, configDirectory: '.schemanaut' }, 'win32').projectKey)
      .toBe(agentProjectStorageIdentity({ rootPath: lower, configDirectory: '.schemanaut' }, 'win32').projectKey);
  });
});
