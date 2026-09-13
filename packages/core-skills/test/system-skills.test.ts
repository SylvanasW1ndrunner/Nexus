import { describe, expect, it } from 'vitest';
import { createSystemSkillRegistry, loadSystemSkills, systemSkillSource } from '../src/index.js';

describe('SchemaNaut system Agent Skills', () => {
  it('exposes only generic, metadata-first system workflows', async () => {
    const skills = await loadSystemSkills();
    expect(skills.map(({ name, description, scope }) => ({
      name, description, scope,
    }))).toEqual([
      {
        name: 'delegate-and-synthesize',
        description: 'Delegate independent bounded work when delegation is available, then synthesize evidence.',
        scope: 'system',
      },
      {
        name: 'diagnose-with-evidence',
        description: 'Diagnose a problem from observable evidence and verify the proposed resolution.',
        scope: 'system',
      },
      {
        name: 'investigate-implement-verify',
        description: 'Investigate a project task, make a focused implementation, and verify the result.',
        scope: 'system',
      },
    ]);
    for (const skill of skills) {
      expect(skill.instructions).not.toMatch(/\b(database|sql)\b|internal hash|planId/iu);
    }
  });

  it('contains no proprietary execution-plan fields', async () => {
    const skills = await loadSystemSkills();
    for (const skill of skills) {
      expect(skill).not.toHaveProperty('steps');
      expect(skill).not.toHaveProperty('stopConditions');
      expect(skill).not.toHaveProperty('executionLimits');
      expect(skill).not.toHaveProperty('naturalLanguageKeywords');
      expect(skill).not.toHaveProperty('autoInjectWhen');
    }
  });

  it('provides a metadata-only system catalog', async () => {
    const registry = await createSystemSkillRegistry();
    expect(registry.catalogForModel()).toEqual([
      expect.objectContaining({ name: 'delegate-and-synthesize', scope: 'system' }),
      expect.objectContaining({ name: 'diagnose-with-evidence', scope: 'system' }),
      expect.objectContaining({ name: 'investigate-implement-verify', scope: 'system' }),
    ]);
    expect(systemSkillSource()).toMatchObject({
      scope: 'system',
      id: 'schemanaut-system',
    });
  });
});
