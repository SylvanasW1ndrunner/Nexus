import { describe, expect, it } from 'vitest';
import {
  buildAgentToolPolicyReport,
  resolveOfficialPluginAgentTools,
  type OfficialPluginRuntimeToolDescriptor,
} from '../src/index.js';

describe('Agent tool policy report', () => {
  it('summarizes allowed tools, approval requirements, secrets, and blocked reasons', () => {
    const policy = resolveOfficialPluginAgentTools({
      runtimeTools: [
        runtimeTool('query_database', 'medium', true, 'database'),
        runtimeTool('execute_sql', 'high', false, 'database'),
        runtimeTool('read_workspace_file', 'safe', true, 'workspace'),
        runtimeTool('orders_server__list_orders', 'safe', true, 'user-mcp', 'orders_server', 'list_orders'),
        runtimeTool('custom_unlisted_tool', 'safe', true, 'skill'),
      ],
      disabledPluginIds: ['official.mcp-client'],
      skillAllowedTools: ['query_database', 'execute_sql', 'orders_server__list_orders', 'missing_tool'],
    });

    const report = buildAgentToolPolicyReport(policy, { mode: 'auto' });

    expect(report.allowedTools).toMatchObject([
      {
        toolName: 'query_database',
        pluginId: 'official.database-postgres',
        dangerLevel: 'medium',
        readonly: true,
        automaticDecision: 'ask',
        requiresApproval: true,
        permissionIds: ['database.query.read'],
        secretKinds: ['database-password'],
        auditLevels: ['metadata-and-arguments'],
      },
      {
        toolName: 'execute_sql',
        pluginId: 'official.database-postgres',
        dangerLevel: 'high',
        readonly: false,
        automaticDecision: 'ask',
        requiresApproval: true,
        permissionIds: ['database.query.write'],
      },
    ]);
    expect(report.blockedTools).toMatchObject([
      {
        toolName: 'orders_server__list_orders',
        blockedBy: 'plugin',
        reason: 'plugin-disabled',
        pluginId: 'official.mcp-client',
        source: 'user-mcp',
        sourceId: 'orders_server',
      },
      {
        toolName: 'missing_tool',
        blockedBy: 'plugin',
        reason: 'runtime-tool-missing',
      },
      {
        toolName: 'read_workspace_file',
        blockedBy: 'skill',
        reason: 'skill-tool-not-allowed',
      },
    ]);
    expect(report.summary).toMatchObject({
      allowedToolCount: 2,
      blockedToolCount: 3,
      blockedByPluginCount: 2,
      blockedBySkillCount: 1,
      writeCapableAllowedToolCount: 1,
      highRiskAllowedToolCount: 1,
      approvalRequiredToolNames: ['query_database', 'execute_sql'],
      deniedByModeToolNames: [],
      secretKinds: ['database-password'],
      metadataAndArgumentsAuditToolNames: ['query_database', 'execute_sql'],
    });
    expect(report.missingStaticTools.map((tool) => tool.toolName)).toContain('list_schemas');
  });

  it('shows readonly mode denials for write-capable tools before the Agent runs', () => {
    const policy = resolveOfficialPluginAgentTools({
      runtimeTools: [
        runtimeTool('query_database', 'medium', true, 'database'),
        runtimeTool('execute_sql', 'high', false, 'database'),
      ],
      skillAllowedTools: ['query_database', 'execute_sql'],
    });

    const report = buildAgentToolPolicyReport(policy, { mode: 'readonly' });

    expect(report.allowedTools.map((tool) => [tool.toolName, tool.automaticDecision])).toEqual([
      ['query_database', 'allow'],
      ['execute_sql', 'deny'],
    ]);
    expect(report.summary.deniedByModeToolNames).toEqual(['execute_sql']);
    expect(report.summary.approvalRequiredToolNames).toEqual(['execute_sql']);
  });
});

function runtimeTool(
  name: string,
  dangerLevel: OfficialPluginRuntimeToolDescriptor['dangerLevel'],
  readonly: boolean,
  source?: string,
  sourceId?: string,
  originalName?: string,
): OfficialPluginRuntimeToolDescriptor {
  return {
    name,
    dangerLevel,
    readonly,
    ...(source === undefined ? {} : { source }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(originalName === undefined ? {} : { originalName }),
  };
}
