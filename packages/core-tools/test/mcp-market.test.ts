import { describe, expect, it } from 'vitest';
import {
  StaticMcpMarketProvider,
  buildMcpServerInputFromMarketTemplate,
  createDefaultStaticMcpMarketProvider,
  type StaticMcpMarketEntry,
} from '../src/index.js';

describe('MCP market provider contracts', () => {
  it('searches static market entries by query and category without exposing install internals', () => {
    const provider = createDefaultStaticMcpMarketProvider();

    expect(provider.search({ query: 'fetch' })).toMatchObject([
      {
        id: 'modelcontextprotocol-fetch',
        marketId: 'official-static',
        name: 'Fetch',
        categories: ['web', 'official'],
        packageName: '@modelcontextprotocol/server-fetch',
      },
    ]);
    expect(provider.search({ category: 'memory' }).map((entry) => entry.id)).toEqual([
      'modelcontextprotocol-memory',
    ]);
    expect(provider.search({ limit: 1 })).toHaveLength(1);
  });

  it('returns cloned install templates and builds safe market MCP server input', () => {
    const provider = createDefaultStaticMcpMarketProvider();
    const template = provider.getInstallTemplate('modelcontextprotocol-fetch');

    const install = buildMcpServerInputFromMarketTemplate(template, {
      serverId: 'fetch-prod',
      autoStart: true,
      enabled: true,
    });

    expect(install).toEqual({
      server: {
        id: 'fetch-prod',
        name: 'Fetch',
        source: 'market',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-fetch'],
        autoStart: true,
        enabled: true,
        packageName: '@modelcontextprotocol/server-fetch',
        marketEntryId: 'modelcontextprotocol-fetch',
        env: {},
      },
      secrets: {},
    });

    template.server.name = 'mutated';
    expect(provider.getInstallTemplate('modelcontextprotocol-fetch').server.name).toBe('Fetch');
  });

  it('requires secret env values to be supplied as secrets during install', () => {
    const provider = new StaticMcpMarketProvider({
      id: 'fixture',
      name: 'Fixture',
      entries: [secretEntry()],
    });
    const template = provider.getInstallTemplate('secure-tools');

    expect(() => buildMcpServerInputFromMarketTemplate(template)).toThrow(
      'MCP market entry requires env API_TOKEN.',
    );
    expect(() =>
      buildMcpServerInputFromMarketTemplate(template, { envPlain: { API_TOKEN: 'plain-token' } }),
    ).toThrow('MCP env API_TOKEN must be stored as a secret.');
    expect(
      buildMcpServerInputFromMarketTemplate(template, {
        envSecrets: { API_TOKEN: 'secret-token' },
      }),
    ).toMatchObject({
      server: {
        id: 'secure-tools',
        source: 'market',
        env: {},
      },
      secrets: { API_TOKEN: 'secret-token' },
    });
  });

  it('rejects duplicate static market entries', () => {
    expect(
      () =>
        new StaticMcpMarketProvider({
          id: 'fixture',
          name: 'Fixture',
          entries: [secretEntry(), secretEntry()],
        }),
    ).toThrow('Duplicate MCP market entry: secure-tools');
  });
});

function secretEntry(): StaticMcpMarketEntry {
  return {
    id: 'secure-tools',
    marketId: 'fixture',
    name: 'Secure Tools',
    description: 'Fixture secure MCP tools.',
    publisher: 'DBAgent Test',
    categories: ['security'],
    transport: 'stdio',
    packageName: '@example/secure-tools',
    requiredEnv: [
      {
        name: 'API_TOKEN',
        title: 'API token',
        required: true,
        secret: true,
      },
    ],
    install: {
      server: {
        id: 'secure-tools',
        name: 'Secure Tools',
        source: 'market',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/secure-tools'],
        autoStart: false,
        enabled: true,
        packageName: '@example/secure-tools',
      },
    },
  };
}
