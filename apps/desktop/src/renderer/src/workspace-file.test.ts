import { describe, expect, it } from 'vitest';
import {
  createWorkspaceFileTemplate,
  inferWorkspaceFileLanguage,
  normalizeNewWorkspaceFilePath,
} from './workspace-file.js';

describe('workspace file helpers', () => {
  it('normalizes user-entered file paths for project files', () => {
    expect(normalizeNewWorkspaceFilePath(' scripts\\clean_orders.py ')).toBe('scripts/clean_orders.py');
    expect(normalizeNewWorkspaceFilePath('/sql/analytics/revenue.sql')).toBe('sql/analytics/revenue.sql');
  });

  it('rejects unsafe or non-file paths before calling workspace write APIs', () => {
    expect(() => normalizeNewWorkspaceFilePath('')).toThrow();
    expect(() => normalizeNewWorkspaceFilePath('../escape.py')).toThrow();
    expect(() => normalizeNewWorkspaceFilePath('sql/')).toThrow();
    expect(() => normalizeNewWorkspaceFilePath('.dbagent/workspace.json')).toThrow();
    expect(() => normalizeNewWorkspaceFilePath('node_modules/pkg/index.js')).toThrow();
    expect(() => normalizeNewWorkspaceFilePath('C:\\temp\\x.py')).toThrow();
  });

  it('infers editor language from supported project file types', () => {
    expect(inferWorkspaceFileLanguage('sql/analytics/orders.SQL')).toBe('sql');
    expect(inferWorkspaceFileLanguage('scripts/clean_orders.py')).toBe('python');
    expect(inferWorkspaceFileLanguage('docs/runbook.md')).toBe('markdown');
    expect(inferWorkspaceFileLanguage('outputs/result.txt')).toBe('plaintext');
  });

  it('creates useful starter content without hiding the file type', () => {
    expect(createWorkspaceFileTemplate('sql/analytics/orders.sql')).toBe('-- New SQL file\n');
    expect(createWorkspaceFileTemplate('scripts/clean_orders.py')).toBe('# New Python script\n');
    expect(createWorkspaceFileTemplate('docs/runbook.md')).toBe('# Notes\n');
    expect(createWorkspaceFileTemplate('outputs/raw.txt')).toBe('');
  });
});
