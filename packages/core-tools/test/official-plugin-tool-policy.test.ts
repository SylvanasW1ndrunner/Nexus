import { describe, expect, it } from 'vitest';
import { ToolRegistry, type AgentToolDefinition } from '@dbagent/core-agent';
import {
  resolveOfficialPluginAgentTools,
  runtimeToolsFromToolRegistry,
  type OfficialPluginRuntimeToolDescriptor,
} from '../src/index.js';

describe('official plugin Agent tool policy', () => {
  it('builds Agent allowedTools from ToolRegistry, official plugin state, and Skill allowedTools', () => {
    const toolRegistry = new ToolRegistry();
    registerTool(toolRegistry, { name: 'query_database', dangerLevel: 'medium', readonly: true });
    registerTool(toolRegistry, { name: 'read_workspace_file', dangerLevel: 'safe', readonly: true });
    registerTool(toolRegistry, {
      name: 'workspace_script:summarize_orders',
      dangerLevel: 'medium',
      readonly: false,
      source: 'workspace-script',
      sourceId: 'scripts/summarize_orders.py',
      originalName: 'workspace_script:summarize_orders',
    });
    registerTool(toolRegistry, {
      name: 'orders_server__list_orders',
      dangerLevel: 'safe',
      readonly: true,
      source: 'user-mcp',
      sourceId: 'orders_server',
      originalName: 'list_orders',
    });
    registerTool(toolRegistry, { name: 'custom_unlisted_tool', dangerLevel: 'safe', readonly: true, source: 'skill' });

    const policy = resolveOfficialPluginAgentTools({
      toolRegistry,
      disabledPluginIds: ['official.mcp-client'],
      skillAllowedTools: [
        'workspace_script:summarize_orders',
        'query_database',
        'execute_sql',
        'orders_server__list_orders',
        'missing_tool',
      ],
    });

    expect(policy.agentAllowedToolNames).toEqual(['workspace_script:summarize_orders', 'query_database']);
    expect(policy.pluginAllowedToolNames).toEqual([
      'query_database',
      'read_workspace_file',
      'workspace_script:summarize_orders',
    ]);
    expect(policy.blockedByPluginToolNames).toEqual([
      'execute_sql',
      'orders_server__list_orders',
      'missing_tool',
    ]);
    expect(policy.blockedByPluginToolDetails).toMatchObject([
      {
        toolName: 'execute_sql',
        blockedBy: 'plugin',
        reason: 'runtime-tool-missing',
      },
      {
        toolName: 'orders_server__list_orders',
        blockedBy: 'plugin',
        reason: 'plugin-disabled',
        pluginId: 'official.mcp-client',
      },
      {
        toolName: 'missing_tool',
        blockedBy: 'plugin',
        reason: 'runtime-tool-missing',
      },
    ]);
    expect(policy.blockedBySkillToolNames).toEqual(['read_workspace_file']);
    expect(policy.blockedBySkillToolDetails).toEqual([
      {
        toolName: 'read_workspace_file',
        blockedBy: 'skill',
        reason: 'skill-tool-not-allowed',
        message:
          'Tool read_workspace_file is available from official plugins but is not declared by the selected Skill.',
      },
    ]);
    expect(policy.toolPermissions).toMatchObject([
      {
        toolName: 'workspace_script:summarize_orders',
        pluginId: 'official.workspace-python',
        contributionName: 'workspace_script:*',
        dynamic: true,
        dangerLevel: 'medium',
        readonly: false,
        runtime: {
          source: 'workspace-script',
          sourceId: 'scripts/summarize_orders.py',
          originalName: 'workspace_script:summarize_orders',
        },
        permissions: [
          {
            id: 'workspace.process.execute',
            risk: 'medium',
            approvalPolicy: 'mode-dependent',
            resourceScopes: ['workspace.process', 'workspace.root'],
            processAccess: 'managed-child-process',
          },
        ],
      },
      {
        toolName: 'query_database',
        pluginId: 'official.database-postgres',
        contributionName: 'query_database',
        dynamic: false,
        dangerLevel: 'medium',
        readonly: true,
        permissions: [
          {
            id: 'database.query.read',
            risk: 'medium',
            approvalPolicy: 'mode-dependent',
            resourceScopes: ['database.connection'],
          },
        ],
      },
    ]);
    expect(policy.runtimeResolution.blockedToolNames).toEqual(['orders_server__list_orders', 'custom_unlisted_tool']);
  });

  it('blocks dynamic runtime tools that spoof static official tool names', () => {
    const policy = resolveOfficialPluginAgentTools({
      runtimeTools: [
        runtimeTool('query_database', 'safe', true, 'user-mcp'),
      ],
      skillAllowedTools: ['query_database'],
    });

    expect(policy.agentAllowedToolNames).toEqual([]);
    expect(policy.blockedByPluginToolNames).toEqual(['query_database']);
    expect(policy.blockedByPluginToolDetails).toMatchObject([
      {
        toolName: 'query_database',
        blockedBy: 'plugin',
        reason: 'static-tool-source-mismatch',
        pluginId: 'official.database-postgres',
      },
    ]);
    expect(policy.runtimeResolution.blockedToolNames).toEqual(['query_database']);
    expect(policy.toolPermissions).toEqual([]);
  });

  it('preserves official plugin filtering when no Skill is selected', () => {
    const policy = resolveOfficialPluginAgentTools({
      runtimeTools: [
        runtimeTool('query_database', 'medium', true),
        runtimeTool('execute_sql', 'high', false),
        runtimeTool('workspace_script:etl_daily_orders', 'medium', false, 'workspace-script'),
      ],
      maxDangerLevel: 'medium',
    });

    expect(policy.agentAllowedToolNames).toEqual(['query_database', 'workspace_script:etl_daily_orders']);
    expect(policy.blockedByPluginToolNames).toEqual([]);
    expect(policy.blockedBySkillToolNames).toEqual([]);
  });

  it('converts ToolRegistry entries to runtime descriptors with source metadata', () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: 'orders_server__list_orders',
      dangerLevel: 'safe',
      readonly: true,
      source: 'user-mcp',
      sourceId: 'orders_server',
      originalName: 'list_orders',
    });

    expect(runtimeToolsFromToolRegistry(registry)).toEqual([
      {
        name: 'orders_server__list_orders',
        dangerLevel: 'safe',
        readonly: true,
        source: 'user-mcp',
        sourceId: 'orders_server',
        originalName: 'list_orders',
      },
    ]);
  });

  it('rejects ambiguous runtime sources and duplicated Skill tool declarations', () => {
    expect(() =>
      resolveOfficialPluginAgentTools({
        runtimeTools: [],
        toolRegistry: new ToolRegistry(),
      }),
    ).toThrow('Provide exactly one of runtimeTools or toolRegistry.');

    expect(() =>
      resolveOfficialPluginAgentTools({
        runtimeTools: [runtimeTool('query_database', 'medium', true)],
        skillAllowedTools: ['query_database', 'query_database'],
      }),
    ).toThrow('Duplicate skill allowed tool: query_database');
  });
});

function registerTool(
  registry: ToolRegistry,
  tool: Pick<AgentToolDefinition, 'name' | 'dangerLevel' | 'readonly'> & {
    source?: string;
    sourceId?: string;
    originalName?: string;
  },
): void {
  registry.register(
    {
      name: tool.name,
      description: `Test tool ${tool.name}`,
      inputSchema: { type: 'object', properties: {} },
      dangerLevel: tool.dangerLevel,
      ...(tool.readonly === undefined ? {} : { readonly: tool.readonly }),
      ...(tool.source === undefined ? {} : { source: tool.source }),
      ...(tool.sourceId === undefined ? {} : { sourceId: tool.sourceId }),
      ...(tool.originalName === undefined ? {} : { originalName: tool.originalName }),
    },
    () => ({ ok: true }),
  );
}

function runtimeTool(
  name: string,
  dangerLevel: OfficialPluginRuntimeToolDescriptor['dangerLevel'],
  readonly: boolean,
  source?: string,
): OfficialPluginRuntimeToolDescriptor {
  return {
    name,
    dangerLevel,
    readonly,
    ...(source === undefined ? {} : { source }),
  };
}
