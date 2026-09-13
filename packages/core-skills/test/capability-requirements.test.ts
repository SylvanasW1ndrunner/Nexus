import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, skillCapabilityRequirements } from '../src/index.js';

describe('Skill capability requirements', () => {
  it('parses generic comma, whitespace, and JSON-array metadata without assigning semantics', () => {
    expect(
      skillCapabilityRequirements({ capabilities: 'database.query, schema.read mcp' }),
    ).toEqual([
      { capabilityId: 'database.query' },
      { capabilityId: 'schema.read' },
      { capabilityId: 'mcp' },
    ]);
    expect(
      skillCapabilityRequirements({
        capabilities: '["workspace.read", "database.query", "workspace.read"]',
      }),
    ).toEqual([{ capabilityId: 'workspace.read' }, { capabilityId: 'database.query' }]);
  });

  it('rejects malformed JSON metadata instead of silently changing requirements', () => {
    expect(() => skillCapabilityRequirements({ capabilities: '["database.query"' })).toThrow(
      'Invalid Skill capability metadata',
    );
  });

  it('filters catalog, search, load and invocation through one generic resolver', async () => {
    const available = new Set(['generic.available']);
    const registry = new SkillRegistry({
      sessionOverlay: [
        { content: skill('available-skill', 'generic.available', 'AVAILABLE_BODY') },
        { content: skill('unavailable-skill', 'generic.missing', 'UNAVAILABLE_BODY') },
      ],
      capabilityResolver: (requirements) =>
        requirements.every((requirement) => available.has(requirement.capabilityId)),
    });

    expect(registry.catalogForModel().map((entry) => entry.name)).toEqual(['available-skill']);
    expect(registry.search('skill').map((entry) => entry.skill.name)).toEqual(['available-skill']);
    await expect(registry.load('available-skill')).resolves.toMatchObject({
      instructions: 'AVAILABLE_BODY',
    });
    await expect(registry.load('unavailable-skill')).rejects.toThrow(
      'requires unavailable capabilities',
    );
    await expect(registry.invoke('/unavailable-skill')).rejects.toThrow(
      'requires unavailable capabilities',
    );

    available.add('generic.missing');
    expect(registry.catalogForModel().map((entry) => entry.name)).toEqual([
      'available-skill',
      'unavailable-skill',
    ]);
  });

  it('isolates malformed capability metadata during refresh instead of breaking catalog reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'schemanaut-skill-capabilities-'));
    try {
      await writeDiskSkill(root, 'valid-skill', 'database.query');
      await writeDiskSkill(root, 'broken-skill', "'[\"database.query\"'");
      const registry = new SkillRegistry({
        sources: [{ scope: 'project', path: root }],
        capabilityResolver: () => true,
      });

      const result = await registry.refresh();
      expect(result.skills.map(({ name }) => name)).toEqual(['valid-skill']);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe('invalid-frontmatter');
      expect(result.issues[0]?.path).toContain('broken-skill');
      expect(result.issues[0]?.message).toContain('Invalid Skill capability metadata');
      expect(() => registry.list()).not.toThrow();
      expect(() => registry.get('valid-skill')).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates malformed capability metadata in Session overlays before catalog reads', () => {
    const registry = new SkillRegistry({
      sessionOverlay: [
        { content: skill('valid-skill', 'database.query', 'VALID') },
        { content: skill('broken-skill', "'[\"database.query\"'", 'BROKEN') },
      ],
      capabilityResolver: () => true,
    });

    expect(registry.list().map(({ name }) => name)).toEqual(['valid-skill']);
    const issues = registry.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('invalid-frontmatter');
    expect(issues[0]?.path).toContain('broken-skill');
    expect(issues[0]?.message).toContain('Invalid Skill capability metadata');
  });
});

function skill(name: string, capability: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name}`,
    'metadata:',
    `  capabilities: ${capability}`,
    '---',
    body,
  ].join('\n');
}

async function writeDiskSkill(root: string, name: string, capability: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), skill(name, capability, name), 'utf8');
}
