import { describe, expect, it } from 'vitest';
import { LexicalToolSearchIndex, ToolRegistry } from '../src/index.js';
import { PREPARED_TOOL_INTENT_REVISION } from '../src/tools/tool-protocol.js';
import { preparedToolIntent } from './permission-audit-fixture.js';

describe('LexicalToolSearchIndex', () => {
  it('retrieves tools from mixed Chinese/English names, aliases, tags and parameter descriptions', () => {
    const registry = new ToolRegistry();
    register(registry, {
      namespace: 'database.kafka',
      name: 'inspect_json_shape',
      title: '检查 Kafka JSON 数据形态',
      description: 'Sample event payloads and infer JSON keys without scanning the complete table',
      aliases: ['解析消息结构', 'inspect payload schema'],
      tags: ['Kafka', 'JSON', '数据清洗'],
      properties: {
        eventType: { type: 'string', description: '筛选事件类型 event type' },
      },
    });
    register(registry, {
      namespace: 'workspace',
      name: 'file_patch',
      title: '修改文件',
      description: 'Apply a bounded patch to a project file',
      aliases: ['编辑代码'],
      tags: ['code'],
      properties: { path: { type: 'string', description: '项目文件路径' } },
    });

    const index = new LexicalToolSearchIndex(registry.listDescriptors());

    expect(index.search('解析 Kafka JSON 消息结构', { limit: 3 })[0]?.tool.flatName).toBe(
      'inspect_json_shape',
    );
    expect(index.search('eventType 参数筛选', { limit: 3 })[0]?.tool.flatName).toBe(
      'inspect_json_shape',
    );
    expect(index.search('编辑项目代码文件', { limit: 3 })[0]?.tool.flatName).toBe('file_patch');
  });

  it('keeps ranking deterministic and respects the allowed tool boundary', () => {
    const registry = new ToolRegistry();
    register(registry, {
      name: 'read_database_schema',
      title: 'Read schema',
      description: 'Read database tables and columns',
      aliases: [],
      tags: ['database'],
      properties: {},
    });
    register(registry, {
      name: 'read_database_metrics',
      title: 'Read metrics',
      description: 'Read database metrics and health',
      aliases: [],
      tags: ['database'],
      properties: {},
    });

    const index = new LexicalToolSearchIndex(registry.listDescriptors());
    const first = index.search('read database', {
      limit: 10,
      allowedTools: ['read_database_metrics'],
    });
    const second = index.search('read database', {
      limit: 10,
      allowedTools: ['read_database_metrics'],
    });

    expect(first.map((item) => item.tool.flatName)).toEqual(['read_database_metrics']);
    expect(second).toEqual(first);
  });

  it('normalizes common English inflections without a domain synonym table', () => {
    const registry = new ToolRegistry();
    register(registry, {
      namespace: 'database.schema',
      name: 'relation_search',
      title: 'Schema relation graph',
      description: 'Search table relationships and foreign keys',
      aliases: [],
      tags: ['table', 'relation'],
      properties: {},
    });
    register(registry, {
      namespace: 'database.security',
      name: 'user_grant',
      title: 'Database user grant',
      description: 'Manage database users and roles',
      aliases: [],
      tags: ['database', 'user'],
      properties: {},
    });

    const index = new LexicalToolSearchIndex(registry.listDescriptors());

    expect(index.search('find related database tables', { limit: 3 })[0]?.tool.flatName).toBe(
      'relation_search',
    );
  });

  it('indexes one thousand tools and answers locally within a bounded runtime', () => {
    const registry = new ToolRegistry();
    for (let index = 0; index < 1_000; index += 1) {
      register(registry, {
        namespace: index % 2 === 0 ? 'database' : 'workspace',
        name: `tool_${index}`,
        title: `能力 ${index}`,
        description: index === 777 ? '分析 Kafka 流量异常 latency spike' : `Generic tool ${index}`,
        aliases: index === 777 ? ['traffic anomaly detector'] : [],
        tags: index === 777 ? ['Kafka', '流量', '异常检测'] : ['generic'],
        properties: { input: { type: 'string', description: `parameter ${index}` } },
      });
    }

    const buildStarted = performance.now();
    const index = new LexicalToolSearchIndex(registry.listDescriptors());
    const buildMs = performance.now() - buildStarted;
    const searchStarted = performance.now();
    const matches = index.search('Kafka 流量异常 latency', { limit: 5 });
    const searchMs = performance.now() - searchStarted;

    expect(matches[0]?.tool.flatName).toBe('tool_777');
    expect(buildMs).toBeLessThan(500);
    expect(searchMs).toBeLessThan(100);
  });
});

function register(
  registry: ToolRegistry,
  input: {
    namespace?: string;
    name: string;
    title: string;
    description: string;
    aliases: string[];
    tags: string[];
    properties: Record<string, unknown>;
  },
) {
  registry.registerInvocation(
    {
      ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
      name: input.name,
      title: input.title,
      description: input.description,
      aliases: input.aliases,
      tags: input.tags,
      inputSchema: { type: 'object', properties: input.properties },
      outputSchema: { type: 'object' }, dangerLevel: 'safe', readonly: true,
      source: 'unknown', access: 'read', recoveryClass: 'read',
      toolRevision: `${input.name}@1`, handlerRevision: `${input.name}-handler@1`,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      execution: { concurrency: 'read', timeoutMs: 1_000 },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    {
      revision: { toolName: input.name, toolRevision: `${input.name}@1`, handlerRevision: `${input.name}-handler@1`, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare: () => preparedToolIntent({ toolName: input.name, toolRevision: `${input.name}@1`, handlerRevision: `${input.name}-handler@1` }).intent,
      execute: () => ({}),
    },
  );
}
