import { describe, expect, it } from 'vitest';
import { skillCatalogPromptSection } from '../src/agent-runtime.js';

describe('system Skill catalog prompt identity', () => {
  it('binds its revision to the full stable catalog semantics, not names alone', () => {
    const original = skillCatalogPromptSection([
      { name: 'diagnose', scope: 'system', description: 'Diagnose with evidence.' },
      { name: 'implement', scope: 'system', description: 'Implement and verify.' },
    ]);
    const sameCatalog = skillCatalogPromptSection([
      { name: 'implement', scope: 'system', description: 'Implement and verify.' },
      { name: 'diagnose', scope: 'system', description: 'Diagnose with evidence.' },
    ]);
    const changedDescription = skillCatalogPromptSection([
      { name: 'diagnose', scope: 'system', description: 'Diagnose from durable evidence.' },
      { name: 'implement', scope: 'system', description: 'Implement and verify.' },
    ]);

    expect(sameCatalog.revision).toBe(original.revision);
    expect(changedDescription.revision).not.toBe(original.revision);
    expect(changedDescription.content).not.toEqual(original.content);
  });
});
