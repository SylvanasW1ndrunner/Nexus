import type { ToolRegistry } from '@dbagent/core-agent';
import { optionalPositiveInteger, requireString } from './validation.js';

export type AgentWebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type AgentWebAdapter = {
  search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<AgentWebSearchResult[]>;
  fetch(input: { url: string; maxChars: number; signal?: AbortSignal }): Promise<{
    url: string;
    title?: string;
    contentType?: string;
    text: string;
  }>;
};

export function registerWebTools(registry: ToolRegistry, adapter: AgentWebAdapter): void {
  registry.register(
    {
      name: 'web_search',
      description:
        'Search the web through the host-provided web adapter. Use for current or externally documented facts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args, context) => {
      const limit = Math.min(optionalPositiveInteger(args, 'limit', 8) ?? 8, 20);
      const results = await adapter.search({
        query: requireString(args, 'query'),
        limit,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return {
        results: results.slice(0, limit).map((result) => ({
          title: result.title,
          url: result.url,
          ...(result.snippet === undefined ? {} : { snippet: result.snippet.slice(0, 1_000) }),
        })),
      };
    },
  );

  registry.register(
    {
      name: 'web_fetch',
      description:
        'Fetch bounded readable text from a URL returned by web_search through the host adapter.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          maxChars: { type: 'integer', minimum: 1, maximum: 100000 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args, context) => {
      const maxChars = Math.min(
        optionalPositiveInteger(args, 'maxChars', 20_000) ?? 20_000,
        100_000,
      );
      const response = await adapter.fetch({
        url: requireHttpUrl(requireString(args, 'url')),
        maxChars,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return {
        url: response.url,
        ...(response.title === undefined ? {} : { title: response.title }),
        ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
        text: response.text.slice(0, maxChars),
        truncated: response.text.length > maxChars,
      };
    },
  );
}

function requireHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('web_fetch requires a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('web_fetch supports only HTTP and HTTPS URLs.');
  }
  return parsed.toString();
}
