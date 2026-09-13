import { describe, expect, it } from 'vitest';
import {
  LlmProviderPluginRegistry,
  createLlmConnection,
  type LlmProviderPlugin,
} from '../src/index.js';

describe('LlmProviderPluginRegistry', () => {
  it('orders matching plugins by score, priority and registration order', () => {
    const registry = new LlmProviderPluginRegistry();
    registry.register(plugin('fallback', 5, 1));
    registry.register(plugin('first-equal', 80, 10));
    registry.register(plugin('second-equal', 80, 10));
    registry.register(plugin('higher-priority', 80, 20));

    const matches = registry.match(
      createLlmConnection({ endpoint: 'https://relay.example/v1', apiKey: 'secret' }),
    );

    expect(matches.map((match) => match.plugin.manifest.id)).toEqual([
      'higher-priority',
      'first-equal',
      'second-equal',
      'fallback',
    ]);
  });

  it('rejects duplicate plugin ids and invalid manifests', () => {
    const registry = new LlmProviderPluginRegistry([plugin('same', 10, 1)]);

    expect(() => registry.register(plugin('same', 20, 2))).toThrow(/already registered/i);
    expect(() => registry.register(plugin('', 20, 2))).toThrow(/id/i);
    expect(() =>
      registry.register({ ...plugin('bad-version', 20, 2), manifest: {
        ...plugin('bad-version', 20, 2).manifest,
        version: '',
      } }),
    ).toThrow(/version/i);
  });

  it('isolates a plugin match exception instead of hiding healthy candidates', () => {
    const broken = plugin('broken', 100, 100);
    broken.match = () => {
      throw new Error('plugin exploded with secret-do-not-leak');
    };
    const registry = new LlmProviderPluginRegistry([broken, plugin('healthy', 20, 1)]);

    const matches = registry.match(
      createLlmConnection({
        endpoint: 'https://relay.example/v1',
        apiKey: 'secret-do-not-leak',
      }),
    );

    expect(matches.map((match) => match.plugin.manifest.id)).toEqual(['healthy']);
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({ pluginId: 'broken', phase: 'match' }),
    ]);
    expect(JSON.stringify(registry.diagnostics())).toContain('secret-do-not-leak');
  });
});

function plugin(id: string, score: number, priority: number): LlmProviderPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      protocol: `${id}-protocol`,
      priority,
    },
    match: () => ({
      score,
      evidence: [{ source: 'plugin', kind: 'test-match', summary: `${id} matched` }],
    }),
    createProvider: () => {
      throw new Error('not needed by this test');
    },
  };
}
