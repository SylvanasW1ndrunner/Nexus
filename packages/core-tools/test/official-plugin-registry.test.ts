import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST,
  DEFAULT_OFFICIAL_PLUGIN_MANIFESTS,
  OfficialPluginRegistry,
  createDefaultOfficialPluginRegistry,
  parseAgentEvalSuiteManifest,
  type OfficialPluginManifest,
} from '../src/index.js';

describe('OfficialPluginRegistry', () => {
  it('lists built-in official plugins and resolves default static tools', () => {
    const registry = createDefaultOfficialPluginRegistry();

    expect(registry.list().map((plugin) => plugin.id)).toEqual([
      'official.agent-checkpoint-recovery',
      'official.agent-plan-recovery',
      'official.agent-rag-eval',
      'official.agent-session-history',
      'official.database-postgres',
      'official.mcp-client',
      'official.schema-rag',
      'official.shell-command',
      'official.workspace-files',
      'official.workspace-python',
    ]);
    expect(registry.resolveToolContributions().toolNames).toEqual([
      'list_recoverable_agent_checkpoints',
      'list_agent_checkpoints',
      'read_agent_checkpoint',
      'list_recoverable_agent_plans',
      'list_agent_plan_executions',
      'read_agent_plan_execution',
      'list_agent_sessions',
      'read_agent_session',
      'export_agent_session',
      'list_agent_streams',
      'list_recoverable_agent_streams',
      'read_agent_stream',
      'list_schemas',
      'list_tables',
      'describe_table',
      'audit_sql',
      'query_database',
      'execute_sql',
      'get_schema_rag_status',
      'get_schema_rag_startup_recovery',
      'search_schema',
      'get_relations',
      'build_schema_context',
      'run_shell_command',
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
      evalSuites: [
        {
          version: 1,
          suite: {
            suiteId: 'official.agent-rag.business-readonly',
            suiteName: '官方 Agent/RAG 业务只读验收',
          },
        },
      ],
    });
    expect(parseAgentEvalSuiteManifest(DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST)).toMatchObject({
      suiteId: 'official.agent-rag.business-readonly',
      cases: [
        {
          case: {
            id: 'OFFICIAL-AGENT-RAG-001',
            requiredToolCalls: ['search_schema', 'query_database'],
          },
          run: {
            allowedTools: ['search_schema', 'query_database'],
            mode: 'readonly',
          },
        },
      ],
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
    ).toEqual([
      'list_schemas',
      'list_tables',
      'describe_table',
      'get_schema_rag_status',
      'get_schema_rag_startup_recovery',
      'search_schema',
      'get_relations',
      'build_schema_context',
    ]);

    expect(registry.resolveToolContributions({ maxDangerLevel: 'medium' }).toolNames).not.toContain(
      'execute_sql',
    );
  });

  it('resolves allowed runtime tools from static official tools and dynamic tool sources', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const runtimeTools = [
      runtimeTool('query_database', 'medium', true, 'database'),
      runtimeTool('execute_sql', 'high', false),
      runtimeTool('read_workspace_file', 'safe', true, 'workspace'),
      runtimeTool(
        'orders_server__list_orders',
        'safe',
        true,
        'user-mcp',
        'orders_server',
        'list_orders',
      ),
      runtimeTool(
        'analytics_server__drop_table',
        'high',
        false,
        'market-mcp',
        'analytics_server',
        'drop_table',
      ),
      runtimeTool(
        'workspace_script:summarize_orders',
        'medium',
        false,
        'workspace-script',
        'scripts/summarize_orders.py',
      ),
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
    expect(resolved.staticToolNames).toEqual([
      'query_database',
      'execute_sql',
      'read_workspace_file',
    ]);
    expect(resolved.dynamicToolNames).toEqual([
      'orders_server__list_orders',
      'analytics_server__drop_table',
      'workspace_script:summarize_orders',
    ]);
    expect(resolved.missingStaticToolNames).toContain('list_schemas');
    expect(resolved.missingStaticToolNames).not.toContain('query_database');
  });

  it('blocks runtime tools that spoof official static tool names from dynamic sources', () => {
    const registry = createDefaultOfficialPluginRegistry();

    const resolved = registry.resolveRuntimeTools({
      runtimeTools: [
        runtimeTool('query_database', 'safe', true, 'user-mcp', 'orders_server', 'query_database'),
      ],
    });

    expect(resolved.allowedToolNames).toEqual([]);
    expect(resolved.blockedToolNames).toEqual(['query_database']);
    expect(resolved.blockedToolDetails).toMatchObject([
      {
        toolName: 'query_database',
        reason: 'static-tool-source-mismatch',
        pluginId: 'official.database-postgres',
        contributionName: 'query_database',
        runtime: { source: 'user-mcp', sourceId: 'orders_server', originalName: 'query_database' },
      },
    ]);
    expect(resolved.staticToolNames).toEqual([]);
    expect(resolved.missingStaticToolNames).toContain('query_database');
    expect(resolved.missingStaticToolDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'query_database',
          pluginId: 'official.database-postgres',
          requiredPermissions: ['database.query.read'],
        }),
      ]),
    );
  });

  it('applies plugin, readonly, and danger filters to runtime tool allow lists', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const runtimeTools = [
      runtimeTool('query_database', 'medium', true),
      runtimeTool('execute_sql', 'high', false),
      runtimeTool(
        'orders_server__list_orders',
        'safe',
        true,
        'user-mcp',
        'orders_server',
        'list_orders',
      ),
      runtimeTool(
        'workspace_script:summarize_orders',
        'medium',
        false,
        'workspace-script',
        'scripts/summarize_orders.py',
      ),
    ];

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        disabledPluginIds: ['official.mcp-client'],
      }).allowedToolNames,
    ).toEqual(['query_database', 'execute_sql', 'workspace_script:summarize_orders']);

    expect(
      registry.resolveRuntimeTools({ runtimeTools, readonlyOnly: true }).allowedToolNames,
    ).toEqual(['query_database']);

    expect(
      registry.resolveRuntimeTools({ runtimeTools, maxDangerLevel: 'medium' }).allowedToolNames,
    ).toEqual(['query_database', 'workspace_script:summarize_orders']);
  });

  it('explains runtime tool blocks from plugin, readonly, danger, permission, and unknown-policy filters', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const runtimeTools = [
      runtimeTool('query_database', 'medium', true, 'database'),
      runtimeTool('execute_sql', 'high', false, 'database'),
      runtimeTool(
        'orders_server__list_orders',
        'safe',
        true,
        'user-mcp',
        'orders_server',
        'list_orders',
      ),
      runtimeTool('custom_unlisted_tool', 'safe', true, 'skill'),
    ];

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        disabledPluginIds: ['official.database-postgres', 'official.mcp-client'],
      }).blockedToolDetails,
    ).toMatchObject([
      { toolName: 'query_database', reason: 'plugin-disabled', pluginId: 'official.database-postgres' },
      { toolName: 'execute_sql', reason: 'plugin-disabled', pluginId: 'official.database-postgres' },
      { toolName: 'orders_server__list_orders', reason: 'plugin-disabled', pluginId: 'official.mcp-client' },
      { toolName: 'custom_unlisted_tool', reason: 'no-plugin-contribution' },
    ]);

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        readonlyOnly: true,
      }).blockedToolDetails.map((detail) => ({ toolName: detail.toolName, reason: detail.reason })),
    ).toEqual([
      { toolName: 'execute_sql', reason: 'readonly-required' },
      { toolName: 'orders_server__list_orders', reason: 'readonly-required' },
      { toolName: 'custom_unlisted_tool', reason: 'no-plugin-contribution' },
    ]);

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        maxDangerLevel: 'medium',
      }).blockedToolDetails.map((detail) => ({ toolName: detail.toolName, reason: detail.reason })),
    ).toEqual([
      { toolName: 'execute_sql', reason: 'danger-level-exceeds-limit' },
      { toolName: 'orders_server__list_orders', reason: 'danger-level-exceeds-limit' },
      { toolName: 'custom_unlisted_tool', reason: 'no-plugin-contribution' },
    ]);

    expect(
      registry.resolveRuntimeTools({
        runtimeTools,
        allowedPermissions: ['database.schema.read'],
      }).blockedToolDetails,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'query_database',
          reason: 'permission-not-allowed',
          requiredPermissions: ['database.query.read'],
          allowedPermissions: ['database.schema.read'],
        }),
      ]),
    );
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
    const registry = new OfficialPluginRegistry([
      minimalManifest('official.base'),
      disabledByDefault,
    ]);

    expect(registry.resolveToolContributions().toolNames).toEqual(['test_tool']);
    expect(
      registry.resolveToolContributions({
        enabledPluginIds: ['official.experimental-skill'],
      }).toolNames,
    ).toEqual(['test_tool', 'experimental_tool']);
  });

  it('resolves eval suites only from enabled official eval plugins', () => {
    const registry = createDefaultOfficialPluginRegistry();

    expect(registry.resolveEvalSuites()).toEqual({ suites: [], manifests: [] });

    const resolved = registry.resolveEvalSuites({
      enabledPluginIds: ['official.agent-rag-eval'],
    });

    expect(resolved.suites).toMatchObject([
      {
        suiteId: 'official.agent-rag.business-readonly',
        suiteName: '官方 Agent/RAG 业务只读验收',
        environment: 'integration',
        cases: [
          {
            case: {
              id: 'OFFICIAL-AGENT-RAG-001',
              requiredToolCalls: ['search_schema', 'query_database'],
            },
            run: {
              allowedTools: ['search_schema', 'query_database'],
              mode: 'readonly',
              maxIterations: 5,
            },
          },
        ],
      },
    ]);
    expect(resolved.manifests).toMatchObject([
      {
        pluginId: 'official.agent-rag-eval',
        manifest: {
          version: 1,
          suite: { suiteId: 'official.agent-rag.business-readonly' },
        },
      },
    ]);

    expect(
      registry.resolveEvalSuites({
        enabledPluginIds: ['official.agent-rag-eval'],
        suiteIds: ['missing-suite'],
      }),
    ).toEqual({ suites: [], manifests: [] });
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

    expect(
      () =>
        new OfficialPluginRegistry([
          minimalManifest('official.first'),
          minimalManifest('official.second'),
        ]),
    ).toThrow(
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
        runtimeTools: [
          runtimeTool('query_database', 'medium', true),
          runtimeTool('query_database', 'medium', true),
        ],
      }),
    ).toThrow('Duplicate runtime tool descriptor: query_database');

    expect(
      () =>
        new OfficialPluginRegistry([
          {
            ...minimalManifest('official.bad-eval-suite-owner'),
            evalSuites: [DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST],
          },
        ]),
    ).toThrow('Only eval official plugins can declare eval suites');

    expect(
      () =>
        new OfficialPluginRegistry([
          {
            ...minimalManifest('official.bad-eval-suite'),
            category: 'eval',
            tools: [],
            evalSuites: [
              {
                version: 1,
                suite: {
                  suiteId: 'bad-suite',
                  suiteName: 'Bad Suite',
                  cases: [],
                },
              },
            ],
          },
        ]),
    ).toThrow('Agent eval suite manifest suite must contain at least one case.');

    expect(() =>
      new OfficialPluginRegistry([
        {
          ...minimalManifest('official.eval-a'),
          category: 'eval',
          tools: [],
          evalSuites: [DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST],
        },
        {
          ...minimalManifest('official.eval-b'),
          category: 'eval',
          tools: [],
          evalSuites: [DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST],
        },
      ]).resolveEvalSuites({
        enabledPluginIds: ['official.eval-a', 'official.eval-b'],
      }),
    ).toThrow('Duplicate resolved official eval suite: official.agent-rag.business-readonly');
  });

  it('returns cloned manifests so callers cannot mutate the registry', () => {
    const registry = createDefaultOfficialPluginRegistry();
    const manifest = registry.get('official.database-postgres');
    expect(manifest).toBeDefined();
    manifest!.tools[0]!.name = 'mutated';
    const evalManifest = registry.get('official.agent-rag-eval');
    evalManifest!.evalSuites![0]!.suite.suiteId = 'mutated-suite';
    const resolved = registry.resolveEvalSuites({
      enabledPluginIds: ['official.agent-rag-eval'],
    });
    resolved.manifests[0]!.manifest.suite.suiteId = 'mutated-resolved-suite';

    expect(registry.get('official.database-postgres')?.tools[0]?.name).toBe('list_schemas');
    expect(registry.get('official.agent-rag-eval')?.evalSuites?.[0]?.suite.suiteId).toBe(
      'official.agent-rag.business-readonly',
    );
    expect(
      registry.resolveEvalSuites({ enabledPluginIds: ['official.agent-rag-eval'] }).manifests[0]
        ?.manifest.suite.suiteId,
    ).toBe('official.agent-rag.business-readonly');
    expect(
      DEFAULT_OFFICIAL_PLUGIN_MANIFESTS.find((item) => item.id === 'official.database-postgres')
        ?.tools[0]?.name,
    ).toBe('list_schemas');
    expect(DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST.suite.suiteId).toBe(
      'official.agent-rag.business-readonly',
    );
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
