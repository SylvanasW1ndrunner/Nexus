import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../src/index.js';

const SKILL_COUNT = 240;
let root = '';
let registry: SkillRegistry;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'schemanaut-skills-performance-'));
  await Promise.all(
    Array.from({ length: SKILL_COUNT }, async (_, index) => {
      const name = `scenario-${String(index).padStart(3, '0')}`;
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'SKILL.md'),
        [
          '---',
          `name: ${name}`,
          `description: 处理场景 ${String(index)} 的数据库查询、清洗或科学数据任务。`,
          'metadata:',
          '  author: performance-test',
          '---',
          `# 场景 ${String(index)}`,
          '',
          '正文只在激活时读取。'.repeat(100),
        ].join('\n'),
        'utf8',
      );
    }),
  );
  registry = new SkillRegistry({
    sources: [{ scope: 'project', path: root }],
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Skill catalog performance', () => {
  it('discovers hundreds of metadata entries within an interactive startup budget', async () => {
    const started = performance.now();
    const result = await registry.refresh();
    const elapsedMs = performance.now() - started;

    expect(result.skills).toHaveLength(SKILL_COUNT);
    expect(result.issues).toEqual([]);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('performs repeated catalog searches without loading Skill bodies', () => {
    const started = performance.now();
    for (let index = 0; index < 500; index += 1) {
      registry.search(`场景 ${String(index % SKILL_COUNT)}`, { limit: 5 });
    }
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('creates hundreds of isolated Session views without filesystem rescans', () => {
    const started = performance.now();
    const views = Array.from({ length: 500 }, (_, index) =>
      registry.createSessionView([
        {
          content: [
            '---',
            `name: private-${String(index)}`,
            `description: Session ${String(index)} private workflow.`,
            '---',
            `Only Session ${String(index)} may use this workflow.`,
          ].join('\n'),
        },
      ]),
    );
    const elapsedMs = performance.now() - started;

    expect(views).toHaveLength(500);
    expect(views[0]?.get('private-0')?.scope).toBe('session');
    expect(views[499]?.get('private-499')?.scope).toBe('session');
    expect(registry.get('private-0')).toBeUndefined();
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
