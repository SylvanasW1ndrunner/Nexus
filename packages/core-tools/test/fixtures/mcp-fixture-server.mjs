import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] ?? 'normal';
let catalogVersion = 1;

const server = new Server(
  { name: 'schemanaut-mcp-fixture', version: '1.0.0' },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    },
    instructions: 'Deterministic SchemaNaut MCP integration fixture.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  if (mode === 'stuck-list') {
    await new Promise(() => {});
  }
  if (mode === 'repeat-cursor') {
    return {
      tools: [],
      nextCursor: 'repeat',
    };
  }

  if (catalogVersion === 2) {
    return {
      tools: [
        {
          name: 'new_tool',
          title: 'New Tool',
          description: 'Tool added after a list-changed notification.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
          _meta: { fixtureVersion: 2 },
        },
      ],
    };
  }

  if (params?.cursor === 'tools:2') {
    if (mode === 'exit-after-list') {
      setTimeout(() => process.exit(9), 20);
    }
    return {
      tools: [
        {
          name: 'crash',
          description: 'Crashes the fixture process.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { destructiveHint: true },
        },
      ],
    };
  }

  return {
    tools: [
      {
        name: 'echo',
        title: 'Rich Echo',
        description: 'Echo a value with rich MCP content.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            echo: { type: 'string' },
            publicMode: { type: 'string' },
            hasToken: { type: 'boolean' },
          },
          required: ['echo', 'publicMode', 'hasToken'],
        },
        annotations: {
          title: 'Rich Echo',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { fixtureVersion: 1 },
      },
      {
        name: 'replace_catalog',
        description: 'Replace tools, resources and prompts, then emit list-changed notifications.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      {
        name: 'logical_error',
        description: 'Return a protocol-level tool error result.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'slow',
        description: 'Wait until completion or cancellation.',
        inputSchema: {
          type: 'object',
          properties: { delayMs: { type: 'integer', minimum: 1 } },
          required: ['delayMs'],
        },
        annotations: { readOnlyHint: true },
      },
    ],
    nextCursor: 'tools:2',
  };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'echo': {
      const value = String(args.value ?? '');
      return {
        content: [
          { type: 'text', text: value },
          {
            type: 'resource_link',
            uri: 'fixture://resources/alpha',
            name: 'Alpha resource',
            description: 'A linked MCP resource.',
            mimeType: 'text/plain',
          },
        ],
        structuredContent: {
          echo: value,
          publicMode: process.env.PUBLIC_MODE ?? '',
          hasToken: process.env.API_TOKEN === 'token-from-keychain',
        },
        _meta: { fixtureTrace: 'echo-1' },
      };
    }
    case 'replace_catalog':
      catalogVersion = 2;
      await Promise.all([
        server.sendToolListChanged(),
        server.sendResourceListChanged(),
        server.sendPromptListChanged(),
      ]);
      return {
        content: [{ type: 'text', text: 'Catalog replaced.' }],
        structuredContent: { version: 2 },
      };
    case 'logical_error':
      return {
        content: [{ type: 'text', text: 'Fixture rejected the requested operation.' }],
        isError: true,
        _meta: { code: 'FIXTURE_REJECTED' },
      };
    case 'slow': {
      const delayMs = Number(args.delayMs);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        extra.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('Fixture tool was cancelled.'));
          },
          { once: true },
        );
      });
      return { content: [{ type: 'text', text: 'Slow tool completed.' }] };
    }
    case 'crash':
      process.stderr.write('fixture-crash:'.padEnd(1024, 'x'));
      setTimeout(() => process.exit(7), 5);
      await new Promise(() => {});
      break;
    case 'new_tool':
      return {
        content: [{ type: 'text', text: 'New tool called.' }],
        structuredContent: { version: 2 },
      };
    default:
      throw new Error(`Unknown fixture tool: ${params.name}`);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, ({ params }) => {
  if (catalogVersion === 2) {
    return {
      resources: [
        {
          uri: 'fixture://resources/version-2',
          name: 'Version 2',
          description: 'Resource added after catalog replacement.',
          mimeType: 'application/json',
          _meta: { fixtureVersion: 2 },
        },
      ],
    };
  }
  if (params?.cursor === 'resources:2') {
    return {
      resources: [
        {
          uri: 'fixture://resources/beta',
          name: 'Beta',
          mimeType: 'application/octet-stream',
        },
      ],
    };
  }
  return {
    resources: [
      {
        uri: 'fixture://resources/alpha',
        name: 'Alpha',
        title: 'Alpha resource',
        description: 'First fixture resource.',
        mimeType: 'text/plain',
        annotations: { audience: ['assistant'], priority: 0.8 },
        _meta: { fixtureVersion: 1 },
      },
    ],
    nextCursor: 'resources:2',
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, ({ params }) => {
  if (params?.cursor === 'templates:2') {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'fixture://events/{eventId}',
          name: 'Event',
          mimeType: 'application/json',
        },
      ],
    };
  }
  return {
    resourceTemplates: [
      {
        uriTemplate: 'fixture://customers/{customerId}',
        name: 'Customer',
        description: 'Customer by identifier.',
        mimeType: 'application/json',
      },
    ],
    nextCursor: 'templates:2',
  };
});

server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => {
  if (params.uri === 'fixture://resources/beta') {
    return {
      contents: [
        {
          uri: params.uri,
          blob: Buffer.from([0, 1, 2, 3]).toString('base64'),
          mimeType: 'application/octet-stream',
          _meta: { encoding: 'base64' },
        },
      ],
    };
  }
  return {
    contents: [
      {
        uri: params.uri,
        text: JSON.stringify({ uri: params.uri, catalogVersion }),
        mimeType: 'application/json',
        _meta: { fixtureVersion: catalogVersion },
      },
    ],
  };
});

server.setRequestHandler(ListPromptsRequestSchema, ({ params }) => {
  if (catalogVersion === 2) {
    return {
      prompts: [
        {
          name: 'version-2-prompt',
          title: 'Version 2 prompt',
          description: 'Prompt added after catalog replacement.',
        },
      ],
    };
  }
  if (params?.cursor === 'prompts:2') {
    return {
      prompts: [
        {
          name: 'inspect-anomaly',
          description: 'Inspect an anomalous event.',
          arguments: [{ name: 'eventId', required: true }],
        },
      ],
    };
  }
  return {
    prompts: [
      {
        name: 'explain-customer',
        title: 'Explain customer',
        description: 'Explain a customer record.',
        arguments: [{ name: 'customerId', description: 'Customer identifier.', required: true }],
        _meta: { fixtureVersion: 1 },
      },
    ],
    nextCursor: 'prompts:2',
  };
});

server.setRequestHandler(GetPromptRequestSchema, ({ params }) => ({
  description: `Fixture prompt ${params.name}`,
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Prompt ${params.name} with ${JSON.stringify(params.arguments ?? {})}`,
      },
    },
  ],
  _meta: { fixtureVersion: catalogVersion },
}));

if (mode === 'crash-after-init') {
  server.oninitialized = () => {
    process.stderr.write('fixture-startup-crash:'.padEnd(1024, 'x'));
    setTimeout(() => process.exit(7), 5);
  };
}

await server.connect(new StdioServerTransport());
