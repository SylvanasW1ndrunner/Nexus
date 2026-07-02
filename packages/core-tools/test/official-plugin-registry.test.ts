import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFFICIAL_PLUGIN_MANIFESTS,
  OfficialPluginRegistry,
  createDefaultOfficialPluginRegistry,
  type OfficialPluginManifest,
} from '../src/index.js';

describe('OfficialPluginRegistry', () => {
  it('lists built-in official plugins and resolves default static tools', () => {
    const registry = createDefaultOfficialPluginRegistry();

    expect(registry.list().map((plugin) => plugin.id)).toEqual([
      'official.agent-rag-eval',
      'official.database-postgres',
      'official.mcp-client',
      'official.schema-rag',
      'official.workspace-files',
      'official.workspace-python',
    ]);
    expect(registry.resolveToolContributions().toolNames).toEqual([
      'list_schemas',
      'list_tables',
      'describe_table',
      'audit_sql',
      'query_database',
      'execute_sql',
      'search_schema',
      'get_relations',
      'build_schema_context',
      'list_workspace_dir',
      'read_workspace_file',
      'write_workspace_file',
    ]);
    expect(registry.resolveToolContributions().dynamicTools.map((tool) => tool.name)).toEqual([
      'mcp:*',
      'workspace_script:*',
    ]);
    expect(registry.get('official.agent-rag-eval')).toMatchObject({
      category: 'eval',
      enabledByDefault: false,
      capabilities: ['agent-eval-suite', 'tool-evidence-report', 'release-quality-gate'],
      tools: [],
    });
  });

  it('filters tools by disabled plugin, readonly mode, permission allow list, and danger level', () => {
    const registry = createDefaultOfficialPluginRegistry();

    expect(
      registry.resolveToolContributions({
        disabledPluginIds: ['official.database-postgres'],
      }).toolNames,
    ).not.toContain('query_database');

    const readonly = registry.resolveToolContributions({ readonlyOnly: true });
    expect(readonly.toolNames).toContain('query_database');
    expect(readonly.toolNames).not.toContain('execute_sql');
    expect(readonly.dynamicTools).toEqual([]);

    expect(
      registry.resolveToolContributions({
        allowedPermissions: ['database.schema.read', 'rag.schema.read'],
      }).toolNames,
    ).toEqual(['list_schemas', 'list_tables', 'describe_table', 'search_schema', 'get_relations', 'build_schema_context']);

    expect(registry.resolveToolContributions({ maxDangerLevel: 'medium' }).toolNames).not.toContain('execute_sql');
  });

  it('resolves allowed runtime tools from static official tools and dynamic tool sources', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const runtimeTools = [
      runtimeTool('query_database', 'medium', true),
      runtimeTool('execute_sql', 'high', false),
      runtimeTool('read_workspace_file', 'safe', true),
      runtimeTool('orders_server__list_orders', 'safe', true, 'user-mcp', 'orders_server', 'list_orders'),
      runtimeTool('analytics_server__drop_table', 'high', false, 'market-mcp', 'analytics_server', 'drop_table'),
      runtimeTool('workspace_script:summarize_orders', 'medium', false, 'workspace-script', 'scripts/summarize_orders.py'),
      runtimeTool('unregistered_custom_tool', 'safe', true, 'skill'),
    ];

    const resolved = registry.resolveRuntimeTools({ runtimeTools });

    expect(resolved.allowedToolNames).toEqual([
      'query_database',
      'execute_sql',
      'read_workspace_file',
      'orders_server__list_orders',
      'analytics_server__drop_table',
      'workspace_script:summarize_orders',
    ]);
    expect(resolved.blockedToolNames).toEqual(['unregistered_custom_tool']);
    expect(resolved.staticToolNames).toEqual(['query_database', 'execute_sql', 'read_workspace_file']);
    expect(resolved.dynamicToolNames).toEqual([
      'orders_server__list_orders',
      'analytics_server__drop_table',
      'workspace_script:summarize_orders',
    ]);
    expect(resolved.missingStaticToolNames).toContain('list_schemas');
    expect(resolved.missingStaticToolNames).not.toContain('query_database');
  });

  it('applies plugin, readonly, and danger filters to runtime tool allow lists', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const runtimeTools = [
      runtimeTool('query_database', 'medium', true),
      runtimeTool('execute_sql', 'high', false),
      runtimeTool('orders_server__list_orders', 'safe', true, 'user-mcp', 'orders_server', 'list_orders'),
      runtimeTool('workspace_script:summarize_orders', 'medium', false, 'workspace-script', 'scripts/summarize_orders.py'),
    ];

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        disabledPluginIds: ['official.mcp-client'],
      }).allowedToolNames,
    ).toEqual(['query_database', 'execute_sql', 'workspace_script:summarize_orders']);

    expect(registry.resolveRuntimeTools({ runtimeTools, readonlyOnly: true }).allowedToolNames).toEqual([
      'query_database',
    ]);

    expect(registry.resolveRuntimeTools({ runtimeTools, maxDangerLevel: 'medium' }).allowedToolNames).toEqual([
      'query_database',
      'workspace_script:summarize_orders',
    ]);
  });

  it('enables an official plugin that is disabled by default only when explicitly requested', () => {
    const disabledByDefault = {
      ...minimalManifest('official.experimental-skill'),
      enabledByDefault: false,
      tools: [
        {
          ...minimalManifest('x').tools[0]!,
          name: 'experimental_tool',
        },
      ],
    };
    const registry = new OfficialPluginRegistry([minimalManifest('official.base'), disabledByDefault]);

    expect(registry.resolveToolContributions().toolNames).toEqual(['test_tool']);
    expect(
      registry.resolveToolContributions({
        enabledPluginIds: ['official.experimental-skill'],
      }).toolNames,
    ).toEqual(['test_tool', 'experimental_tool']);
  });

  it('validates duplicate plugin ids, duplicate tool names, cross-plugin tool conflicts, and unknown permission references', () => {
    const first = minimalManifest('official.test');
    const registry = new OfficialPluginRegistry([first]);

    expect(() => registry.register(minimalManifest('official.test'))).toThrow(
      'Official plugin is already registered: official.test',
    );

    expect(
      () =>
        new OfficialPluginRegistry([
          {
            ...minimalManifest('official.duplicate-tools'),
            tools: [
              minimalManifest('x').tools[0]!,
              {
                ...minimalManifest('x').tools[0]!,
              },
            ],
          },
        ]),
    ).toThrow('Duplicate tool in official plugin official.duplicate-tools');

    expect(() => new OfficialPluginRegistry([minimalManifest('official.first'), minimalManifest('official.second')])).toThrow(
      'Official plugin tool test_tool is already contributed by official.first; cannot register official.second.',
    );

    expect(
      () =>
        new OfficialPluginRegistry([
          {
            ...minimalManifest('official.bad-permission'),
            tools: [
              {
                ...minimalManifest('x').tools[0]!,
                permissions: ['missing.permission'],
              },
            ],
          },
        ]),
    ).toThrow('Tool test_tool references unknown permission missing.permission.');

    expect(
      () =>
        new OfficialPluginRegistry([
          {
            ...minimalManifest('official.dynamic-without-pattern'),
            tools: [
              {
                ...minimalManifest('x').tools[0]!,
                name: 'dynamic:*',
                dynamic: true,
                namePattern: '',
              },
            ],
          },
        ]),
    ).toThrow('Dynamic tool dynamic:* must declare namePattern.');

    expect(() =>
      registry.resolveRuntimeTools({
        runtimeTools: [runtimeTool('query_database', 'medium', true), runtimeTool('query_database', 'medium', true)],
      }),
    ).toThrow('Duplicate runtime tool descriptor: query_database');
  });

  it('returns cloned manifests so callers cannot mutate the registry', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const manifest = registry.get('official.database-postgres');
    expect(manifest).toBeDefined();
    manifest!.tools[0]!.name = 'mutated';

    expect(registry.get('official.database-postgres')?.tools[0]?.name).toBe('list_schemas');
    expect(
      DEFAULT_OFFICIAL_PLUGIN_MANIFESTS.find((item) => item.id === 'official.database-postgres')?.tools[0]?.name,
    ).toBe('list_schemas');
  });
});

function minimalManifest(id: string): OfficialPluginManifest {
  return {
    id,
    name: 'Test plugin',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'skill',
    description: 'Test official plugin manifest.',
    enabledByDefault: true,
    capabilities: ['test'],
    permissions: [
      {
        id: 'test.permission',
        title: 'Test permission',
        description: 'Test permission.',
        risk: 'safe',
        readonly: true,
        resourceScopes: ['skill.source'],
        approvalPolicy: 'never',
        networkAccess: 'none',
        processAccess: 'none',
        secretKinds: ['none'],
        auditLevel: 'metadata',
      },
    ],
    tools: [
      {
        name: 'test_tool',
        title: 'Test tool',
        description: 'Test tool.',
        dangerLevel: 'safe',
        readonly: true,
        permissions: ['test.permission'],
      },
    ],
  };
}

function runtimeTool(
  name: string,
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical',
  readonly: boolean,
  source?: string,
  sourceId?: string,
  originalName?: string,
) {
  return {
    name,
    dangerLevel,
    readonly,
    ...(source === undefined ? {} : { source }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(originalName === undefined ? {} : { originalName }),
  };
}
