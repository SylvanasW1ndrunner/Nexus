import { describe, expect, it } from 'vitest';
import { createSystemSkillRegistry, loadSystemSkills, systemSkillSource } from '../src/index.js';

describe('SchemaNaut system Agent Skills', () => {
  it('loads four UTF-8 Markdown Skills from packaged assets', async () => {
    const skills = await loadSystemSkills();
    expect(skills.map(({ name }) => name)).toEqual([
      'discover-schema-and-shape',
      'query-and-answer',
      'recover-from-sql-error',
      'write-and-verify',
    ]);
    for (const skill of skills) {
      expect(skill.scope).toBe('system');
      expect(skill.instructions.length).toBeGreaterThan(100);
      expect(`${skill.description}\n${skill.instructions}`).not.toMatch(
        /�|鏌ヨ|绯荤粺|鍐欏叆|鎵ц/,
      );
      expect(skill.extensions).toEqual({});
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
    expect(registry.catalogForModel()).toHaveLength(4);
    expect(Object.keys(registry.catalogForModel()[0]!).sort()).toEqual([
      'description',
      'name',
      'scope',
    ]);
    expect(systemSkillSource()).toMatchObject({
      scope: 'system',
      id: 'schemanaut-system',
    });
  });
});
