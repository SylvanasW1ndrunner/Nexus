import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@dbagent/shared';
import { validatePluginManifests } from './plugin-manifest-validation.js';

const basePlugin: PluginManifest = {
  id: 'dbagent.sample',
  name: 'Sample',
  publisher: 'DBAgent',
  version: '0.1.0',
  description: 'Sample plugin',
  official: true,
  builtin: true,
  installed: true,
  enabled: true,
  categories: ['productivity'],
  activationEvents: ['onLanguage:sql'],
  contributes: {
    commands: [{ id: 'dbagent.sample.run', title: 'Run Sample', category: 'Sample' }],
    views: [{ id: 'dbagent.sample.view', title: 'Sample View', location: 'bottom-panel' }],
    configuration: [{ key: 'sample.enabled', type: 'boolean', title: 'Enabled', defaultValue: true }],
  },
};

describe('validatePluginManifests', () => {
  it('accepts a well-formed plugin manifest', () => {
    expect(() => validatePluginManifests([basePlugin])).not.toThrow();
  });

  it('rejects duplicate plugin and command identifiers', () => {
    expect(() => validatePluginManifests([basePlugin, { ...basePlugin }])).toThrow(/duplicate plugin id/i);
    expect(() =>
      validatePluginManifests([
        {
          ...basePlugin,
          contributes: {
            commands: [
              { id: 'dbagent.sample.run', title: 'Run Sample', category: 'Sample' },
              { id: 'dbagent.sample.run', title: 'Run Again', category: 'Sample' },
            ],
          },
        },
      ]),
    ).toThrow(/duplicate command id/i);
  });

  it('rejects invalid lifecycle and contribution boundaries', () => {
    expect(() => validatePluginManifests([{ ...basePlugin, installed: false, enabled: true }])).toThrow(/cannot be enabled/i);
    expect(() => validatePluginManifests([{ ...basePlugin, activationEvents: ['afterInstall'] }])).toThrow(/activation event/i);
    expect(() =>
      validatePluginManifests([{ ...basePlugin, contributes: { commands: [{ id: 'sample.run', title: 'Run', category: 'Sample' }] } }]),
    ).toThrow(/namespaced/i);
  });
});
