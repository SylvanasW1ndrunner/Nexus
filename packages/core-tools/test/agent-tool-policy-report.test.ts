import { describe, expect, it } from 'vitest';
import { buildAgentToolPolicyReport, resolveRuntimeToolPolicy } from '../src/index.js';

describe('Agent tool policy report', () => {
  it('summarizes approval and source boundaries', () => {
    const report = buildAgentToolPolicyReport(
      resolveRuntimeToolPolicy({
        runtimeTools: [
          { name: 'list_tables', dangerLevel: 'safe', readonly: true, source: 'database' },
          { name: 'execute_sql', dangerLevel: 'high', readonly: false, source: 'database' },
        ],
      }),
      { generatedAt: '2026-07-22T00:00:00.000Z' },
    );

    expect(report.summary).toMatchObject({
      allowedToolCount: 2,
      blockedToolCount: 0,
      readonlyAllowedToolCount: 1,
      writeCapableAllowedToolCount: 1,
      approvalRequiredToolNames: ['execute_sql'],
      sources: ['database'],
    });
  });
});
