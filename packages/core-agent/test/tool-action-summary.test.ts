import { describe, expect, it } from 'vitest';
import type { AgentToolDescriptor } from '../src/types.js';
import {
  MAX_TOOL_ACTION_SUMMARY_CHARS,
  createToolActionSummary,
} from '../src/tools/tool-action-summary.js';

describe('Tool action summary', () => {
  it('uses only the Tool-owned preview field for SQL, commands, and file operations', () => {
    const sql = descriptor({
      flatName: 'sql_execute',
      presentation: {
        preparingMessage: '正在执行 SQL。',
        inputPreview: { argument: 'sql', label: 'SQL', language: 'sql' },
      },
    });
    const command = descriptor({
      flatName: 'process_exec',
      presentation: {
        preparingMessage: '正在执行项目命令。',
        inputPreview: { argument: 'command', label: 'Command', language: 'shell' },
      },
    });
    const file = descriptor({
      flatName: 'workspace_apply_patch',
      presentation: {
        preparingMessage: '正在写入项目文件。',
        inputPreview: { argument: 'path', label: 'Path' },
      },
    });

    expect(createToolActionSummary(sql, 'sql_execute', {
      sql: 'select count(*) from orders', password: 'must-not-appear',
    })).toBe('正在执行 SQL。\nSQL:\nselect count(*) from orders');
    expect(createToolActionSummary(command, 'process_exec', {
      command: 'npm test', env: { API_KEY: 'must-not-appear' },
    })).toBe('正在执行项目命令。\nCommand:\nnpm test');
    expect(createToolActionSummary(file, 'workspace_apply_patch', {
      path: 'src/report.ts', content: 'must-not-appear',
    })).toBe('正在写入项目文件。\nPath:\nsrc/report.ts');
  });

  it('uses a useful generic fallback without serializing arbitrary Tool arguments', () => {
    const mcp = descriptor({
      flatName: 'github__create_issue',
      title: 'Create issue',
      source: 'user-mcp',
      sourceId: 'github',
      presentation: { category: 'mcp', preparingMessage: '调用 MCP 工具 Create issue（github）。' },
    });

    expect(createToolActionSummary(mcp, mcp.flatName, {
      body: 'private arbitrary payload', labels: ['internal'],
    })).toBe('调用 MCP 工具 Create issue（github）。');
    expect(createToolActionSummary(undefined, 'missing_tool', {
      password: 'must-not-appear', nested: { value: 'must-not-appear' },
    })).toBe('Run tool: missing_tool.');
    expect(createToolActionSummary(descriptor({ flatName: 'generic_tool' }), 'ignored', {
      query: 'must-not-appear',
    })).toBe('Run tool: generic_tool.');
  });

  it('normalizes valid previews, truncates long Unicode safely, and names unusable previews', () => {
    const tool = descriptor({
      flatName: 'sql_execute',
      presentation: {
        preparingMessage: '  Execute SQL.  ',
        inputPreview: { argument: 'sql', label: ' SQL ' },
      },
    });
    expect(createToolActionSummary(tool, tool.flatName, {
      sql: 'select 1;\r\nselect 2;',
    })).toBe('Execute SQL.\nSQL:\nselect 1;\nselect 2;');
    const long = createToolActionSummary(tool, tool.flatName, {
      sql: `select '🙂';${'x'.repeat(MAX_TOOL_ACTION_SUMMARY_CHARS * 2)}`,
    });
    expect(long.startsWith("Execute SQL.\nSQL:\nselect '🙂';")).toBe(true);
    expect(long.endsWith('… [truncated]')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(MAX_TOOL_ACTION_SUMMARY_CHARS);
    expect(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(long))
      .toBe(false);
    expect(createToolActionSummary(tool, tool.flatName, { sql: '' }))
      .toBe('Run tool: sql_execute.');
    expect(createToolActionSummary(tool, tool.flatName, { sql: 1 }))
      .toBe('Run tool: sql_execute.');
  });
});

function descriptor(
  overrides: Partial<AgentToolDescriptor> & Pick<AgentToolDescriptor, 'flatName'>,
): AgentToolDescriptor {
  return {
    id: { name: overrides.flatName },
    description: 'fixture', aliases: [], tags: [], inputSchema: { type: 'object' },
    outputSchema: { type: 'object' }, dangerLevel: 'safe', readonly: true, source: 'builtin', exposure: 'direct',
    access: 'read', recoveryClass: 'read', toolRevision: `${overrides.flatName}@1`,
    handlerRevision: `${overrides.flatName}-handler@1`, intentRevision: 'prepared-tool-intent.v1',
    limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    execution: { concurrency: 'read', timeoutMs: 1_000 },
    ...overrides,
  };
}
