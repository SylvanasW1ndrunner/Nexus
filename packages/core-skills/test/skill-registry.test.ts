import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSkillsFromDirectories, parseSkillDefinition, SkillRegistry } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SkillRegistry', () => {
  it('intersects a Skill allowlist with runtime tools', () => {
    const registry = new SkillRegistry();
    registry.register(
      parseSkillDefinition(
        JSON.stringify({
          name: 'health_check',
          description: '数据库健康检查',
          allowed_tools: ['database_health_snapshot', 'execute_sql'],
          steps: ['检查健康状态'],
        }),
        'imported',
      ),
    );

    expect(registry.filterToolsForSkill('health_check', ['database_health_snapshot'])).toEqual([
      'database_health_snapshot',
    ]);
  });

  it('loads flat manifests and SKILL.md bundles, with later sources overriding earlier ones', async () => {
    const root = await temporaryDirectory();
    const builtins = join(root, 'builtins');
    const imported = join(root, 'imported');
    await mkdir(join(imported, 'health'), { recursive: true });
    await mkdir(builtins, { recursive: true });
    await writeFile(
      join(builtins, 'health.yaml'),
      'name: health\ndescription: 内置健康检查\nallowed_tools: [database_health_snapshot]\n',
      'utf8',
    );
    await writeFile(
      join(imported, 'health', 'SKILL.md'),
      [
        '---',
        'name: health',
        'description: 用户导入的健康检查',
        'allowed_tools: [database_health_snapshot]',
        '---',
        '解释健康指标。',
      ].join('\n'),
      'utf8',
    );

    const result = await loadSkillsFromDirectories([
      { path: builtins, source: 'builtin' },
      { path: imported, source: 'imported' },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: 'health',
      description: '用户导入的健康检查',
      source: 'imported',
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dbagent-skills-'));
  temporaryDirectories.push(path);
  return path;
}
